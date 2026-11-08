import type { AiConnectionUsage, AiConnectionUsageLimit } from "./ai-connection-usage.js";
import type { AiManagedConnectionSummary, AiProvider } from "./ai-connections.js";

/**
 * Providers shown on the dashboard's weekly usage gauges. Each one reports a
 * provider-observed allowance; none of these numbers are estimated from
 * Paperclip's own run costs.
 */
export const WEEKLY_USAGE_PROVIDERS = ["anthropic", "openai", "xai"] as const satisfies readonly AiProvider[];
export type WeeklyUsageProviderId = (typeof WEEKLY_USAGE_PROVIDERS)[number];

export const WEEKLY_USAGE_PROVIDER_LABELS: Record<WeeklyUsageProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
};

/** Percent-used thresholds shared by the gauges and the agent-facing level. */
export const WEEKLY_USAGE_THRESHOLDS = { warning: 70, critical: 90 } as const;

const WEEK_SECONDS = 7 * 24 * 60 * 60;

/**
 * - `ok`: below the warning threshold.
 * - `warning`: at or above 70% used. Prefer lighter work.
 * - `critical`: at or above 90% used, or the provider says the limit is reached.
 * - `unknown`: no account connected, or the provider could not be read.
 */
export type WeeklyUsageLevel = "ok" | "warning" | "critical" | "unknown";

/**
 * `weekly` is a rolling seven-day allowance (Claude and Codex subscriptions).
 * `billing_period` is used when the provider only reports a plan period, as
 * Grok (xAI) does; the gauge then shows that period instead of a week.
 */
export type WeeklyUsageWindowKind = "weekly" | "billing_period";

export interface WeeklyUsageAccount {
  connectionId: string;
  grantId: string;
  name: string;
  usedPercent: number | null;
  resetsAt: string | null;
  windowKind: WeeklyUsageWindowKind | null;
  level: WeeklyUsageLevel;
  checkedAt: string | null;
  message: string | null;
}

export interface WeeklyUsageProvider {
  provider: WeeklyUsageProviderId;
  label: string;
  /** Percent of the window used on the most-used connected account. */
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  windowKind: WeeklyUsageWindowKind | null;
  level: WeeklyUsageLevel;
  /** Number of connected accounts for this provider that support usage checks. */
  accountCount: number;
  checkedAt: string | null;
  /** Plain-language status, always set so agents can quote it directly. */
  summary: string;
  /** Present for board users only; omitted from the agent view. */
  accounts?: WeeklyUsageAccount[];
}

export interface WeeklyUsageReport {
  companyId: string;
  /** When this response was produced. */
  generatedAt: string;
  /** When the provider values were last read. Null when never read. */
  observedAt: string | null;
  /** True when the provider values are older than the freshness window. */
  stale: boolean;
  thresholds: typeof WEEKLY_USAGE_THRESHOLDS;
  providers: WeeklyUsageProvider[];
}

export function isWeeklyUsageProvider(provider: string): provider is WeeklyUsageProviderId {
  return (WEEKLY_USAGE_PROVIDERS as readonly string[]).includes(provider);
}

export function weeklyUsageLevel(usedPercent: number | null, limitReached?: boolean | null): WeeklyUsageLevel {
  if (limitReached === true) return "critical";
  if (usedPercent == null) return "unknown";
  if (usedPercent >= WEEKLY_USAGE_THRESHOLDS.critical) return "critical";
  if (usedPercent >= WEEKLY_USAGE_THRESHOLDS.warning) return "warning";
  return "ok";
}

function isWeekly(limit: AiConnectionUsageLimit): boolean {
  return limit.windowDurationSeconds === WEEK_SECONDS || limit.resetInterval === "weekly";
}

function hasReading(limit: AiConnectionUsageLimit): boolean {
  return limit.usedPercent != null || limit.limitReached != null;
}

function mostUsed(limits: AiConnectionUsageLimit[]): AiConnectionUsageLimit | null {
  return limits.reduce<AiConnectionUsageLimit | null>((best, entry) =>
    best == null || (entry.usedPercent ?? -1) > (best.usedPercent ?? -1) ? entry : best, null);
}

/**
 * Picks the one allowance that best answers "how much of this week is used".
 * The account-wide weekly window wins over model-scoped ones (Sonnet/Opus
 * only), because the account-wide window is the one that stops all work.
 * Providers without a weekly window fall back to their plan period.
 */
