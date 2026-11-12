// node --test skills/subagents/code/prune-workers.test.mjs
import "./testdata/use-test-accounts.mjs"; // first: fixed test accounts
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isWorker } from "./t3-api.mjs";
import fs from "node:fs";
import os from "node:os";
import { backgroundHold, pruneable, settleable } from "./prune-workers.mjs";
import { codexBackground } from "./reap-sessions.mjs";
import { ago, fakeHome } from "./testdata/fake-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const OLD = "2026-10-01T00:00:00Z";
const CUTOFF = "2026-10-11T00:00:00Z";
const thread = (id, title, edits = {}) => ({ id, title, settled: true, settledAt: OLD, updatedAt: OLD, archivedAt: null, deletedAt: null, ...edits });

test("prune picks TITLE workers by job dir, \"[model] job\" titles and delegate_task children, never main threads", () => {
  const ids = new Set(["fix-named"]);
  const threads = [
    thread("fix-named", "[opus] Board lanes, priority tags"),
    thread("old-style", "[sol61] p64-review"),
    thread("thread:delegated-task:command%3Aabc", "Port the adapter"),
    thread("main", "Triaging: 3 new items"),
  ];
  assert.deepEqual(pruneable(threads, CUTOFF, { worker: (id, title) => isWorker(id, title, ids) }).map((t) => t.id),
    ["fix-named", "old-style", "thread:delegated-task:command%3Aabc"]);
});

test("prune skips unsettled, recently active, archived (unless --delete) and deleted threads", () => {
  const threads = [
    thread("a", "[opus] a", { settled: false, settledAt: null }),
    thread("b", "[opus] b", { updatedAt: "2026-10-12T00:00:00Z" }),
    thread("c", "[opus] c", { archivedAt: OLD }),
    thread("d", "[opus] d", { deletedAt: OLD }),
    thread("e", "[opus] e", { settledAt: null, settledOverride: "settled" }),
  ];
  assert.deepEqual(pruneable(threads, CUTOFF, { worker: isWorker }).map((t) => t.id), ["e"]);
  assert.deepEqual(pruneable(threads, CUTOFF, { remove: true, worker: isWorker }).map((t) => t.id), ["c", "e"]);
});

