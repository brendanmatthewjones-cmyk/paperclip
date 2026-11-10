import { useQuery } from "@tanstack/react-query";
import type { WeeklyUsageLevel, WeeklyUsageProvider } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

const REFRESH_MS = 5 * 60_000;

const LEVEL_STROKE: Record<WeeklyUsageLevel, string> = {
  ok: "stroke-(--status-task-done)",
  warning: "stroke-(--status-task-todo)",
  critical: "stroke-(--status-task-blocked)",
  unknown: "stroke-transparent",
};

const LEVEL_TEXT: Record<WeeklyUsageLevel, string> = {
  ok: "Plenty left",
  warning: "Running low",
  critical: "Nearly out",
  unknown: "Unavailable",
};

const LEVEL_DOT: Record<WeeklyUsageLevel, string> = {
  ok: "bg-(--status-task-done)",
  warning: "bg-(--status-task-todo)",
  critical: "bg-(--status-task-blocked)",
  unknown: "bg-muted-foreground/40",
};

/** "in 2d 5h", "in 3h 10m", "soon". */
export function formatResetsIn(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 60_000) return "soon";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

/** Half-circle gauge. pathLength=100 lets the dash array be the percentage. */
function Gauge({ percent, level, label }: { percent: number | null; level: WeeklyUsageLevel; label: string }) {
  const value = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  const arc = "M 10 60 A 50 50 0 0 1 110 60";
  return (
    <svg
      viewBox="0 0 120 66"
      className="w-full max-w-48"
      role="meter"
      aria-label={`${label} weekly usage`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent == null ? undefined : Math.round(value)}
      aria-valuetext={percent == null ? "Unavailable" : `${Math.round(value)}% used`}
    >
      <path d={arc} pathLength={100} fill="none" strokeWidth={10} strokeLinecap="round" className="stroke-muted" />
      {percent != null && value > 0 && (
        <path
          d={arc}
          pathLength={100}
          fill="none"
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${value} 100`}
          className={cn(LEVEL_STROKE[level], "transition-all duration-500")}
        />
      )}
    </svg>
  );
}

function ProviderGauge({ provider }: { provider: WeeklyUsageProvider }) {
  const connected = provider.accountCount > 0;
  const resets = formatResetsIn(provider.resetsAt);
  const windowName = provider.windowKind === "billing_period" ? "this billing period" : "this week";
  // The account behind the gauge explains a missing or older-than-usual reading.
  const note = provider.accounts?.find((account) => account.message);
  return (
    <div className="flex flex-col items-center text-center gap-1" data-testid={`weekly-usage-${provider.provider}`}>
      <div className="relative w-full flex justify-center">
        <Gauge percent={provider.usedPercent} level={provider.level} label={provider.label} />
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
          <span className="text-2xl font-semibold tabular-nums leading-none">
            {provider.usedPercent == null ? "—" : `${Math.round(provider.usedPercent)}%`}
          </span>
          <span className="text-(length:--text-nano) text-muted-foreground mt-1">
            {provider.usedPercent == null ? (connected ? "no reading" : "not connected") : `used ${windowName}`}
          </span>
        </div>
      </div>
      <p className="text-sm font-medium mt-1">{provider.label}</p>
      {connected ? (
        <>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("inline-block size-2 rounded-full", LEVEL_DOT[provider.level])} aria-hidden />
            {LEVEL_TEXT[provider.level]}
            {resets ? ` · resets ${resets}` : ""}
          </p>
          {note && (
            <p className="text-(length:--text-nano) text-muted-foreground/70">
              {note.message}
              {provider.usedPercent != null && note.checkedAt ? ` Read ${timeAgo(note.checkedAt)}.` : ""}
            </p>
          )}
          {provider.accountCount > 1 && (
            <p className="text-(length:--text-nano) text-muted-foreground/70">
              Busiest of {provider.accountCount} accounts
            </p>
          )}
        </>
      ) : (
        <Link to="/company/settings/connections" className="text-xs text-muted-foreground underline underline-offset-2">
          Connect a subscription
        </Link>
      )}
    </div>
  );
}

export function WeeklyUsageGauges({ companyId }: { companyId: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.weeklyUsage(companyId),
    queryFn: () => costsApi.weeklyUsage(companyId),
    refetchInterval: REFRESH_MS,
    staleTime: 60_000,
  });

  return (
    <section className="border border-border rounded-lg p-4 space-y-3" aria-labelledby="weekly-usage-title">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h3 id="weekly-usage-title" className="text-xs font-medium text-muted-foreground">Weekly AI usage</h3>
          <span className="text-(length:--text-nano) text-muted-foreground/60">Subscription limits reported by each provider</span>
        </div>
        {data?.observedAt && (
          <span className="text-(length:--text-nano) text-muted-foreground/60">Checked {timeAgo(data.observedAt)}</span>
        )}
      </div>
      {error ? (
        <p className="text-sm text-destructive">
          Couldn&apos;t load weekly usage: {error instanceof Error ? error.message : "unknown error"}
        </p>
      ) : isLoading || !data ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-busy>
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-32 rounded-md bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {data.providers.map((provider) => (
            <ProviderGauge key={provider.provider} provider={provider} />
          ))}
        </div>
      )}
    </section>
  );
}
