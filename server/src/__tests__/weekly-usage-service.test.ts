import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({ list: vi.fn(), probeUsage: vi.fn() }));
vi.mock("../services/ai-connections.js", () => ({
  aiConnectionService: () => ({ list: mocks.list, probeUsage: mocks.probeUsage }),
}));
import { resetWeeklyUsageCachesForTests, weeklyUsageService } from "../services/weekly-usage.js";

const db = {} as Db;
const connection = (id: string, provider: string, method = "subscription", status = "connected") =>
  ({ id, grantId: `${id}-grant`, provider, method, status, name: `${id} account` });
const weekly = (usedPercent: number) => ({
  status: "ok", checkedAt: new Date().toISOString(), limits: [{
    id: "seven_day", label: "Weekly limit", scope: null, windowDurationSeconds: 604800,
    resetsAt: "2026-11-12T00:00:00.000Z", usedPercent, remainingPercent: 100 - usedPercent,
    used: null, limit: null, remaining: null, unit: "percent", limitReached: null, allowed: null,
  }], overage: null,
});

describe("weekly usage service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWeeklyUsageCachesForTests();
    mocks.list.mockResolvedValue([
      connection("claude", "anthropic"),
      connection("codex", "openai"),
      connection("openai-key", "openai", "api_key"),
      connection("gemini", "google"),
    ]);
    mocks.probeUsage.mockImplementation(async (_c: string, _u: string, id: string) =>
      id === "claude" ? weekly(75) : weekly(10));
  });
  afterEach(() => vi.useRealTimers());

  it("probes only subscription accounts for the three providers and returns account rows to the board", async () => {
    const report = await weeklyUsageService(db).forBoard("company-1", "user-1");
    expect(mocks.probeUsage.mock.calls.map((call) => call[2]).sort()).toEqual(["claude", "codex"]);
    expect(report.providers.map((p) => [p.provider, p.usedPercent, p.level, p.accountCount])).toEqual([
      ["anthropic", 75, "warning", 1],
      ["openai", 10, "ok", 1],
      ["xai", null, "unknown", 0],
    ]);
    expect(report.providers[0]!.accounts?.[0]?.name).toBe("claude account");
    expect(report.stale).toBe(false);
  });

  it("gives agents provider gauges without account details, and an empty stale report before any board read", async () => {
    const service = weeklyUsageService(db);
    const empty = await service.forAgent("company-2");
    expect(empty).toMatchObject({ observedAt: null, stale: true });
    expect(empty.providers.every((p) => p.level === "unknown")).toBe(true);

    await service.forBoard("company-2", "user-1");
    const agent = await service.forAgent("company-2");
    expect(agent.providers[0]).toMatchObject({ provider: "anthropic", usedPercent: 75, level: "warning" });
    expect(agent.providers[0]).not.toHaveProperty("accounts");
    expect(JSON.stringify(agent)).not.toMatch(/claude account|claude-grant/);
  });

  it("refreshes an old snapshot for agents using the last board viewer's access", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const service = weeklyUsageService(db);
    await service.forBoard("company-3", "user-9");
    mocks.probeUsage.mockImplementation(async () => weekly(95));
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const agent = await service.forAgent("company-3");
    expect(mocks.list).toHaveBeenLastCalledWith("company-3", "user-9");
    expect(agent.providers[0]).toMatchObject({ usedPercent: 95, level: "critical" });
  });
});
