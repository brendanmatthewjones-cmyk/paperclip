import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const { createFileSessionStore } = await import(
  process.env.ACPX_RUNTIME_PATH ?? "../packages/adapter-utils/node_modules/acpx/dist/runtime.js"
);

function syntheticRunJwt(runId) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ run_id: runId, sub: "synthetic" })}.synthetic_signature`;
}

function sessionRecord(token, id = "synthetic-record", lastUsedAt = "2026-01-01T00:00:00.000Z", closed = false) {
  return {
    acpxRecordId: id,
    acpSessionId: "synthetic-session",
    agentCommand: "synthetic-agent",
    cwd: "/synthetic",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt,
    lastSeq: 0,
    closed,
    messages: [],
    updated_at: "2026-01-01T00:00:00.000Z",
    acpx: {
      session_options: {
        model: "synthetic-model",
        env: { PAPERCLIP_API_KEY: token, ALTERNATE_AUTH: token, ORDINARY_FLAG: "kept" },
      },
      alternate_label: { nested: [`prefix ${token} suffix`] },
    },
  };
}

function hasRunJwt(value) {
  return JSON.stringify(value).match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)?.some((candidate) => {
    try {
      return Object.hasOwn(JSON.parse(Buffer.from(candidate.split(".")[1], "base64url")), "run_id");
    } catch {
      return false;
    }
  }) ?? false;
}

test("ACPX disk persistence removes run JWTs at every depth and uses current credentials on resume", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-security-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const oldToken = syntheticRunJwt("old-run");
  const currentToken = syntheticRunJwt("current-run");
  const store = createFileSessionStore({ stateDir, runtimeEnv: { PAPERCLIP_API_KEY: currentToken, ALTERNATE_AUTH: currentToken } });
  const record = sessionRecord(oldToken);
  await store.save(record);
  const persisted = JSON.parse(await readFile(join(stateDir, "sessions", "synthetic-record.json"), "utf8"));
  assert.equal(hasRunJwt(persisted), false);
  assert.equal(persisted.acpx.session_options.model, "synthetic-model");
  assert.equal(persisted.acpx.session_options.env.ORDINARY_FLAG, "kept");
  assert.equal(persisted.acpx.session_options.env.ALTERNATE_AUTH, undefined);
  const resumed = await store.load("synthetic-record");
  assert.equal(resumed.acpx.session_options.env.PAPERCLIP_API_KEY, currentToken);
  assert.equal(resumed.acpx.session_options.env.ALTERNATE_AUTH, currentToken);
  persisted.acpx.session_options.env.PAPERCLIP_API_KEY = oldToken;
  persisted.acpx.session_options.env.ALTERNATE_AUTH = oldToken;
  await writeFile(join(stateDir, "sessions", "synthetic-record.json"), JSON.stringify(persisted));
  const legacyResume = await store.load("synthetic-record");
  assert.equal(legacyResume.acpx.session_options.env.PAPERCLIP_API_KEY, currentToken);
  assert.equal(legacyResume.acpx.session_options.env.ALTERNATE_AUTH, currentToken);
  await store.save(legacyResume);
  assert.equal(hasRunJwt(JSON.parse(await readFile(join(stateDir, "sessions", "synthetic-record.json"), "utf8"))), false);
  const noOptions = JSON.parse(await readFile(join(stateDir, "sessions", "synthetic-record.json"), "utf8"));
  delete noOptions.acpx.session_options;
  await writeFile(join(stateDir, "sessions", "synthetic-record.json"), JSON.stringify(noOptions));
  assert.equal((await store.load("synthetic-record")).acpx.session_options.env.PAPERCLIP_API_KEY, currentToken);
});

test("ACPX retention prunes closed sessions by age and count while preserving active sessions", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-retention-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  await setup.save(sessionRecord("ordinary", "old", "2026-01-01T00:00:00.000Z", true));
  await setup.save(sessionRecord("ordinary", "recent", "2026-01-09T00:00:00.000Z", true));
  await setup.save(sessionRecord("ordinary", "newest", "2026-01-10T00:00:00.000Z", true));
  await setup.save(sessionRecord("ordinary", "active", "2026-01-01T00:00:00.000Z", false));
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 7, maxSessions: 2, scanLimit: 4, deleteLimit: 2 } });
  const result = await store.prune(Date.parse("2026-01-10T12:00:00.000Z"));
  assert.deepEqual(result, { scanned: 4, deleted: 2 });
  assert.equal(await store.load("old"), undefined);
  assert.equal(await store.load("recent"), undefined);
  assert.ok(await store.load("newest"));
  assert.ok(await store.load("active"));
});

test("ACPX pruning concurrent with a save preserves the new active record", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-retention-race-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1, maxSessions: 1, scanLimit: 8, deleteLimit: 8, sweepIntervalMs: 0 } });
  for (let i = 0; i < 20; i++) {
    const id = `race-${i}`;
    await setup.save(sessionRecord("ordinary", id, "2026-01-01T00:00:00.000Z", true));
    await Promise.all([
      store.prune(Date.parse("2026-01-10T00:00:00.000Z")),
      setup.save(sessionRecord("ordinary", id, "2026-01-10T00:00:00.000Z", false)),
    ]);
    assert.equal((await setup.load(id))?.closed, false);
  }
});

test("ACPX retention limits per-sweep reads and deletions", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-retention-bounds-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  for (let i = 0; i < 5; i++) await setup.save(sessionRecord("ordinary", `closed-${i}`, "2026-01-01T00:00:00.000Z", true));
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1, maxSessions: 1, scanLimit: 2, deleteLimit: 1 } });
  assert.deepEqual(await store.prune(Date.parse("2026-01-10T00:00:00.000Z")), { scanned: 2, deleted: 1 });
});


test("ACPX retention shares the deadline and cursor across new stores for one directory", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-retention-multistore-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  for (let i = 0; i < 5; i++) await setup.save(sessionRecord("ordinary", `stale-${i}`, "2026-01-01T00:00:00.000Z", true));
  const retention = { enabled: true, maxAgeDays: 1, maxSessions: 1, scanLimit: 1, deleteLimit: 1 };
  const start = Date.parse("2026-01-10T00:00:00.000Z");
  await writeFile(join(stateDir, "sessions.prune.lock"), JSON.stringify({ pid: 2147483647, nonce: "dead-owner" }));
  const first = createFileSessionStore({ stateDir, retention });
  const concurrent = createFileSessionStore({ stateDir, retention });
  const firstPass = await Promise.all([first.prune(start), concurrent.prune(start)]);
  assert.equal(firstPass.reduce((total, result) => total + result.scanned, 0), 1);
  assert.equal(firstPass.reduce((total, result) => total + result.deleted, 0), 1);
  const fresh = createFileSessionStore({ stateDir, retention });
  assert.deepEqual(await fresh.prune(start + 30_000), { scanned: 0, deleted: 0 });
  assert.deepEqual(await fresh.prune(start + 60_000), { scanned: 1, deleted: 1 });
  for (let i = 2; i < 8; i++) {
    const next = createFileSessionStore({ stateDir, retention });
    await next.prune(start + i * 60_000);
  }
  for (let i = 0; i < 5; i++) assert.equal(await setup.load(`stale-${i}`), undefined);
});
