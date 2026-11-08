import { describe, expect, it } from "vitest";
import type { AiConnectionUsage, AiConnectionUsageLimit } from "./ai-connection-usage.js";
import {
  selectWeeklyLimit,
  summarizeWeeklyUsage,
  summarizeWeeklyUsageAccount,
  weeklyUsageLevel,
} from "./weekly-usage.js";

function limit(input: Partial<AiConnectionUsageLimit> & Pick<AiConnectionUsageLimit, "id">): AiConnectionUsageLimit {
  return {
    label: input.id, scope: null, windowDurationSeconds: null, resetsAt: null, usedPercent: null,
    remainingPercent: null, used: null, limit: null, remaining: null, unit: "percent",
    limitReached: null, allowed: null, ...input,
  };
}

function usage(provider: AiConnectionUsage["provider"], limits: AiConnectionUsageLimit[]): AiConnectionUsage {
  return {
    connectionId: "c1", grantId: "g1", provider, method: "subscription", status: "ok",
    checkedAt: "2026-11-08T12:00:00.000Z", source: null, planType: null, limits, overage: null,
  };
}

const connection = { id: "c1", grantId: "g1", name: "Main" };

describe("weekly usage", () => {
  it("prefers the account-wide weekly window over session and model windows (Claude)", () => {
    const selected = selectWeeklyLimit(usage("anthropic", [
      limit({ id: "five_hour", windowDurationSeconds: 18000, usedPercent: 95 }),
      limit({ id: "seven_day", windowDurationSeconds: 604800, usedPercent: 40, resetsAt: "2026-11-12T00:00:00.000Z" }),
      limit({ id: "seven_day_opus", scope: "seven_day_opus", windowDurationSeconds: 604800, usedPercent: 80 }),
      limit({ id: "extra_usage", scope: "overage", usedPercent: 99 }),
    ]));
    expect(selected?.limit.id).toBe("seven_day");
    expect(selected?.windowKind).toBe("weekly");
  });

  it("uses the Codex secondary window, which is the weekly one", () => {
    const selected = selectWeeklyLimit(usage("openai", [
      limit({ id: "codex.primary_window", windowDurationSeconds: 18000, usedPercent: 12 }),
      limit({ id: "codex.secondary_window", windowDurationSeconds: 604800, usedPercent: 73 }),
    ]));
    expect(selected?.limit.id).toBe("codex.secondary_window");
  });

  it("falls back to the billing period when xAI reports no weekly window", () => {
    const selected = selectWeeklyLimit(usage("xai", [
      limit({ id: "grok_credits", windowDurationSeconds: 30 * 86400, usedPercent: 22, unit: "cents" }),
      limit({ id: "grok_overage", scope: "overage", used: 5, limit: 10, unit: "cents" }),
    ]));
    expect(selected?.limit.id).toBe("grok_credits");
    expect(selected?.windowKind).toBe("billing_period");
  });

  it("maps percentages and explicit limit-reached flags to levels", () => {
    expect(weeklyUsageLevel(null)).toBe("unknown");
    expect(weeklyUsageLevel(69.9)).toBe("ok");
    expect(weeklyUsageLevel(70)).toBe("warning");
    expect(weeklyUsageLevel(90)).toBe("critical");
    expect(weeklyUsageLevel(10, true)).toBe("critical");
  });

  it("reports failed probes as unknown with the provider message", () => {
    const account = summarizeWeeklyUsageAccount(connection, {
      ...usage("anthropic", []), status: "unavailable", message: "Reconnect the account.",
    });
    expect(account.level).toBe("unknown");
    expect(account.message).toBe("Reconnect the account.");
  });

  it("builds one gauge per provider, showing the busiest account, and hides accounts from agents", () => {
    const light = summarizeWeeklyUsageAccount(connection, usage("anthropic", [
      limit({ id: "seven_day", windowDurationSeconds: 604800, usedPercent: 20 }),
    ]));
    const heavy = summarizeWeeklyUsageAccount({ ...connection, id: "c2" }, usage("anthropic", [
      limit({ id: "seven_day", windowDurationSeconds: 604800, usedPercent: 91.26, resetsAt: "2026-11-10T00:00:00.000Z" }),
    ]));
    const input = {
      companyId: "co", generatedAt: "2026-11-08T12:00:00.000Z", observedAt: "2026-11-08T12:00:00.000Z", stale: false,
      accounts: [{ provider: "anthropic" as const, account: light }, { provider: "anthropic" as const, account: heavy }],
    };
    const report = summarizeWeeklyUsage({ ...input, includeAccounts: true });
    expect(report.providers.map((p) => p.provider)).toEqual(["anthropic", "openai", "xai"]);
    const anthropic = report.providers[0]!;
    expect(anthropic).toMatchObject({ usedPercent: 91.3, remainingPercent: 8.7, level: "critical", accountCount: 2 });
    expect(anthropic.summary).toContain("91% of the weekly limit used");
    expect(anthropic.accounts).toHaveLength(2);
    expect(report.providers[1]).toMatchObject({ level: "unknown", accountCount: 0, summary: "No OpenAI subscription is connected." });

    const agentView = summarizeWeeklyUsage({ ...input, includeAccounts: false });
    expect(agentView.providers[0]).not.toHaveProperty("accounts");
    expect(JSON.stringify(agentView)).not.toContain("Main");
  });
});
