// End to end: the real t3-thread.mjs CLI against a fake T3 (testdata/fake-t3.mjs).
import "./testdata/use-test-accounts.mjs"; // first: fixed test accounts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claude, codexAccounts, codexDefault } from "./accounts.mjs";
import { PROJECT, fakeHome } from "./testdata/fake-home.mjs";

const script = path.join(path.dirname(new URL(import.meta.url).pathname), "t3-thread.mjs");
const ok = (r) => { assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}${r.stdout}`); return r; };

test("dispatcher: TITLE becomes the worker thread's title in thread.create", () => {
  const f = fakeHome();
  const prompt = path.join(f.home, "prompt.md");
  fs.writeFileSync(prompt, "do the fix");
  ok(f.run(script, ["opus", prompt], { TITLE: "Board lanes, priority tags", JOB: "p99-impl", PROJECT_ROOT: PROJECT, NO_SETTLE: "1" }));
  const [created] = f.sent("thread.create");
  assert.equal(created.title, "[opus] Board lanes, priority tags");
  assert.equal(created.modelSelection.instanceId, claude.t3WorkerInstance);
  assert.equal(f.sent("thread.pin").length, 0, "workers are never pinned");
  assert.equal(fs.readFileSync(path.join(f.home, "jobs/p99-impl/thread_id"), "utf8"), created.threadId);
});

// The caller's T3 thread goes into parent_thread_id, so a counter of working threads counts a
// worker and its parent once.
test("dispatcher: the caller's thread is recorded in parent_thread_id, every run rewrites it, none outside T3", () => {
  const f = fakeHome();
  const db = path.join(f.home, "t3.json");
  fs.writeFileSync(db, JSON.stringify({ ...f.db(), providerThreads: [
    { thread_id: "lead-1", driver: "claudeAgent", native_id: "sess-1" },
    { thread_id: "lead-2", driver: "claudeAgent", native_id: "sess-2" }] }));
  const prompt = path.join(f.home, "prompt.md");
  fs.writeFileSync(prompt, "do the fix");
  const jobFile = (job, name) => path.join(f.home, "jobs", job, name);
  const env = { PROJECT_ROOT: PROJECT, NO_SETTLE: "1" };
  ok(f.run(script, ["opus", prompt], { ...env, JOB: "par", CLAUDE_CODE_SESSION_ID: "sess-1" }));
  assert.equal(fs.readFileSync(jobFile("par", "parent_thread_id"), "utf8"), "lead-1\n");
  // CONTINUE from another lead: the current caller wins.
  const attach = fs.readFileSync(jobFile("par", "thread_id"), "utf8");
  ok(f.run(script, ["opus", prompt], { ...env, JOB: "par", CLAUDE_CODE_SESSION_ID: "sess-2", ATTACH: attach, CONTINUE: "1" }));
  assert.equal(fs.readFileSync(jobFile("par", "parent_thread_id"), "utf8"), "lead-2\n");
  // Headless (no session in T3): nothing written.
  ok(f.run(script, ["opus", prompt], { ...env, JOB: "nopar" }));
  assert.ok(fs.existsSync(jobFile("nopar", "thread_id")));
  assert.equal(fs.existsSync(jobFile("nopar", "parent_thread_id")), false);
});

test("--orchestrator: an unpinned main thread with the exact title and the brief, no job dir; prints the id", () => {
  const f = fakeHome();
  const brief = path.join(f.home, "brief.md");
  fs.writeFileSync(brief, "Round 4: build items A and B");
  const r = ok(f.run(script, ["--orchestrator", "Round 4: board lanes", brief, "--effort", "high"], { PROJECT_ROOT: PROJECT }));
  const id = r.stdout.trim();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(f.sent().map((c) => [c.type, c.threadId]), [["thread.create", id], ["message.dispatch", id]]);
  const [created] = f.sent("thread.create");
  assert.equal(created.title, "Round 4: board lanes");
  assert.equal(created.projectId, "proj-1");
  assert.deepEqual(created.modelSelection, { instanceId: claude.t3Instance, model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }, { id: "fastMode", value: false }] });
  assert.equal(f.sent("message.dispatch")[0].text, "Round 4: build items A and B");
  assert.equal(f.db().threads.find((t) => t.thread_id === id).pinned_at ?? null, null, "not pinned: Working shows it");
  assert.equal(fs.existsSync(path.join(f.home, "jobs")), false, "no job dir: it counts as a main thread");
});

test("--orchestrator: bad args exit 2 and send nothing", () => {
  const f = fakeHome();
  const r = f.run(script, ["--orchestrator", "only a title"], { PROJECT_ROOT: PROJECT });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: t3-thread.mjs --orchestrator/);
  assert.equal(f.sent().length, 0);
});

// AGY-out fallback. A second preload on top of fake-t3.mjs shapes each run's
// outcome: with FAKE_AGY=quota antigravity runs fail on the AGY quota, and runs on the
// FAKE_LIMIT_INSTANCE Codex instance fail on a usage limit. The board is a stub script.
const agyPreload = `
import child from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
// FAKE_PICKS=a,b: usage.mjs --pick-codex returns the first name not in --exclude.
const prev = child.execFileSync;
child.execFileSync = function (cmd, args = [], opts) {
  if (process.env.FAKE_PICKS && args.includes("--pick-codex")) {
    const excluded = (args[args.indexOf("--exclude") + 1] ?? "").split(",");
    const name = process.env.FAKE_PICKS.split(",").find((n) => !excluded.includes(n));
    if (!name) throw new Error("no account left");
    return Buffer.from(name + "\\n");
  }
  return prev.call(this, cmd, args, opts);
};
syncBuiltinESMExports();
// FAKE_LIMIT_INSTANCE / FAKE_LIMIT_MODEL: runs there hit a usage limit; with FAKE_QUEUE_AFTER_LIMIT a
// message is left queued behind the limited run (as T3 holds it until the reset).
globalThis.fakeT3Outcome = (thread, command, db) => {
  const sel = command.modelSelection ?? JSON.parse(thread.model_selection_json ?? "{}");
  const instance = sel.instanceId;
  if ((instance && instance === process.env.FAKE_LIMIT_INSTANCE) || (sel.model && sel.model === process.env.FAKE_LIMIT_MODEL)) {
    if (process.env.FAKE_QUEUE_AFTER_LIMIT)
      db.runs.push({ run_id: "queued:" + thread.thread_id, thread_id: thread.thread_id, ordinal: 99, status: "queued", requested_at: new Date().toISOString(), completed_at: null });
    return { error: { class: "usage_limit", message: "You've hit your usage limit." } };
  }
  if (process.env.FAKE_AGY === "quota" && instance === "antigravity")
    return { error: { class: "provider_error", message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 10h5m0s." } };
  return {};
};
`;
const JOBS = "jobs";
const fakeT3 = path.join(path.dirname(new URL(import.meta.url).pathname), "testdata/fake-t3.mjs");
const isoIn = (min) => new Date(Date.now() + min * 60000).toISOString();
const gemini = JSON.stringify({ instanceId: "antigravity", model: "gemini-3.8-flash-high" });

function agyHome({ state, threads = [], runs = [], items = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-t3-"));
  fs.mkdirSync(path.join(home, ".t3/userdata"), { recursive: true });
  fs.writeFileSync(path.join(home, ".t3/userdata/server-runtime.json"), JSON.stringify({ port: 1 }));
  const statsDir = path.join(home, ".local/state/agent-stats");
  fs.mkdirSync(statsDir, { recursive: true });
  if (state) fs.writeFileSync(path.join(statsDir, "agy_state.json"), JSON.stringify(state));
  const db = path.join(home, "t3.json");
  fs.writeFileSync(db, JSON.stringify({ projects: [{ project_id: "proj-1", workspace_root: PROJECT }], threads, messages: [], runs, items, commands: [] }));
  const preload = path.join(home, "agy-preload.mjs");
  fs.writeFileSync(preload, agyPreload);
  fs.writeFileSync(path.join(home, "board-ok.py"), `import json, os, sys\nopen(os.path.join(os.environ["HOME"], "board.posts"), "a").write(json.dumps({"args": sys.argv[1:], "body": sys.stdin.read()}) + "\\n")\n`);
  fs.writeFileSync(path.join(home, "board-down.py"), `import sys\nsys.exit("board is down")\n`);
  fs.writeFileSync(path.join(home, "prompt.md"), "look something up");
  const env = { ...process.env, HOME: home, FAKE_T3: db, AGENT_JOBS_DIR: path.join(home, JOBS), PROJECT_ROOT: PROJECT, NO_SETTLE: "1",
    MESSAGE_BOARD_SCRIPT: path.join(home, "board-ok.py") };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "TITLE", "JOB", "ATTACH", "CONTINUE", "EFFORT", "FAKE_AGY", "ACCOUNT", "FAKE_PICKS", "FAKE_LIMIT_INSTANCE", "FAKE_LIMIT_MODEL", "FAKE_QUEUE_AFTER_LIMIT", "FAKE_SETTLE_REFUSE"]) delete env[k];
  const jobDir = (job) => path.join(home, JOBS, job);
  const read = (job, f) => { try { return fs.readFileSync(path.join(jobDir(job), f), "utf8"); } catch { return ""; } };
  return {
    home,
    run: (job, extra = {}, model = "gemini-flash") => spawnSync(process.execPath, ["--import", fakeT3, "--import", preload, script, model, path.join(home, "prompt.md")],
      { env: { ...env, JOB: job, ...extra }, encoding: "utf8", timeout: 60000 }),
    sent: (type) => JSON.parse(fs.readFileSync(db, "utf8")).commands.filter((c) => !type || c.type === type),
    read,
    attempts: (job) => read(job, "attempts.jsonl").trim().split("\n").filter(Boolean).map((l) => {
      const a = JSON.parse(l);
      // Every attempt: start and end parse, in order.
      assert.ok(Date.parse(a.start) <= Date.parse(a.end), `start ${a.start} end ${a.end}`);
      return a;
    }),
    posts: () => { try { return fs.readFileSync(path.join(home, "board.posts"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } },
    agyState: () => JSON.parse(fs.readFileSync(path.join(statsDir, "agy_state.json"), "utf8")),
    marker: () => fs.existsSync(path.join(statsDir, "agy_notice")),
  };
}
const outState = (checkedMinAgo = 10, resetMin = 300) => ({
  checkedAt: isoIn(-checkedMinAgo),
  windows: [{ label: "Session · Gemini Flash", usedPercent: 10, resetsAt: isoIn(60) }, { label: "Weekly · Gemini Flash", usedPercent: 100, resetsAt: isoIn(resetMin) }],
});

test("AGY out: gemini-flash opens a Haiku high thread, logs the fallback, posts one board notice", () => {
  const state = outState();
  const until = new Date(state.windows[1].resetsAt).toISOString();
  const f = agyHome({ state });
  ok(f.run("out1"));
  const [created] = f.sent("thread.create");
  assert.equal(created.modelSelection.model, "claude-haiku-5-5");
  assert.deepEqual(created.modelSelection.options.find((o) => o.id === "effort"), { id: "effort", value: "high" });
  assert.match(created.title, /^\[haiku\] /);
  assert.equal(f.sent("thread.create").length, 1);
  const line = `fallback gemini-flash -> haiku (AGY out until ${until})`;
  assert.ok(f.read("out1", "run.log").includes(line), f.read("out1", "run.log"));
  assert.ok(f.read("out1", "limits.log").includes(line));
  const posts = f.posts();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].args.slice(0, 5), ["post", "--agent", "subagents-launcher", "--topic", "limits"]);
  assert.ok(!posts[0].args.includes("--to"), "broadcast");
  assert.match(posts[0].body, /^AGY\/Gemini out until .+ → helpers on Haiku high$/);
  const [a] = f.attempts("out1");
  assert.equal(f.attempts("out1").length, 1);
  assert.deepEqual([a.model_label, a.model_id, a.harness, a.effort, a.exit, a.fallback_from, a.thread_id], ["haiku", "claude-haiku-5-5", "t3", "high", 0, "gemini-flash", created.threadId]);
  assert.deepEqual(Object.keys(a).sort(), ["account", "cwd", "effort", "end", "exit", "fallback_from", "harness", "model_id", "model_label", "session_id", "start", "thread_id"]);
  assert.equal(a.cwd, PROJECT);
  // Same reset: the next job falls back again, without a second notice.
  ok(f.run("out2"));
  assert.ok(f.read("out2", "run.log").includes("fallback gemini-flash -> haiku"));
  assert.equal(f.posts().length, 1);
});

test("AGY out: EFFORT override is kept on Haiku", () => {
  const f = agyHome({ state: outState() });
  ok(f.run("eff", { EFFORT: "medium" }));
  const [created] = f.sent("thread.create");
  assert.equal(created.modelSelection.model, "claude-haiku-5-5");
  assert.equal(created.modelSelection.options.find((o) => o.id === "effort").value, "medium");
});

test("AGY recovered (reset passed) or stale state: Gemini runs", () => {
  for (const state of [outState(10, -5), outState(180, 300)]) {
    const f = agyHome({ state });
    ok(f.run("gem"));
    const [created] = f.sent("thread.create");
    assert.equal(created.modelSelection.instanceId, "antigravity");
    assert.equal(f.read("gem", "run.log").includes("fallback"), false);
    assert.deepEqual(f.attempts("gem").map((a) => [a.model_label, a.fallback_from]), [["gemini-flash", null]]);
    assert.equal(f.posts().length, 0);
  }
});

test("no AGY state + quota error: same job reruns on Haiku high, state written, notice posted", () => {
  const f = agyHome();
  ok(f.run("quota", { FAKE_AGY: "quota" }));
  const created = f.sent("thread.create");
  assert.deepEqual(created.map((c) => c.modelSelection.model), ["gemini-3.8-flash-high", "claude-haiku-5-5"]);
  assert.equal(created[1].modelSelection.options.find((o) => o.id === "effort").value, "high");
  assert.deepEqual(f.attempts("quota").map((a) => [a.model_label, a.exit, a.fallback_from]), [["gemini-flash", 1, null], ["haiku", 0, "gemini-flash"]]);
  assert.equal(f.read("quota", "report.md"), "fake reply");
  // The abandoned Gemini thread is settled even with NO_SETTLE, so T3's auto-resume leaves it alone.
  assert.deepEqual(f.sent("thread.settle").map((c) => c.threadId), [f.read("quota", "threads").split("\n")[0]]);
  const left = Date.parse(f.agyState().windows.find((w) => w.usedPercent >= 100).resetsAt) - Date.now();
  assert.ok(left > 10 * 3600e3 && left <= (10 * 60 + 5) * 60e3, `reset in ${left} ms`);
  assert.ok(f.read("quota", "limits.log").includes("fallback gemini-flash -> haiku (AGY out until "));
  assert.equal(f.posts().length, 1);
  // The next job reads the written state and skips Gemini.
  ok(f.run("quota2", { FAKE_AGY: "quota" }));
  assert.equal(f.sent("thread.create").at(-1).modelSelection.model, "claude-haiku-5-5");
  assert.equal(f.sent("thread.create").length, 3);
  assert.equal(f.posts().length, 1);
});

test("board down: the job still runs on Haiku and the failure is logged", () => {
  const f = agyHome({ state: outState() });
  ok(f.run("down", { MESSAGE_BOARD_SCRIPT: path.join(f.home, "board-down.py") }));
  assert.equal(f.sent("thread.create")[0].modelSelection.model, "claude-haiku-5-5");
  assert.ok(f.read("down", "run.log").includes("board notice failed: board is down"), f.read("down", "run.log"));
  assert.equal(f.marker(), false);
});

test("CONTINUE on a Gemini thread while AGY is out: the old thread is stopped and settled, then a fresh Haiku thread takes the job", () => {
  const old = "11111111-1111-4111-8111-111111111111";
  const f = agyHome({ state: outState(), threads: [{ thread_id: old, project_id: "proj-1", model_selection_json: gemini }],
    runs: [{ run_id: "g1", thread_id: old, ordinal: 1, status: "completed", completed_at: "2026-10-16T20:00:00Z" },
      { run_id: "g2", thread_id: old, ordinal: 2, status: "queued", completed_at: null }] });
  ok(f.run("cont", { ATTACH: old, CONTINUE: "1" })); // NO_SETTLE is set: the abandoned thread is settled anyway
  assert.equal(f.sent("message.dispatch").filter((c) => c.threadId === old).length, 0, "the Gemini thread gets no turn");
  const [created] = f.sent("thread.create");
  assert.equal(created.modelSelection.model, "claude-haiku-5-5");
  assert.equal(f.read("cont", "thread_id"), created.threadId);
  assert.ok(f.read("cont", "run.log").includes(`a fresh thread takes the job instead of ${old}`));
  assert.ok(f.read("cont", "run.log").includes("fallback gemini-flash -> haiku"));
  const order = f.sent().map((c) => `${c.type} ${c.threadId === old ? "old" : "new"}`);
  assert.deepEqual(order.slice(0, 3), ["queued-run.cancel old", "thread.settle old", "thread.create new"], order.join(", "));
  assert.ok(!order.includes("thread.settle new"), "NO_SETTLE keeps the job's own thread open");
});

test("CONTINUE on a Gemini thread while AGY is out: T3 refuses the settle, so nothing replaces it; exit 1", () => {
  const old = "12121212-1212-4121-8121-121212121212";
  const f = agyHome({ state: outState(), threads: [{ thread_id: old, project_id: "proj-1", model_selection_json: gemini }] });
  const r = f.run("cont-refused", { ATTACH: old, CONTINUE: "1", FAKE_SETTLE_REFUSE: old });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`could not settle ${old} \\(AGY is out\\): .*waiting on an approval`));
  assert.equal(f.sent("thread.create").length, 0);
  assert.equal(f.sent("message.dispatch").length, 0);
  assert.equal(f.read("cont-refused", "exit_code"), "1\n");
  assert.match(f.read("cont-refused", "run.log"), /could not settle/);
});

test("CONTINUE on a Gemini thread while AGY is fine: the same thread continues on its own model", () => {
  const old = "22222222-2222-4222-8222-222222222222";
  const f = agyHome({ threads: [{ thread_id: old, project_id: "proj-1", model_selection_json: gemini }] });
  ok(f.run("cont2", { ATTACH: old, CONTINUE: "1" }));
  assert.equal(f.sent("thread.create").length, 0);
  const starts = f.sent("message.dispatch");
  assert.deepEqual(starts.map((c) => [c.threadId, c.modelSelection.instanceId, c.dispatchMode.type, c.createdBy]), [[old, "antigravity", "queue_after_active", "agent"]]);
});

// attempts.jsonl records what the thread really runs on (sol61 R1/R2): the attached
// thread's own model and account on a re-poll, the dispatched selection on CONTINUE,
// each Codex account on a retry.
// Accounts from this machine's accounts.mjs: a Codex account other than the default, and the Claude worker profile.
const other = codexAccounts.find((a) => a.name !== codexDefault);
const dflt = codexAccounts.find((a) => a.name === codexDefault);
const haikuInstance = claude.t3WorkerInstance;
const sol61On = (instanceId) => JSON.stringify({ instanceId, model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "default" }] });
const haikuOn = (instanceId) => JSON.stringify({ instanceId, model: "claude-haiku-5-5", options: [{ id: "effort", value: "high" }, { id: "contextWindow", value: "200k" }] });
const row = (a) => [a.model_label, a.model_id, a.effort, a.account, a.exit];

test("ATTACH re-poll of a Codex thread on another account: its own model, effort and account", () => {
  const old = "33333333-3333-4333-8333-333333333333";
  const f = agyHome({ threads: [{ thread_id: old, project_id: "proj-1", model_selection_json: sol61On(other.t3Instance) }] });
  ok(f.run("att", { ATTACH: old }, "sol61"));
  assert.equal(f.sent().length, 0, "a re-poll sends nothing");
  assert.deepEqual(f.attempts("att").map((a) => [...row(a), a.thread_id]), [["sol61", "gpt-6.1-sol", "high", other.name, 0, old]]);
});

test("CONTINUE of a Codex thread on another account: the dispatched account is recorded", () => {
  const old = "44444444-4444-4444-8444-444444444444";
  const f = agyHome({ threads: [{ thread_id: old, project_id: "proj-1", model_selection_json: sol61On(other.t3Instance) }] });
  ok(f.run("cont3", { ATTACH: old, CONTINUE: "1" }, "sol61"));
  const [start] = f.sent("message.dispatch");
  assert.equal(start.modelSelection.instanceId, other.t3Instance);
  assert.deepEqual(f.attempts("cont3").map(row), [["sol61", "gpt-6.1-sol", "high", other.name, 0]]);
});

test("ATTACH re-poll of an earlier Haiku fallback, given the gemini-flash label: recorded as Haiku", () => {
  const old = "55555555-5555-4555-8555-555555555555";
  const f = agyHome({ threads: [{ thread_id: old, project_id: "proj-1", model_selection_json: haikuOn(haikuInstance) }] });
  ok(f.run("att2", { ATTACH: old }));
  assert.deepEqual(f.attempts("att2").map(row), [["haiku", "claude-haiku-5-5", "high", haikuInstance, 0]]);
});

test("CONTINUE of an earlier Haiku fallback with AGY recovered: stays on Haiku, recorded as dispatched", () => {
  const old = "66666666-6666-4666-8666-666666666666";
  const f = agyHome({ state: outState(10, -5), threads: [{ thread_id: old, project_id: "proj-1", model_selection_json: haikuOn(haikuInstance) }] });
  ok(f.run("cont5", { ATTACH: old, CONTINUE: "1" }));
  const sel2 = f.sent("message.dispatch").at(-1).modelSelection;
  assert.equal(sel2.model, "claude-haiku-5-5");
  assert.deepEqual(f.attempts("cont5").map(row), [["haiku", "claude-haiku-5-5", "high", sel2.instanceId, 0]]);
});

test("ACCOUNT=auto Codex retry: each attempt records its own account", () => {
  const f = agyHome();
  ok(f.run("retry", { ACCOUNT: "auto", FAKE_PICKS: `${dflt.name},${other.name}`, FAKE_LIMIT_INSTANCE: dflt.t3Instance }, "sol61"));
  const created = f.sent("thread.create");
  assert.deepEqual(created.map((c) => c.modelSelection.instanceId), [dflt.t3Instance, other.t3Instance]);
  assert.deepEqual(f.attempts("retry").map((a) => [...row(a), a.thread_id]),
    [["sol61", "gpt-6.1-sol", "high", dflt.name, 1, created[0].threadId], ["sol61", "gpt-6.1-sol", "high", other.name, 0, created[1].threadId]]);
  assert.deepEqual(f.sent("thread.settle").map((c) => c.threadId), [created[0].threadId], "the limited thread is settled; NO_SETTLE keeps the last");
  const types = f.sent().map((c) => c.type);
  assert.ok(types.indexOf("thread.settle") < types.lastIndexOf("thread.create"), `settled before the retry starts: ${types}`);
});

test("limit fallback: a message queued behind the limit is removed, the thread settled, then the retry starts", () => {
  const f = agyHome();
  ok(f.run("retry-queued", { ACCOUNT: "auto", FAKE_PICKS: `${dflt.name},${other.name}`, FAKE_LIMIT_INSTANCE: dflt.t3Instance, FAKE_QUEUE_AFTER_LIMIT: "1" }, "sol61"));
  const created = f.sent("thread.create");
  assert.deepEqual(created.map((c) => c.modelSelection.instanceId), [dflt.t3Instance, other.t3Instance]);
  const order = f.sent().filter((c) => c.type !== "message.dispatch").map((c) => `${c.type} ${c.threadId === created[0].threadId ? 1 : 2}`);
  assert.deepEqual(order, ["thread.create 1", "queued-run.cancel 1", "thread.settle 1", "thread.create 2"]);
  assert.deepEqual(f.attempts("retry-queued").map((a) => a.exit), [1, 0]);
  assert.equal(f.read("retry-queued", "report.md"), "fake reply");
});

test("limit fallback: T3 refuses to settle the limited thread, so no retry starts; exit 1, the reason on stderr and in run.log", () => {
  const f = agyHome();
  const r = f.run("retry-refused", { ACCOUNT: "auto", FAKE_PICKS: `${dflt.name},${other.name}`, FAKE_LIMIT_INSTANCE: dflt.t3Instance, FAKE_SETTLE_REFUSE: "*" }, "sol61");
  assert.equal(r.status, 1, r.stderr);
  const created = f.sent("thread.create");
  assert.equal(created.length, 1, "no second account was tried");
  assert.match(r.stderr, new RegExp(`could not settle ${created[0].threadId} \\(usage limit\\)`));
  assert.match(f.read("retry-refused", "run.log"), /could not settle .*nothing replaces it/);
  assert.equal(f.read("retry-refused", "exit_code"), "1\n");
  assert.match(f.read("retry-refused", "report.md"), /usage limit/);
});

test("Fable re-poll: a usage-limited run behind a newer run cancelled before starting still falls back to Opus", () => {
  const old = "99999999-9999-4999-8999-999999999999";
  const fable = JSON.stringify({ instanceId: haikuInstance, model: "claude-fable-5-1", options: [{ id: "effort", value: "high" }] });
  const f = agyHome({ threads: [{ thread_id: old, project_id: "proj-1", model_selection_json: fable }],
    runs: [{ run_id: "f1", thread_id: old, ordinal: 1, status: "failed", completed_at: "2026-10-16T20:00:00Z" },
      { run_id: "f2", thread_id: old, ordinal: 2, status: "cancelled", completed_at: "2026-10-16T20:01:00Z", started_at: null }],
    items: [{ thread_id: old, run_id: "f1", type: "error", status: "failed", updated_at: "2026-10-16T20:00:00Z",
      payload: { failure: { class: "usage_limit", message: "You've hit your usage limit." } } }] });
  ok(f.run("fable", { ATTACH: old }, "fable"));
  assert.deepEqual(f.attempts("fable").map((a) => [a.model_label, a.exit]), [["fable", 1], ["opus", 0]]);
  assert.deepEqual(f.sent("thread.create").map((c) => c.modelSelection.model), ["claude-opus-5-5"]);
  assert.deepEqual(f.sent("thread.settle").map((c) => c.threadId), [old]);
  assert.equal(f.read("fable", "report.md"), "fake reply");
});

// Handoff: CONTINUE on a thread compacted HANDOFF_COMPACTIONS (3) times or
// more opens a fresh thread instead. The old thread's compactions are pre-0.1.0 activity rows
// (and v2 compaction items); it has one finished run that replied "reply on <id>" (or, after
// oldRunning(), a run still going). A third preload makes polls fast and answers each new run
// with "reply on <thread id>"; with FAKE_QUOTA new Gemini threads hit the AGY quota; each
// message records the job's report.md as it was then (\`reportAtStart\`).
const handoffPreload = `
import fs from "node:fs";
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, ms === 5000 ? 1 : ms, ...a); // fast polls
globalThis.fakeT3Outcome = (thread, command, db) => {
  const report = process.env.REPORT_FILE;
  db.reportAtStart = [...(db.reportAtStart ?? []), fs.existsSync(report) ? fs.readFileSync(report, "utf8") : null];
  const instance = (command.modelSelection ?? JSON.parse(thread.model_selection_json ?? "{}")).instanceId;
  if (process.env.FAKE_QUOTA && thread.thread_id !== process.env.ATTACH && instance === "antigravity")
    return { error: { class: "provider_error", message: "Individual quota reached. Resets in 10h5m0s." } };
  return { reply: "reply on " + thread.thread_id };
};
`;
const HANDOFF_MAIN_INSTANCE = claude.t3Instance;
const HANDOFF_WORKER_INSTANCE = claude.t3WorkerInstance;
const longThread = "77777777-7777-4777-8777-777777777777";
const compactedRow = (at, tokens) => ({ thread_id: longThread, kind: "context-compaction", created_at: at, payload_json: JSON.stringify(tokens ? { state: "compacted", beforeTokens: 170000, afterTokens: 12000 } : { state: "compacted" }) });
// Three compactions: the tokenless row 5 min after the first is the same compaction.
const threeCompactions = [compactedRow("2026-10-10T01:00:00Z", true), compactedRow("2026-10-10T01:05:00Z", false),
  compactedRow("2026-10-10T02:00:00Z", true), compactedRow("2026-10-10T03:00:00Z", true)];

function handoffHome(rows, items = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-t3-"));
  fs.mkdirSync(path.join(home, ".t3/userdata"), { recursive: true });
  fs.writeFileSync(path.join(home, ".t3/userdata/server-runtime.json"), JSON.stringify({ port: 1 }));
  const opusSel = JSON.stringify({ instanceId: HANDOFF_MAIN_INSTANCE, model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }, { id: "fastMode", value: false }, { id: "contextWindow", value: "200k" }] });
  const db = path.join(home, "t3.json");
  const oldRun = `run:${longThread}:1`;
  fs.writeFileSync(db, JSON.stringify({ projects: [{ project_id: "proj-1", workspace_root: PROJECT }],
    threads: [{ thread_id: longThread, project_id: "proj-1", title: "[opus] Fix it", model_selection_json: opusSel }],
    runs: [{ run_id: oldRun, thread_id: longThread, ordinal: 1, status: "completed", requested_at: "2026-10-10T00:00:00Z", completed_at: "2026-10-10T04:00:00Z" }],
    messages: [{ thread_id: longThread, message_id: "old-reply", run_id: oldRun, role: "assistant", text: `reply on ${longThread}`, created_at: "2026-10-10T04:00:00Z" }],
    activities: rows, items: items.map((at) => ({ thread_id: longThread, run_id: oldRun, type: "compaction", updated_at: at, payload: { beforeTokenCount: 167177, afterTokenCount: 14518 } })),
    commands: [] }));
  const preload = path.join(home, "handoff-preload.mjs");
  fs.writeFileSync(preload, handoffPreload);
  fs.writeFileSync(path.join(home, "prompt.md"), "fix finding 2");
  const jobDir = path.join(home, JOBS, "p1");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "report.md"), "old report");
  fs.writeFileSync(path.join(jobDir, "thread_id"), longThread);
  const env = { ...process.env, HOME: home, FAKE_T3: db, AGENT_JOBS_DIR: path.join(home, JOBS), PROJECT_ROOT: PROJECT, JOB: "p1", TITLE: "Fix it",
    ATTACH: longThread, CONTINUE: "1", REPORT_FILE: path.join(jobDir, "report.md"),
    MESSAGE_BOARD_SCRIPT: path.join(home, "board-off.py") };
  fs.writeFileSync(path.join(home, "board-off.py"), "import sys\nsys.exit('board off in tests')\n");
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "EFFORT", "NO_SETTLE", "PLAN", "HANDOFF_COMPACTIONS"]) delete env[k];
  return {
    jobDir,
    jobs: path.join(home, JOBS),
    prompt: path.join(home, "prompt.md"),
    run: (extra = {}, args = ["opus", path.join(home, "prompt.md")]) => spawnSync(process.execPath, ["--import", fakeT3, "--import", preload, script, ...args],
      { env: { ...env, ...extra }, encoding: "utf8", timeout: 60000 }),
    sent: (type) => JSON.parse(fs.readFileSync(db, "utf8")).commands.filter((c) => !type || c.type === type),
    read: (f) => { try { return fs.readFileSync(path.join(jobDir, f), "utf8"); } catch { return ""; } },
    db: () => JSON.parse(fs.readFileSync(db, "utf8")),
    oldThread: (edits) => { const d = JSON.parse(fs.readFileSync(db, "utf8")); Object.assign(d.threads[0], edits); fs.writeFileSync(db, JSON.stringify(d)); },
    oldRunning: () => {
      const d = JSON.parse(fs.readFileSync(db, "utf8"));
      Object.assign(d.runs[0], { status: "running", completed_at: null });
      d.messages[0].text = "half done";
      fs.writeFileSync(db, JSON.stringify(d));
    },
  };
}

test("handoff: CONTINUE after 3 compactions opens a fresh thread told the old one, its report and PLAN", () => {
  const f = handoffHome(threeCompactions);
  const r = ok(f.run({ PLAN: "/p/plan.md" }));
  const [created] = f.sent("thread.create");
  assert.ok(created, "a new thread");
  assert.equal(created.title, "[opus] Fix it");
  assert.equal(created.modelSelection.model, "claude-opus-5-5");
  assert.equal(created.modelSelection.instanceId, HANDOFF_WORKER_INSTANCE);
  assert.equal(created.modelSelection.options.find((o) => o.id === "effort").value, "high");
  const starts = f.sent("message.dispatch");
  assert.deepEqual(starts.map((s) => s.threadId), [created.threadId], "the old thread gets no turn");
  assert.equal(starts[0].text,
    `You take over from thread ${longThread}; its last report is ${path.join(f.jobDir, "report.md")}.\nPLAN: /p/plan.md\n\n${fs.readFileSync(path.join(f.jobDir, "prompt.md"), "utf8")}`);
  assert.equal(f.read("thread_id"), created.threadId);
  assert.equal(f.read("thread_ids_prev"), `${longThread}\n`);
  assert.deepEqual(f.sent("thread.settle").map((c) => c.threadId), [longThread, created.threadId]);
  assert.deepEqual(f.sent().slice(0, 2).map((c) => [c.type, c.threadId]), [["thread.settle", longThread], ["thread.create", created.threadId]],
    "the old thread is settled before the new one starts");
  const line = `handoff ${longThread}→${created.threadId} (3 compactions)`;
  assert.ok(f.read("run.log").includes(line), f.read("run.log"));
  assert.ok(r.stderr.includes(line));
  assert.equal(f.read("report.md"), `reply on ${created.threadId}`);
  assert.equal(f.read("compactions"), "0\n");
  assert.match(r.stderr, /compactions: 0/);
  assert.equal(f.read("exit_code"), "0\n");
});

test("handoff: T3 refuses to settle the old thread, so no new thread starts; exit 1", () => {
  const f = handoffHome(threeCompactions);
  const r = f.run({ FAKE_SETTLE_REFUSE: longThread });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`could not settle ${longThread} \\(handoff\\)`));
  assert.equal(f.sent("thread.create").length, 0);
  assert.equal(f.sent("message.dispatch").length, 0);
  assert.equal(f.read("exit_code"), "1\n");
  assert.equal(f.read("report.md"), `reply on ${longThread}`, "the old thread's last reply is kept as the report");
});

test("handoff: 2 compactions continue the same thread; the count is written", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  ok(f.run());
  assert.equal(f.sent("thread.create").length, 0);
  const starts = f.sent("message.dispatch");
  assert.deepEqual(starts.map((s) => s.threadId), [longThread]);
  assert.ok(starts[0].text.startsWith("fix finding 2"));
  assert.equal(f.read("compactions"), "2\n");
  assert.equal(f.read("thread_ids_prev"), "");
});

test("handoff: HANDOFF_COMPACTIONS=2 lowers the bar; no PLAN line without PLAN", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  ok(f.run({ HANDOFF_COMPACTIONS: "2" }));
  const [s] = f.sent("message.dispatch");
  assert.notEqual(s.threadId, longThread);
  assert.ok(!s.text.includes("PLAN:"));
});

test("handoff: a still-running old turn blocks the takeover; nothing starts, the error is loud", () => {
  const f = handoffHome(threeCompactions);
  f.oldRunning();
  const r = f.run({ TIMEOUT: "1s" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /handoff: 77777777-7777-4777-8777-777777777777 still running after TIMEOUT; nothing started/);
  assert.equal(f.sent("thread.create").length, 0);
  assert.equal(f.sent("message.dispatch").length, 0);
  assert.equal(f.sent("thread.settle").length, 0);
  assert.equal(f.read("report.md"), "old report");
  assert.equal(f.read("exit_code"), "124\n");
});

test("handoff: a timed-out handoff replaces a stale exit_code with 124", () => {
  const f = handoffHome(threeCompactions);
  f.oldRunning();
  fs.writeFileSync(path.join(f.jobDir, "exit_code"), "0\n");
  fs.utimesSync(path.join(f.jobDir, "exit_code"), new Date(0), new Date(0));
  const r = f.run({ TIMEOUT: "1s" });
  assert.notEqual(r.status, 0);
  assert.equal(f.read("exit_code"), "124\n");
  assert.ok(fs.statSync(path.join(f.jobDir, "exit_code")).mtimeMs > 0);
  assert.equal(f.read("report.md"), "old report");
});

test("handoff: the old thread's last reply is saved as report.md before the new thread starts", () => {
  const f = handoffHome(threeCompactions);
  ok(f.run());
  assert.deepEqual(f.db().reportAtStart, [`reply on ${longThread}`]);
});

test("handoff: a quota retry keeps the takeover message; no TITLE keeps the old title", () => {
  const f = handoffHome(threeCompactions);
  f.oldThread({ title: "[gemini-flash] Look up the docs", model_selection_json: JSON.stringify({ instanceId: "antigravity", model: "gemini-3.8-flash-high" }) });
  ok(f.run({ FAKE_QUOTA: "1", PLAN: "/p/plan.md", TITLE: "" }));
  const created = f.sent("thread.create");
  assert.deepEqual(created.map((c) => c.modelSelection.model), ["gemini-3.8-flash-high", "claude-haiku-5-5"]);
  assert.equal(created[0].title, "[gemini-flash] Look up the docs");
  const starts = f.sent("message.dispatch");
  assert.equal(starts.length, 2);
  for (const s of starts) assert.ok(s.text.startsWith(`You take over from thread ${longThread};`) && s.text.includes("PLAN: /p/plan.md"), s.text);
  assert.equal(f.read("thread_ids_prev"), `${longThread}\n`, "the old thread is recorded once");
});

test("--compactions: v2 compaction items and pre-0.1.0 activity rows both count", () => {
  const f = handoffHome(threeCompactions.slice(0, 3), ["2026-10-17T00:39:39Z"]);
  const r = ok(f.run({}, ["--compactions", longThread]));
  assert.equal(r.stdout.trim(), "3");
});

test("handoff: 2 old compactions + 1 since 0.1.0 reach the bar", () => {
  const f = handoffHome(threeCompactions.slice(0, 3), ["2026-10-17T00:39:39Z"]);
  ok(f.run());
  const [s] = f.sent("message.dispatch");
  assert.notEqual(s.threadId, longThread);
  assert.ok(f.read("run.log").includes("(3 compactions)"));
});

test("timeout: the running run is interrupted with run.interrupt; exit 124", () => {
  const f = handoffHome([]);
  f.oldRunning();
  const r = f.run({ TIMEOUT: "1s", CONTINUE: "" });
  assert.equal(r.status, 124, r.stderr);
  const [i] = f.sent("run.interrupt");
  assert.deepEqual([i.threadId, i.runId, i.reason], [longThread, `run:${longThread}:1`, "timeout"]);
  assert.equal(f.read("report.md"), "half done");
});

// New stage, fresh reviewer: a sol61/astra thread ATTACHed with CONTINUE under a
// JOB other than the one whose job dir records it starts a fresh thread; the same JOB continues.
const sol61Sel = JSON.stringify({ instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "medium" }, { id: "serviceTier", value: "default" }] });
function reviewerHome(rows = []) {
  const f = handoffHome(rows);
  f.oldThread({ title: "[sol61] Review S1", model_selection_json: sol61Sel });
  const readJob = (job, file) => { try { return fs.readFileSync(path.join(f.jobs, job, file), "utf8"); } catch { return ""; } };
  const review = (job) => f.run({ JOB: job, TITLE: "Review S2", REPORT_FILE: path.join(f.jobs, job, "report.md") }, ["sol61", f.prompt]);
  return { ...f, readJob, review };
}

test("new stage: a sol61 thread recorded under another JOB gets a fresh reviewer thread, printed and logged", () => {
  const f = reviewerHome();
  const r = ok(f.review("p2"));
  const [created] = f.sent("thread.create");
  assert.ok(created, "a fresh thread");
  assert.equal(created.modelSelection.model, "gpt-6.1-sol");
  assert.deepEqual(f.sent("message.dispatch").map((s) => s.threadId), [created.threadId], "the old reviewer gets no turn");
  const line = "new stage p1→p2: fresh reviewer thread";
  assert.ok(r.stderr.includes(line), r.stderr);
  assert.ok(f.readJob("p2", "run.log").includes(line));
  assert.equal(f.readJob("p2", "thread_ids_prev"), "");
  assert.equal(f.read("thread_id"), longThread, "the old job keeps its record");
});

test("new stage: same JOB is a recheck and continues the reviewer thread", () => {
  const f = reviewerHome();
  const r = ok(f.review("p1"));
  assert.equal(f.sent("thread.create").length, 0);
  assert.deepEqual(f.sent("message.dispatch").map((s) => s.threadId), [longThread]);
  assert.ok(!r.stderr.includes("new stage"), r.stderr);
});

test("new stage: an opus worker attached under a new JOB still continues its thread", () => {
  const f = handoffHome([]);
  const r = ok(f.run({ JOB: "p2", REPORT_FILE: path.join(f.jobs, "p2", "report.md") }));
  assert.equal(f.sent("thread.create").length, 0);
  assert.deepEqual(f.sent("message.dispatch").map((s) => s.threadId), [longThread]);
  assert.ok(!r.stderr.includes("new stage"), r.stderr);
});