export function selectWeeklyLimit(
  usage: Pick<AiConnectionUsage, "limits">,
): { limit: AiConnectionUsageLimit; windowKind: WeeklyUsageWindowKind } | null {
  const readable = usage.limits.filter((entry) => entry.scope !== "overage" && hasReading(entry));
  const weekly = readable.filter(isWeekly);
  const accountWide = mostUsed(weekly.filter((entry) => entry.scope == null));
  if (accountWide) return { limit: accountWide, windowKind: "weekly" };
  const scoped = mostUsed(weekly);
  if (scoped) return { limit: scoped, windowKind: "weekly" };
  const period = mostUsed(readable.filter((entry) => (entry.windowDurationSeconds ?? 0) > WEEK_SECONDS));
  if (period) return { limit: period, windowKind: "billing_period" };
  return null;
}

function roundPercent(value: number | null): number | null {
  return value == null ? null : Math.round(Math.max(0, value) * 10) / 10;
}

export function summarizeWeeklyUsageAccount(
  connection: Pick<AiManagedConnectionSummary, "id" | "grantId" | "name">,
  usage: AiConnectionUsage | null,
  fallbackMessage = "Usage could not be read.",
): WeeklyUsageAccount {
  const base = {
    connectionId: connection.id, grantId: connection.grantId, name: connection.name,
    checkedAt: usage?.checkedAt ?? null,
  };
  if (!usage || usage.status !== "ok") {
    return { ...base, usedPercent: null, resetsAt: null, windowKind: null, level: "unknown",
      message: usage?.message ?? fallbackMessage };
  }
  const selected = selectWeeklyLimit(usage);
  if (!selected) {
    return { ...base, usedPercent: null, resetsAt: null, windowKind: null, level: "unknown",
      message: "The provider did not report a weekly allowance." };
  }
  const usedPercent = roundPercent(selected.limit.usedPercent);
  return {
    ...base, usedPercent, resetsAt: selected.limit.resetsAt, windowKind: selected.windowKind,
    level: weeklyUsageLevel(usedPercent, selected.limit.limitReached), message: null,
  };
}

const LEVEL_RANK: Record<WeeklyUsageLevel, number> = { unknown: 0, ok: 1, warning: 2, critical: 3 };

function describe(provider: Omit<WeeklyUsageProvider, "summary">): string {
  if (provider.accountCount === 0) return `No ${provider.label} subscription is connected.`;
  if (provider.usedPercent == null && provider.level !== "critical") {
    return `${provider.label} usage could not be read.`;
  }
  const window = provider.windowKind === "billing_period" ? "of the current billing period" : "of the weekly limit";
  const used = provider.usedPercent == null ? "Limit reached" : `${Math.round(provider.usedPercent)}% ${window} used`;
  const resets = provider.resetsAt ? `, resets ${provider.resetsAt}` : "";
  const advice = provider.level === "critical" ? ". Avoid new work on this provider until it resets."
    : provider.level === "warning" ? ". Prefer lighter work on this provider." : ".";
  return `${used}${resets}${advice}`;
}

/**
 * Collapses each provider to one gauge. With several accounts for the same
 * provider, the gauge shows the most-used one, so a warning is never hidden
 * behind an emptier account.
 */
export function summarizeWeeklyUsage(input: {
  companyId: string;
  accounts: Array<{ provider: WeeklyUsageProviderId; account: WeeklyUsageAccount }>;
  generatedAt: string;
  observedAt: string | null;
  stale: boolean;
  includeAccounts: boolean;
}): WeeklyUsageReport {
  const providers = WEEKLY_USAGE_PROVIDERS.map((provider): WeeklyUsageProvider => {
    const accounts = input.accounts.filter((entry) => entry.provider === provider).map((entry) => entry.account);
    const worst = accounts.reduce<WeeklyUsageAccount | null>((best, account) => {
      if (!best) return account;
      const rank = LEVEL_RANK[account.level] - LEVEL_RANK[best.level];
      if (rank !== 0) return rank > 0 ? account : best;
      return (account.usedPercent ?? -1) > (best.usedPercent ?? -1) ? account : best;
    }, null);
    const checked = accounts.map((account) => account.checkedAt).filter((value): value is string => value != null).sort();
    const gauge: Omit<WeeklyUsageProvider, "summary"> = {
      provider,
      label: WEEKLY_USAGE_PROVIDER_LABELS[provider],
      usedPercent: worst?.usedPercent ?? null,
      remainingPercent: worst?.usedPercent == null ? null : Math.max(0, roundPercent(100 - worst.usedPercent)!),
      resetsAt: worst?.resetsAt ?? null,
      windowKind: worst?.windowKind ?? null,
      level: worst?.level ?? "unknown",
      accountCount: accounts.length,
      checkedAt: checked.at(-1) ?? null,
    };
    return {
      ...gauge,
      summary: describe(gauge),
      ...(input.includeAccounts ? { accounts } : {}),
    };
  });
  return {
    companyId: input.companyId,
    generatedAt: input.generatedAt,
    observedAt: input.observedAt,
    stale: input.stale,
    thresholds: WEEKLY_USAGE_THRESHOLDS,
    providers,
  };
}
