import "./testdata/use-test-accounts.mjs"; // first: fixed test accounts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const fakeT3 = path.join(here, "testdata/fake-t3.mjs");

// usage.mjs --json against a fake T3 whose providers are `providers`, with one
// Claude thread log in a temp HOME (no AGY token there, so AGY just reports an error).
function usage(providers, logUtilization) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  fs.mkdirSync(path.join(home, ".t3/userdata/logs/provider"), { recursive: true });
  fs.writeFileSync(path.join(home, ".t3/userdata/server-runtime.json"), JSON.stringify({ port: 1 }));
  fs.writeFileSync(path.join(home, "t3.json"), JSON.stringify({ projects: [], threads: [], runs: [], messages: [], commands: [], providers }));
  if (logUtilization !== undefined) {
    const at = new Date().toISOString();
    const event = { observedAt: at, event: { id: "a", kind: "notification", provider: "claudeAgent", createdAt: at, method: "claude/rate_limit_event",
      payload: { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: logUtilization, resetsAt: Math.floor(Date.now() / 1000) + 7200 } } } } } };
    fs.writeFileSync(path.join(home, ".t3/userdata/logs/provider/events.t1.log"), `[${at}] NTIVE: ${JSON.stringify(event)}\n`);
  }
  const r = spawnSync(process.execPath, ["--import", fakeT3, path.join(here, "usage.mjs"), "--json"],
    { env: { ...process.env, HOME: home, FAKE_T3: path.join(home, "t3.json") }, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const probe = (instanceId, windows, extra = {}) => ({ instanceId, auth: { label: "Pro" }, usageLimits: { checkedAt: "2026-10-16T12:00:00.000Z", windows, ...extra } });

test("a failed Claude probe (no windows) still shows Claude, filled in from the thread logs", () => {
  const out = usage([
    probe("codex", [{ label: "Weekly", usedPercent: 40, resetsAt: null }]),
    probe("claudeAgent_main", [], { probeFailed: true }),
  ], 0.68);
  const claude = out.find((a) => a.instance === "claudeAgent_main");
  assert.ok(claude, `Claude dropped: ${JSON.stringify(out)}`);
  assert.equal(claude.windows.find((w) => w.label === "Session")?.usedPercent, 68);
  assert.equal(claude.source, "thread logs");
  assert.equal(out.find((a) => a.instance === "codex").windows[0].usedPercent, 40);
});

test("accounts with no windows from the probe or the logs are left out", () => {
  const out = usage([probe("codex_alt", []), probe("claudeAgent_main", [], { probeFailed: true })]);
  assert.deepEqual(out.map((a) => a.instance), []);
});

test("a Claude provider with no probe object at all is still filled in from the thread logs", () => {
  for (const usageLimits of [undefined, null, { checkedAt: "2026-10-16T12:00:00.000Z" }]) {
    const out = usage([{ instanceId: "claudeAgent_main", auth: { label: "Max" }, usageLimits }], 0.42);
    const claude = out.find((a) => a.instance === "claudeAgent_main");
    assert.ok(claude, `Claude dropped with usageLimits=${JSON.stringify(usageLimits)}: ${JSON.stringify(out)}`);
    assert.equal(claude.windows.find((w) => w.label === "Session")?.usedPercent, 42);
    assert.equal(claude.source, "thread logs");
    assert.equal(claude.resetCredits, 0);
  }
});

test("a Claude provider with no probe object and no logs is left out, not invented", () => {
  const out = usage([{ instanceId: "claudeAgent_main", usageLimits: undefined }, { instanceId: "claudeAgent", usageLimits: null }]);
  assert.deepEqual(out.map((a) => a.instance), []);
});

// --pick-codex against fake providers (the test accounts: main, second, spare = reserve); every account has gpt-6.2-sol.
function pick(providers, args, setup = null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-pick-"));
  fs.mkdirSync(path.join(home, ".t3/userdata/logs/provider"), { recursive: true });
  fs.writeFileSync(path.join(home, ".t3/userdata/server-runtime.json"), JSON.stringify({ port: 1 }));
  fs.writeFileSync(path.join(home, "t3.json"), JSON.stringify({ projects: [], threads: [], runs: [], messages: [], commands: [], providers }));
  for (const h of [".codex", ".codex_second", ".codex_spare"]) {
    fs.mkdirSync(path.join(home, h));
    fs.writeFileSync(path.join(home, h, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.2-sol" }] }));
  }
  setup?.(home);
  const r = spawnSync(process.execPath, ["--import", fakeT3, path.join(here, "usage.mjs"), "--cached", "--no-agy", ...args],
    { env: { ...process.env, HOME: home, FAKE_T3: path.join(home, "t3.json") }, encoding: "utf8", timeout: 60000 });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}
const marks = (home) => path.join(home, ".local/state/agent-stats/codex_signed_out");
function setMark(home, name, dir) {
  fs.mkdirSync(marks(home), { recursive: true });
  fs.writeFileSync(path.join(marks(home), `${name}.json`), JSON.stringify({ at: new Date(Date.now() - 60000).toISOString(), home: path.join(home, dir), error: "refresh token has expired" }));
}

test("pick-codex: a signed-out account (codex-login.mjs) is skipped; a login after the mark brings it back and ends the mark", () => {
  const soon = new Date(Date.now() + 3600e3).toISOString(), later = new Date(Date.now() + 3 * 864e5).toISOString();
  const providers = [probe("codex", [{ label: "Weekly", usedPercent: 10, resetsAt: soon }]), probe("codex_second", [{ label: "Weekly", usedPercent: 10, resetsAt: later }]),
    probe("codex_spare", [{ label: "Weekly", usedPercent: 10, resetsAt: soon }])];
  const args = ["--pick-codex", "gpt-6.2-sol"];
  assert.equal(pick(providers, args).out, "main");
  const skipped = pick(providers, args, (h) => setMark(h, "main", ".codex"));
  assert.equal(skipped.out, "second");
  assert.match(skipped.err, /codex account main skipped: signed out since .* \(run CODEX_HOME=.*\/\.codex codex login\)/);
  assert.equal(pick(providers, args, (h) => { setMark(h, "main", ".codex"); setMark(h, "second", ".codex_second"); }).out, "spare");
  let home;
  assert.equal(pick(providers, args, (h) => { home = h; setMark(h, "main", ".codex"); fs.writeFileSync(path.join(h, ".codex/auth.json"), "{}"); }).out, "main");
  assert.equal(fs.existsSync(path.join(marks(home), "main.json")), false, "the stale mark is removed");
  const all = pick(providers, args, (h) => { setMark(h, "main", ".codex"); setMark(h, "second", ".codex_second"); setMark(h, "spare", ".codex_spare"); });
  assert.equal(all.status, 3);
});

