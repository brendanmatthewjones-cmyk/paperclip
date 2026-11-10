import {
  isWeeklyUsageProvider,
  WEEKLY_USAGE_PROVIDER_LABELS,
  summarizeWeeklyUsage,
  summarizeWeeklyUsageAccount,
  supportsAiConnectionUsage,
  type AiConnectionUsage,
  type WeeklyUsageAccount,
  type WeeklyUsageProviderId,
  type WeeklyUsageReport,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { aiConnectionService } from "./ai-connections.js";

/** A successful provider read is reused for this long. Weekly numbers move slowly. */
const FRESH_MS = 5 * 60_000;
/** A failed read is not retried for this long, so errors cannot cause a request storm. */
const FAILURE_RETRY_MS = 60_000;
/** Back-off after the provider says "too many requests": doubles from the first value up to the cap. */
const RATE_LIMIT_BACKOFF_MS = { first: 5 * 60_000, max: 60 * 60_000 };
/** Agent reads refresh a snapshot older than this. */
const AGENT_REFRESH_MS = 5 * 60_000;
/** Snapshots older than this are reported as stale. */
const STALE_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 4;

type ObservedAccount = { provider: WeeklyUsageProviderId; account: WeeklyUsageAccount };
interface Snapshot { accounts: ObservedAccount[]; observedAt: number; refresherUserId: string }

/** Failures that say nothing about the account itself; the last good reading still stands. */
const TRANSIENT_ERRORS = new Set(["rate_limited", "provider_unavailable", "invalid_response"]);

interface ProbeState {
  /** Latest result and how long it may be reused. */
  latest?: { usage: AiConnectionUsage | null; reuseUntil: number };
  /** Most recent successful reading, kept so a transient failure does not blank the gauge. */
  lastGood?: AiConnectionUsage;
  backoffMs?: number;
  inFlight?: Promise<void>;
}
export interface ProbeOutcome { usage: AiConnectionUsage | null; note: string | null }

/** One state per account (connection + grant), shared by every viewer who can see it. */
const probeStates = new Map<string, ProbeState>();
/** Latest board observation per company. Process-local; rebuilt after restart. */
const snapshots = new Map<string, Snapshot>();
const refreshing = new Map<string, Promise<Snapshot>>();

function withTimeout<T>(task: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

export function weeklyUsageService(db: Db) {
  const connections = aiConnectionService(db);

  async function probe(companyId: string, userId: string, connection: { id: string; grantId: string; provider: string }): Promise<ProbeOutcome> {
    // list() already limited `connection` to grants this viewer may use, and
    // probeUsage re-checks that access, so viewers can share one result.
    const key = `${companyId}:${connection.id}:${connection.grantId}`;
    let state = probeStates.get(key);
    if (!state) {
      if (probeStates.size > 1000) probeStates.clear();
      state = {};
      probeStates.set(key, state);
    }
    if (!state.latest || state.latest.reuseUntil <= Date.now()) {
      state.inFlight ??= (async () => {
        const usage = await withTimeout(
          connections.probeUsage(companyId, userId, connection.id, connection.grantId).catch((error: unknown) => {
            logger.warn({ companyId, connectionId: connection.id, err: error instanceof Error ? error.message : String(error) },
              "Weekly usage probe failed");
            return null;
          }),
          null,
        );
        const now = Date.now();
        if (usage?.status === "ok") {
          state.lastGood = usage;
          state.backoffMs = undefined;
          state.latest = { usage, reuseUntil: now + FRESH_MS };
        } else if (usage?.errorCode === "rate_limited") {
          state.backoffMs = Math.min(RATE_LIMIT_BACKOFF_MS.max,
            state.backoffMs ? state.backoffMs * 2 : RATE_LIMIT_BACKOFF_MS.first);
          state.latest = { usage, reuseUntil: now + state.backoffMs };
          logger.info({ companyId, connectionId: connection.id, retryInMs: state.backoffMs },
            "Provider rate limited the weekly usage check; backing off");
        } else {
          state.latest = { usage, reuseUntil: now + FAILURE_RETRY_MS };
        }
      })().finally(() => { state.inFlight = undefined; });
    }
    await state.inFlight;
    const usage = state.latest?.usage ?? null;
    const transient = usage == null || (usage.status !== "ok" && TRANSIENT_ERRORS.has(usage.errorCode ?? ""));
    if (transient && state.lastGood) {
      const label = isWeeklyUsageProvider(connection.provider) ? WEEKLY_USAGE_PROVIDER_LABELS[connection.provider] : "The provider";
      const reason = usage?.errorCode === "rate_limited" ? `${label} is limiting how often usage can be checked`
        : `${label} usage could not be checked just now`;
      return { usage: state.lastGood, note: `${reason}; showing the last reading.` };
    }
    return { usage, note: null };
  }

  async function observe(companyId: string, userId: string): Promise<Snapshot> {
    const visible = (await connections.list(companyId, userId)).filter((connection) =>
      isWeeklyUsageProvider(connection.provider) && supportsAiConnectionUsage(connection.provider, connection.method));
    const accounts: ObservedAccount[] = new Array(visible.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, visible.length) }, async () => {
      while (next < visible.length) {
        const index = next++;
        const connection = visible[index]!;
        const outcome = connection.status === "connected"
          ? await probe(companyId, userId, connection)
          : { usage: null, note: null };
        const account = summarizeWeeklyUsageAccount(connection, outcome.usage,
          connection.status === "connected" ? "Usage could not be read." : "Reconnect this account to read its usage.");
        accounts[index] = {
          provider: connection.provider as WeeklyUsageProviderId,
          account: outcome.note ? { ...account, message: outcome.note } : account,
        };
      }
    }));
    const snapshot = { accounts, observedAt: Date.now(), refresherUserId: userId };
    snapshots.set(companyId, snapshot);
    return snapshot;
  }

  function report(companyId: string, snapshot: Snapshot | undefined, includeAccounts: boolean): WeeklyUsageReport {
    return summarizeWeeklyUsage({
      companyId,
      accounts: snapshot?.accounts ?? [],
      generatedAt: new Date().toISOString(),
      observedAt: snapshot ? new Date(snapshot.observedAt).toISOString() : null,
      stale: !snapshot || Date.now() - snapshot.observedAt > STALE_MS,
      includeAccounts,
    });
  }

  return {
    /** Board view: reads providers with the viewer's own grants and includes per-account rows. */
    async forBoard(companyId: string, userId: string): Promise<WeeklyUsageReport> {
      return report(companyId, await observe(companyId, userId), true);
    },

    /**
     * Agent view: provider-level gauges only, without account names or IDs.
     * Agents hold no personal grants, so a stale snapshot is refreshed with the
     * grants of the board user who last observed it. probeUsage re-checks that
     * user's membership and grant access on every read.
     */
    async forAgent(companyId: string): Promise<WeeklyUsageReport> {
      let snapshot = snapshots.get(companyId);
      if (snapshot && Date.now() - snapshot.observedAt > AGENT_REFRESH_MS) {
        let pending = refreshing.get(companyId);
        if (!pending) {
          pending = observe(companyId, snapshot.refresherUserId)
            .finally(() => refreshing.delete(companyId));
          refreshing.set(companyId, pending);
        }
        snapshot = await pending.catch((error: unknown) => {
          logger.warn({ companyId, err: error instanceof Error ? error.message : String(error) },
            "Weekly usage refresh failed");
          return snapshot;
        });
      }
      return report(companyId, snapshot, false);
    },
  };
}

/** Test hook: clears process-local caches. */
export function resetWeeklyUsageCachesForTests() {
  probeStates.clear();
  snapshots.clear();
  refreshing.clear();
}
