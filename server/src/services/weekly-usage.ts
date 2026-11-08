import {
  isWeeklyUsageProvider,
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

/** Provider reads are shared across viewers for this long. */
const PROBE_CACHE_MS = 60_000;
/** Agent reads refresh a snapshot older than this. */
const AGENT_REFRESH_MS = 5 * 60_000;
/** Snapshots older than this are reported as stale. */
const STALE_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 4;

type ObservedAccount = { provider: WeeklyUsageProviderId; account: WeeklyUsageAccount };
interface Snapshot { accounts: ObservedAccount[]; observedAt: number; refresherUserId: string }

const probeCache = new Map<string, { expires: number; value: Promise<AiConnectionUsage | null> }>();
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

  function probe(companyId: string, userId: string, connectionId: string, grantId: string) {
    const key = `${companyId}:${userId}:${connectionId}:${grantId}`;
    const cached = probeCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = withTimeout(
      connections.probeUsage(companyId, userId, connectionId, grantId).catch((error: unknown) => {
        logger.warn({ companyId, connectionId, err: error instanceof Error ? error.message : String(error) },
          "Weekly usage probe failed");
        return null;
      }),
      null,
    );
    if (probeCache.size > 1000) probeCache.clear();
    probeCache.set(key, { value, expires: Date.now() + PROBE_CACHE_MS });
    return value;
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
        const usage = connection.status === "connected"
          ? await probe(companyId, userId, connection.id, connection.grantId)
          : null;
        accounts[index] = {
          provider: connection.provider as WeeklyUsageProviderId,
          account: summarizeWeeklyUsageAccount(connection, usage,
            connection.status === "connected" ? "Usage could not be read." : "Reconnect this account to read its usage."),
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
  probeCache.clear();
  snapshots.clear();
  refreshing.clear();
}
