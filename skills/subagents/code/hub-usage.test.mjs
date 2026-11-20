import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyHub, hubClaudeAccounts, hubInstances, usageWindows } from "./hub-usage.mjs";

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