test("prune archives delegate_task children that ended over --days ago, end to end on the fake T3", () => {
  const child = (name) => `thread:delegated-task:command%3Amcp%3Aparent%3Adelegate-task%3A${name}`;
  const lineage = { parentThreadId: "lead", relationshipToParent: "subagent", rootThreadId: "lead" };
  const old = ago(7 * 1440);
  const t = (id, edits = {}) => ({ thread_id: id, title: id.split("%3A").pop(), lineage, created_at: old, updated_at: old, ...edits });
  const run = (thread_id, ordinal, status, edits = {}) => ({ run_id: `${thread_id}:${ordinal}`, thread_id, ordinal, status, requested_at: old,
    completed_at: ["completed", "failed", "cancelled", "interrupted"].includes(status) ? old : null, ...edits });
  const f = fakeHome({
    threads: [
      t(child("done")), t(child("failed")), t(child("recent"), { updated_at: ago(60) }), t(child("running")), t(child("queued")),
      t(child("held")), t("subagent-by-lineage"), t("main", { lineage: null }),
    ],
    runs: [
      run(child("done"), 1, "completed"), run(child("failed"), 1, "failed"),
      run(child("recent"), 1, "completed", { completed_at: ago(60) }),
      run(child("running"), 1, "completed"), run(child("running"), 2, "running"),
      run(child("queued"), 1, "completed"), run(child("queued"), 2, "queued"),
      run(child("held"), 1, "completed"), run(child("held"), 2, "queued", { queue_held: true }),
      run("subagent-by-lineage", 1, "completed"), run("main", 1, "completed"),
    ],
  });
  const dry = f.run(path.join(here, "prune-workers.mjs"), ["--days", "5", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(f.sent(), []);
  const r = f.run(path.join(here, "prune-workers.mjs"), ["--days", "5"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.sent("thread.archive").map((c) => c.threadId).sort(),
    [child("done"), child("failed"), child("held"), "subagent-by-lineage"].sort());
  assert.match(r.stdout, /archived 4 worker thread/);
});

test("--settle picks ended delegate_task children and idle provider subagents, never running, snoozed, recent or main threads", () => {
  const NOW = Date.parse("2026-10-28T12:00:00Z");
  const CUT = "2026-10-28T11:50:00Z";
  const child = (id, edits = {}) => ({ id: `thread:delegated-task:${id}`, title: id, settled: false, archivedAt: null, deletedAt: null, activeRunId: null, busy: false,
    status: "completed", latestRunCompletedAt: "2026-10-28T11:00:00Z", updatedAt: "2026-10-28T11:00:00Z", ...edits });
  const threads = [
    child("done"),
    child("failed", { status: "failed" }),
    child("running", { status: "running", activeRunId: "r", busy: true }),
    child("recent", { latestRunCompletedAt: "2026-10-28T11:55:00Z", updatedAt: "2026-10-28T11:55:00Z" }),
    child("limited", { status: "failed", snoozedUntil: "2026-10-28T15:00:00Z" }),
    child("settled", { settled: true }),
    child("queued"),
    child("limited-unsnoozed", { status: "failed", usageLimitResetAt: "2026-10-28T14:00:00Z" }),
    child("limit-reset-passed", { status: "failed", usageLimitResetAt: "2026-10-28T11:00:00Z" }),
    child("has-helper"),
    { ...child("helper"), id: "thread:delegated-task:helper-of", status: "running", busy: true, activeRunId: "r", lineage: { parentThreadId: "thread:delegated-task:has-helper" } },
    { ...child("x"), id: "thread:provider:codex:native-thread:1", status: "idle", latestRunCompletedAt: null, lineage: { relationshipToParent: "subagent" } },
    { ...child("y"), id: "main-thread", lineage: null },
  ];
  assert.deepEqual(settleable(threads, CUT, { now: NOW, waiting: (id) => (id.endsWith("queued") ? ["q"] : []), held: () => false }).map((t) => t.id),
    ["thread:delegated-task:done", "thread:delegated-task:failed", "thread:provider:codex:native-thread:1"]);
});

test("--settle also picks a t3-thread worker a late helper report re-opened, once no helper of its runs", () => {
  const CUT = "2026-10-28T11:50:00Z";
  const t = (id, edits = {}) => ({ id, title: `[sol61] ${id}`, settled: false, archivedAt: null, deletedAt: null, activeRunId: null, busy: false,
    status: "completed", latestRunCompletedAt: "2026-10-28T10:35:00Z", updatedAt: "2026-10-28T10:35:00Z", ...edits });
  const threads = [t("reopened"), t("waits"), t("main", { title: "Screen time" }),
    { ...t("helper"), id: "thread:delegated-task:h", status: "running", busy: true, activeRunId: "r", lineage: { parentThreadId: "waits" } }];
  assert.deepEqual(settleable(threads, CUT, { worker: (id, title) => title.startsWith("[sol61]") && !id.startsWith("thread:"), waiting: () => [], held: () => false }).map((x) => x.id), ["reopened"]);
});

test("--settle --min 0: a just-finished child settles, but not while its live session still owes background work", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const t = (id) => ({ id: `thread:delegated-task:${id}`, title: id, settled: false, archivedAt: null, deletedAt: null, activeRunId: null, busy: false,
    status: "completed", latestRunCompletedAt: "2026-10-28T11:59:50Z", updatedAt: "2026-10-28T11:59:50Z" });
  const threads = ["done", "monitor", "unread", "codex", "other", "no-session"].map(t);
  const live = (id, driver = "claudeAgent") => ({ threadId: `thread:delegated-task:${id}`, driver, nativeId: id });
  const sessions = [live("done"), live("monitor"), live("unread"), live("codex", "codex"), live("other", "opencode")];
  const background = (s) => (s.nativeId === "monitor" ? { pending: [{ id: "b1", tool: "Monitor" }] }
    : s.nativeId === "unread" ? { error: "transcript line 4 doesn't parse" } : { pending: [] });
  const why = Object.fromEntries(threads.map((x) => [x.title, backgroundHold(x.id, sessions, background)]));
  assert.deepEqual(why, { done: null, monitor: "background work pending (Monitor b1)", unread: "background work not checked: transcript line 4 doesn't parse",
    codex: null, other: "live opencode session (no background record to read)", "no-session": null });
  const picked = settleable(threads, new Date(now).toISOString(), { now, waiting: () => [], held: (x) => !!backgroundHold(x.id, sessions, background) });
  assert.deepEqual(picked.map((x) => x.title), ["done", "codex", "no-session"]);
});

test("--settle --min 0: a finished Codex worker settles within the minute; an open turn, open tool call, running spawned agent or missing rollout keeps it", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const t = (id) => ({ id: `thread:delegated-task:${id}`, title: id, settled: false, archivedAt: null, deletedAt: null, activeRunId: null, busy: false,
    status: "completed", latestRunCompletedAt: "2026-10-30T11:59:50Z", updatedAt: "2026-10-30T11:59:50Z" });
  const ev = (type, turn) => JSON.stringify({ type: "event_msg", payload: { type, turn_id: turn } });
  const item = (type, call_id, name) => JSON.stringify({ type: "response_item", payload: { type, call_id, name } });
  const agent = (kind, id) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", kind, id, agent_thread_id: "kid", agent_path: "/root/kid" } } });
  const rollouts = {
    done: [ev("task_started", "t1"), item("custom_tool_call", "c1", "exec"), item("custom_tool_call_output", "c1"), ev("task_complete", "t1")],
    turn: [ev("task_started", "t1")],
    call: [ev("task_started", "t1"), item("custom_tool_call", "c1", "exec"), ev("task_complete", "t1")],
    agent: [ev("task_started", "t1"), item("function_call", "s1", "spawn_agent"), agent("started", "s1"), item("function_call_output", "s1"), ev("task_complete", "t1")],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-codex-"));
  fs.mkdirSync(path.join(dir, "2026/10/30"), { recursive: true });
  for (const [id, lines] of Object.entries(rollouts)) fs.writeFileSync(path.join(dir, "2026/10/30", `rollout-2026-10-30T11-00-00-${id}.jsonl`), lines.join("\n") + "\n");
  const threads = ["done", "turn", "call", "agent", "missing"].map(t);
  const sessions = threads.map((x) => ({ threadId: x.id, driver: "codex", nativeId: x.title }));
  const background = (s) => codexBackground(s, { sessionsDirs: [dir] });
  const why = Object.fromEntries(threads.map((x) => [x.title, backgroundHold(x.id, sessions, background)]));
  assert.deepEqual(why, { done: null, turn: "background work pending (turn t1)", call: "background work pending (exec c1)",
    agent: "background work pending (agent kid)", missing: "background work not checked: no rollout *-missing.jsonl" });
  const picked = settleable(threads, new Date(now).toISOString(), { now, waiting: () => [], held: (x) => !!backgroundHold(x.id, sessions, background) });
  assert.deepEqual(picked.map((x) => x.title), ["done"]);
});

// A slow T3: each --settle run stops at its first step over --timeout-s, or at --deadline-s,
// with one "stopped:" line, so a run never outlasts the timer's minute and no pass queues behind it.
// FAKE_T3_HANG picks the step that hangs: the token CLI, the ticket fetch, the socket open, or
// the settle request; "slow" answers each settle after FAKE_T3_SLOW_MS instead.
const hangPreload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3-hang-")), "hang.mjs");
fs.writeFileSync(hangPreload, `
import child from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const mode = process.env.FAKE_T3_HANG;
if (mode === "token") {
  const prev = child.execFileSync;
  child.execFileSync = function (cmd, args = [], opts) { return cmd === "t3" && args[0] === "auth" ? prev.call(this, "sleep", ["30"], opts) : prev.call(this, cmd, args, opts); };
  syncBuiltinESMExports();
}
// A real hung fetch holds its socket open (and the process alive); the interval stands in for it.
if (mode === "ticket") globalThis.fetch = (url, o) => new Promise((ok, fail) => {
  const socket = setInterval(() => {}, 1000);
  o?.signal?.addEventListener("abort", () => { clearInterval(socket); fail(o.signal.reason); });
});
if (mode === "socket") globalThis.WebSocket = class { close() {} send() {} };
if (mode === "request" || mode === "slow") {
  const Fake = globalThis.WebSocket;
  globalThis.WebSocket = class extends Fake {
    send(raw) {
      if (JSON.parse(raw).payload?.type !== "thread.settle") return super.send(raw);
      if (mode === "slow") setTimeout(() => super.send(raw), Number(process.env.FAKE_T3_SLOW_MS));
    }
    // A real socket whose close T3 never answers keeps node alive; the interval stands in for it.
    close() { if (mode === "request") setInterval(() => {}, 1000); else super.close(); }
  };
}
`);

const settleHome = () => {
  const lineage = { parentThreadId: "lead", relationshipToParent: "subagent", rootThreadId: "lead" };
  const old = ago(30);
  const ids = ["one", "two", "three"].map((n) => `thread:delegated-task:command%3Aslow%3A${n}`);
  return { ids, f: fakeHome({
    threads: ids.map((id) => ({ thread_id: id, title: id.split("%3A").pop(), lineage, created_at: old, updated_at: old })),
    runs: ids.map((id) => ({ run_id: `${id}:1`, thread_id: id, ordinal: 1, status: "completed", requested_at: old, completed_at: old })),
  }) };
};
// fakeHome.run puts fake-t3 first; the hang preload goes after it so it overrides the fake's pieces.
const settleRun = (f, mode, args, extra = {}) => {
  const t0 = Date.now();
  const r = f.run("--import", [hangPreload, path.join(here, "prune-workers.mjs"), "--settle", "--min", "0", ...args], { FAKE_T3_HANG: mode, ...extra });
  return { ...r, secs: (Date.now() - t0) / 1000 };
};

for (const [mode, step] of [["token", "connect \\(token\\)"], ["ticket", "connect \\(ticket\\)"], ["socket", "connect \\(socket\\)"], ["request", "orchestration.dispatchCommand thread.settle"]]) {
  test(`--settle on a T3 that hangs at ${mode}: stops after --timeout-s with one log line, no retry, rest left for the next run`, () => {
    const { f } = settleHome();
    const r = settleRun(f, mode, ["--timeout-s", "1"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`^stopped: T3 slow: ${step} took over 1\\.0 s; 3 thread\\(s\\) left for the next run$`, "m"));
    assert.equal(r.stderr.match(/stopped:/g).length, 1);
    assert.ok(r.secs < 5, `took ${r.secs} s`); // one timeout, not one per thread
    assert.deepEqual(f.sent("thread.settle"), []);
  });
}

test("--settle on a slow but answering T3: the whole run ends by --deadline-s and leaves the rest", () => {
  const { f } = settleHome();
  const r = settleRun(f, "slow", ["--timeout-s", "5", "--deadline-s", "1"], { FAKE_T3_SLOW_MS: "700" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^stopped: .+; [12] thread\(s\) left for the next run$/m);
  assert.ok(r.secs < 4, `took ${r.secs} s`);
  assert.ok(f.sent("thread.settle").length >= 1);
});

test("--settle on a healthy T3 settles every finished child and logs no stop", () => {
  const { f, ids } = settleHome();
  const r = settleRun(f, "none", ["--timeout-s", "5"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /stopped:/);
  assert.deepEqual(f.sent("thread.settle").map((c) => c.threadId).sort(), [...ids].sort());
});

test("--settle when T3's state DB query hangs: stops after --timeout-s, nothing settled", () => {
  // No fake T3 here: the real t3Query runs a python3 that never answers.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-dbhang-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, "prune-workers.mjs"), "--settle", "--min", "0", "--timeout-s", "1"],
    { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^stopped: T3 slow: state DB query took over 1\.0 s; every thread left for the next run$/m);
  assert.ok((Date.now() - t0) / 1000 < 5);
});
