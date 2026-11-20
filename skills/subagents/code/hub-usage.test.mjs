import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CACHE_MS, READ_GAP_MS, applyHub, hubClaudeAccounts, hubInstances, recentReads, usageWindows, withCache } from "./hub-usage.mjs";

test("usage body -> Session, Weekly and per-model weekly windows", () => {
  const w = usageWindows({
    five_hour: null,
    seven_day: { utilization: 12.4, resets_at: "2026-11-23T02:00:00Z" },
    limits: [
      { kind: "weekly_all", percent: 12 },
      { kind: "weekly_scoped", percent: 3, resets_at: "2026-11-23T02:00:00Z", scope: { model: { display_name: "Fable" } } },
    ],
  });
  assert.deepEqual(w, [
    { label: "Weekly", usedPercent: 12, resetsAt: "2026-11-23T02:00:00Z" },
    { label: "Weekly · Fable", usedPercent: 3, resetsAt: "2026-11-23T02:00:00Z" },
  ]);
  assert.deepEqual(usageWindows({ five_hour: { utilization: 40, resets_at: null } }), [{ label: "Session", usedPercent: 40, resetsAt: null }]);
});

test("hub instances: homes whose settings point ANTHROPIC_BASE_URL at the hub", () => {
  const files = {
    "/h/a/settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9000/" } }),
    "/h/b/settings.json": JSON.stringify({ env: {} }),
    "/h/c/settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9000/v1" } }),
  };
  const read = (f) => { if (!(f in files)) throw new Error("ENOENT"); return files[f]; };
  const got = hubInstances({ alpha: "/h/a", beta: "/h/b", gamma: "/h/c", delta: "/h/missing" }, "http://127.0.0.1:9000", read);
  assert.deepEqual(got, ["alpha", "gamma"]);
});

test("hub accounts: primary first by priority; a failed read keeps the row without windows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-usage-"));
  fs.writeFileSync(path.join(dir, "mgmt.key"), "k\n");
  const usage = {
    i1: { status_code: 200, body: JSON.stringify({ five_hour: { utilization: 30, resets_at: null }, seven_day: { utilization: 50, resets_at: null } }) },
    i2: { status_code: 200, body: JSON.stringify({ seven_day: { utilization: 2, resets_at: null } }) },
    i3: { status_code: 401, body: "{}" },
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    const json = url.endsWith("/auth-files")
      ? { files: [
        { auth_index: "i1", provider: "claude", email: "small@example.com" },
        { auth_index: "i2", provider: "claude", email: "big@example.com", priority: 10 },
        { auth_index: "i3", provider: "claude", email: "broken@example.com" },
        { auth_index: "i4", provider: "codex", email: "codex@example.com" },
        { auth_index: "i5", provider: "claude", email: "off@example.com", disabled: true },
      ] }
      : usage[JSON.parse(init.body).auth_index];
    return { ok: true, json: async () => json };
  };
  const rows = await hubClaudeAccounts({ url: "http://hub.test/", managementKeyFile: path.join(dir, "mgmt.key") }, fetchImpl);
  assert.deepEqual(rows.map((r) => r.email), ["big@example.com", "small@example.com", "broken@example.com"]);
  assert.equal(rows[0].windows[0].usedPercent, 2);
  assert.match(rows[2].error, /HTTP 401/);
  assert.ok(calls.every((c) => c.url.startsWith("http://hub.test/v0/management/") && c.auth === "Bearer k"));
  // A login read recently is skipped: no usage call for it.
  calls.length = 0;
  const again = await hubClaudeAccounts({ url: "http://hub.test/", managementKeyFile: path.join(dir, "mgmt.key") }, fetchImpl, (email) => email === "big@example.com");
  assert.deepEqual([again[0].email, again[0].skipped, again[0].windows], ["big@example.com", true, []]);
  assert.equal(calls.filter((c) => c.url.endsWith("/api-call")).length, 2);
});

test("applyHub: hub instances get the primary login's windows, replacing any stale row", () => {
  const accounts = [{ instance: "lane2", plan: "old", windows: [{ label: "Weekly", usedPercent: 99 }] }];
  const rows = [
    { email: "big@example.com", priority: 10, windows: [{ label: "Weekly", usedPercent: 2, resetsAt: null }] },
    { email: "small@example.com", priority: 0, windows: [{ label: "Session", usedPercent: 30, resetsAt: null }] },
  ];
  applyHub(accounts, rows, ["lane2", "lane2_workers"], "2026-11-20T00:00:00Z");
  const by = Object.fromEntries(accounts.map((a) => [a.instance, a]));
  assert.equal(by.lane2.windows[0].usedPercent, 2);
  assert.equal(by.lane2_workers.windows[0].usedPercent, 2);
  assert.equal(by["hub:small@example.com"].windows[0].usedPercent, 30);
  assert.match(by["hub:big@example.com"].plan, /primary/);
});

test("applyHub: no readable login leaves the instances alone", () => {
  const accounts = [{ instance: "lane2", windows: [{ label: "Weekly", usedPercent: 5 }] }];
  applyHub(accounts, [{ email: "x@example.com", windows: [], error: "down" }], ["lane2"]);
  assert.deepEqual(accounts, [{ instance: "lane2", windows: [{ label: "Weekly", usedPercent: 5 }] }]);
});

test("withCache: a failed read (429) keeps the login's last good windows for 30 min, marked cachedAt", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hub-cache-")), "nested", "hub-usage.json");
  const now = Date.parse("2026-11-20T22:00:00Z");
  const good = [{ label: "Weekly", usedPercent: 3, resetsAt: "2026-11-23T02:00:00Z" }];
  const first = withCache([{ email: "a@x", windows: good }, { email: "b@x", windows: [], error: "usage: HTTP 429" }], file, now);
  assert.deepEqual(first.map((r) => [r.email, r.windows.length, r.cachedAt ?? null]), [["a@x", 1, null], ["b@x", 0, null]], "nothing cached for b yet");
  const later = withCache([{ email: "a@x", windows: [], error: "usage: HTTP 429" }], file, now + CACHE_MS - 60000);
  assert.deepEqual(later[0].windows, good);
  assert.equal(later[0].cachedAt, new Date(now).toISOString());
  assert.equal(later[0].error, "usage: HTTP 429");
  const stale = withCache([{ email: "a@x", windows: [], error: "usage: HTTP 429" }], file, now + CACHE_MS + 60000);
  assert.deepEqual(stale[0].windows, [], "older than 30 min: dropped");
  // A bad cache file is ignored, not fatal.
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(withCache([{ email: "a@x", windows: [] }], file, now)[0].windows, []);
});

test("recentReads: a login read under 4 min ago is skipped, and withCache fills it from the cache", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hub-cache-")), "hub-usage.json");
  const now = Date.parse("2026-11-20T22:00:00Z");
  const good = [{ label: "Weekly", usedPercent: 3, resetsAt: "2026-11-23T02:00:00Z" }];
  withCache([{ email: "a@x", windows: good }], file, now);
  assert.equal(recentReads(file, now + READ_GAP_MS - 1000)("a@x"), true);
  assert.equal(recentReads(file, now + READ_GAP_MS + 1000)("a@x"), false);
  assert.equal(recentReads(file, now)("b@x"), false, "never read");
  const filled = withCache([{ email: "a@x", windows: [], skipped: true }], file, now + 60000);
  assert.deepEqual(filled[0].windows, good);
});
