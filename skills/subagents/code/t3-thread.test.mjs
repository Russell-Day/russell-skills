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

// T3_THREAD_SCRIPT runs the suite on a scratch copy before it replaces the live launcher.
const script = process.env.T3_THREAD_SCRIPT ?? path.join(path.dirname(new URL(import.meta.url).pathname), "t3-thread.mjs");
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
  // No job dir (it counts as a main thread); the jobs dir holds only the main-thread registry line.
  assert.deepEqual(fs.readdirSync(path.join(f.home, "jobs")), ["main-threads.jsonl"]);
  const lines = fs.readFileSync(path.join(f.home, "jobs/main-threads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map(({ at, ...l }) => l), [{ threadId: id, role: "orchestrator", title: "Round 4: board lanes" }]);
  assert.ok(Date.parse(lines[0].at));
});

test("--orchestrator: each new lead gets its own registry line, whatever its title", () => {
  const f = fakeHome();
  const brief = path.join(f.home, "brief.md");
  fs.writeFileSync(brief, "Sweep the garden notes");
  const a = ok(f.run(script, ["--orchestrator", "Garden notes sweep", brief], { PROJECT_ROOT: PROJECT })).stdout.trim();
  const b = ok(f.run(script, ["--orchestrator", "Kitchen inventory: restock list", brief, "--model", "fable"], { PROJECT_ROOT: PROJECT })).stdout.trim();
  const lines = fs.readFileSync(path.join(f.home, "jobs/main-threads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.threadId, l.role, l.title, "from" in l]), [[a, "orchestrator", "Garden notes sweep", false], [b, "orchestrator", "Kitchen inventory: restock list", false]]);
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
    return { error: { class: "usage_limit", message: process.env.FAKE_LIMIT_TEXT ?? "You've hit your usage limit." } };
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
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "TITLE", "JOB", "ATTACH", "CONTINUE", "EFFORT", "FAKE_AGY", "ACCOUNT", "FAKE_PICKS", "FAKE_LIMIT_INSTANCE", "FAKE_LIMIT_MODEL", "FAKE_LIMIT_TEXT", "FAKE_QUEUE_AFTER_LIMIT", "FAKE_SETTLE_REFUSE"]) delete env[k];
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

// attempts.jsonl records what the thread really runs on (sol62 R1/R2): the attached
// thread's own model and account on a re-poll, the dispatched selection on CONTINUE,
// each Codex account on a retry.
// Accounts from this machine's accounts.mjs: a Codex account other than the default, and the Claude worker profile.
const other = codexAccounts.find((a) => a.name !== codexDefault);
const dflt = codexAccounts.find((a) => a.name === codexDefault);
const haikuInstance = claude.t3WorkerInstance;
const sol62On = (instanceId) => JSON.stringify({ instanceId, model: "gpt-6.2-sol", options: [{ id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "default" }] });
const haikuOn = (instanceId) => JSON.stringify({ instanceId, model: "claude-haiku-5-5", options: [{ id: "effort", value: "high" }, { id: "contextWindow", value: "200k" }] });
const row = (a) => [a.model_label, a.model_id, a.effort, a.account, a.exit];

test("ATTACH re-poll of a Codex thread on another account: its own model, effort and account", () => {
  const old = "33333333-3333-4333-8333-333333333333";
  const f = agyHome({ threads: [{ thread_id: old, project_id: "proj-1", model_selection_json: sol62On(other.t3Instance) }] });
  ok(f.run("att", { ATTACH: old }, "sol62"));
  assert.equal(f.sent().length, 0, "a re-poll sends nothing");
  assert.deepEqual(f.attempts("att").map((a) => [...row(a), a.thread_id]), [["sol62", "gpt-6.2-sol", "high", other.name, 0, old]]);
});

test("CONTINUE of a Codex thread on another account: the dispatched account is recorded", () => {
  const old = "44444444-4444-4444-8444-444444444444";
  const f = agyHome({ threads: [{ thread_id: old, project_id: "proj-1", model_selection_json: sol62On(other.t3Instance) }] });
  ok(f.run("cont3", { ATTACH: old, CONTINUE: "1" }, "sol62"));
  const [start] = f.sent("message.dispatch");
  assert.equal(start.modelSelection.instanceId, other.t3Instance);
  assert.deepEqual(f.attempts("cont3").map(row), [["sol62", "gpt-6.2-sol", "high", other.name, 0]]);
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
  ok(f.run("retry", { ACCOUNT: "auto", FAKE_PICKS: `${dflt.name},${other.name}`, FAKE_LIMIT_INSTANCE: dflt.t3Instance }, "sol62"));
  const created = f.sent("thread.create");
  assert.deepEqual(created.map((c) => c.modelSelection.instanceId), [dflt.t3Instance, other.t3Instance]);
  assert.deepEqual(f.attempts("retry").map((a) => [...row(a), a.thread_id]),
    [["sol62", "gpt-6.2-sol", "high", dflt.name, 1, created[0].threadId], ["sol62", "gpt-6.2-sol", "high", other.name, 0, created[1].threadId]]);
  assert.deepEqual(f.sent("thread.settle").map((c) => c.threadId), [created[0].threadId], "the limited thread is settled; NO_SETTLE keeps the last");
  const types = f.sent().map((c) => c.type);
  assert.ok(types.indexOf("thread.settle") < types.lastIndexOf("thread.create"), `settled before the retry starts: ${types}`);
});

test("limit fallback: a message queued behind the limit is removed, the thread settled, then the retry starts", () => {
  const f = agyHome();
  ok(f.run("retry-queued", { ACCOUNT: "auto", FAKE_PICKS: `${dflt.name},${other.name}`, FAKE_LIMIT_INSTANCE: dflt.t3Instance, FAKE_QUEUE_AFTER_LIMIT: "1" }, "sol62"));
  const created = f.sent("thread.create");
  assert.deepEqual(created.map((c) => c.modelSelection.instanceId), [dflt.t3Instance, other.t3Instance]);
  const order = f.sent().filter((c) => c.type !== "message.dispatch").map((c) => `${c.type} ${c.threadId === created[0].threadId ? 1 : 2}`);
  assert.deepEqual(order, ["thread.create 1", "queued-run.cancel 1", "thread.settle 1", "thread.create 2"]);
  assert.deepEqual(f.attempts("retry-queued").map((a) => a.exit), [1, 0]);
  assert.equal(f.read("retry-queued", "report.md"), "fake reply");
});

test("limit fallback: T3 refuses to settle the limited thread, so no retry starts; exit 1, the reason on stderr and in run.log", () => {
  const f = agyHome();
  const r = f.run("retry-refused", { ACCOUNT: "auto", FAKE_PICKS: `${dflt.name},${other.name}`, FAKE_LIMIT_INSTANCE: dflt.t3Instance, FAKE_SETTLE_REFUSE: "*" }, "sol62");
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

// A worker the main Claude account's limit stops reruns, same model, on claude.overflow.
function overflowAccounts(home) {
  const raw = JSON.parse(fs.readFileSync(process.env.ACCOUNTS_FILE, "utf8"));
  raw.claude.overflow = { [raw.claude.t3WorkerInstance]: "claudeAgent_spare_workers" };
  const file = path.join(home, "accounts-overflow.json");
  fs.writeFileSync(file, JSON.stringify(raw));
  return { ACCOUNTS_FILE: file, main: raw.claude.t3WorkerInstance };
}
test("Claude overflow: Opus at the main account's limit reruns on the overflow account, same model, fresh thread", () => {
  const f = agyHome();
  const { ACCOUNTS_FILE, main } = overflowAccounts(f.home);
  const r = ok(f.run("ovf", { ACCOUNTS_FILE, FAKE_LIMIT_INSTANCE: main }, "opus"));
  assert.match(r.stderr, new RegExp(`Claude overflow: ${main} -> claudeAgent_spare_workers`));
  const created = f.sent("thread.create");
  assert.deepEqual(created.map((c) => [c.modelSelection.instanceId, c.modelSelection.model]),
    [[main, "claude-opus-5-5"], ["claudeAgent_spare_workers", "claude-opus-5-5"]]);
  assert.deepEqual(f.attempts("ovf").map((a) => a.exit), [1, 0]);
  assert.deepEqual(f.sent("thread.settle").map((c) => c.threadId), [created[0].threadId]);
  // Without an overflow entry the limited run is the result, as before.
  const g = agyHome();
  assert.equal(g.run("no-ovf", { FAKE_LIMIT_INSTANCE: main }, "opus").status, 1);
  assert.equal(g.sent("thread.create").length, 1);
});

test("Claude overflow: Fable moves first, and its Opus fallback stays on the overflow account", () => {
  const f = agyHome();
  const { ACCOUNTS_FILE, main } = overflowAccounts(f.home);
  ok(f.run("fable-ovf", { ACCOUNTS_FILE, FAKE_LIMIT_MODEL: "claude-fable-5-2" }, "fable"));
  assert.deepEqual(f.sent("thread.create").map((c) => [c.modelSelection.instanceId, c.modelSelection.model]),
    [[main, "claude-fable-5-2"], ["claudeAgent_spare_workers", "claude-fable-5-2"], ["claudeAgent_spare_workers", "claude-opus-5-5"]]);
});

// A preload that writes `text` into the job's report.md once the first thread exists (a worker
// writing its packet itself), then a launch of `model` with it.
function runWithWriter(f, job, text, model, extra = {}) {
  const d = path.join(f.home, JOBS, job);
  fs.mkdirSync(d, { recursive: true });
  const writer = path.join(f.home, `writer-${job}.mjs`);
  fs.writeFileSync(writer, `import fs from "node:fs";\nconst t = setInterval(() => { try { const j = JSON.parse(fs.readFileSync(process.env.FAKE_T3, "utf8")); if (j.commands.some((c) => c.type === "thread.create")) { fs.writeFileSync(${JSON.stringify(path.join(d, "report.md"))}, ${JSON.stringify(text)}); clearInterval(t); } } catch {} }, 50);\nt.unref();\n`);
  return spawnSync(process.execPath, ["--import", fakeT3, "--import", path.join(f.home, "agy-preload.mjs"), "--import", writer, script, model, path.join(f.home, "prompt.md")],
    { env: { ...process.env, HOME: f.home, FAKE_T3: path.join(f.home, "t3.json"), AGENT_JOBS_DIR: path.join(f.home, JOBS), PROJECT_ROOT: PROJECT, NO_SETTLE: "1", JOB: job,
      MESSAGE_BOARD_SCRIPT: path.join(f.home, "board-ok.py"), ...extra }, encoding: "utf8", timeout: 60000 });
}
test("report.md the worker wrote during its run is kept; its reply stays in transcript.md", () => {
  const f = agyHome();
  fs.mkdirSync(path.join(f.home, JOBS, "self"), { recursive: true });
  fs.writeFileSync(path.join(f.home, JOBS, "self", "report.md"), "old round");
  ok(runWithWriter(f, "self", "worker packet", "haiku"));
  assert.equal(f.read("self", "report.md"), "worker packet");
  assert.equal(f.read("self", "transcript.md"), "fake reply");
  // A later run whose worker leaves report.md alone writes its reply there as usual.
  ok(f.run("self", {}, "haiku"));
  assert.equal(f.read("self", "report.md"), "fake reply");
});

test("report.md: a worker's packet survives a limit retry; one identical to the old report is still the worker's", () => {
  const f = agyHome();
  const { ACCOUNTS_FILE, main } = overflowAccounts(f.home);
  ok(runWithWriter(f, "retry-pkt", "worker packet", "opus", { ACCOUNTS_FILE, FAKE_LIMIT_INSTANCE: main }));
  assert.equal(f.sent("thread.create").length, 2);
  assert.equal(f.read("retry-pkt", "report.md"), "worker packet");
  const g = agyHome();
  const file = path.join(g.home, JOBS, "same", "report.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "same packet");
  fs.utimesSync(file, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  ok(runWithWriter(g, "same", "same packet", "haiku"));
  assert.equal(g.read("same", "report.md"), "same packet");
});

test("Claude overflow: Fable at the 5-hour limit on the overflow account stops; no Opus thread", () => {
  const f = agyHome();
  const { ACCOUNTS_FILE } = overflowAccounts(f.home);
  const r = f.run("fable-5h", { ACCOUNTS_FILE, FAKE_LIMIT_MODEL: "claude-fable-5-2", FAKE_LIMIT_TEXT: "You've hit your 5-hour limit." }, "fable");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Claude 5-hour limit: Opus shares it/);
  assert.deepEqual(f.sent("thread.create").map((c) => c.modelSelection.model), ["claude-fable-5-2", "claude-fable-5-2"]);
});

test("TIMEOUT: a bare number is minutes, 90s and 2h as written, a bad value says how to write it", () => {
  const f = agyHome();
  for (const [value, line] of [["180", "timeout 180 min"], ["90s", "timeout 1.5 min"], ["2h", "timeout 120 min"]]) {
    ok(f.run(`t-${value}`, { TIMEOUT: value }, "haiku"));
    assert.ok(f.read(`t-${value}`, "run.log").includes(line), `${value}: ${f.read(`t-${value}`, "run.log")}`);
  }
  const r = f.run("t-bad", { TIMEOUT: "ten" }, "haiku");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /bad TIMEOUT: ten \(use 90m, 2h or 30s\)/);
});

// Handoff: CONTINUE on a thread compacted HANDOFF_COMPACTIONS times or more (default 2 for a
// worker, 3 for a reviewer) opens a fresh thread instead. The old thread's compactions are pre-0.1.0 activity rows
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
    preload,
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

// A completed turn without VERDICT: DONE: the successor is told (final r3 F1); the messages file says per message what is left (plan 1120 S3).
const UNFINISHED = "Its edits are uncommitted in the tree: read `git status` and `git diff` for its files first and keep what it finished. Its last turn ended without `VERDICT: DONE`: its work is not finished (its report may be from an earlier round; one ending `HANDOFF:` lists what is left).\n\n";
const pendingOne = (file) => `Every message its lead sent it is in ${file}, oldest first, each headed with how its turn ended. Do every message marked PENDING there, in order (message 1 of 1: those after its last \`VERDICT: DONE\` turn); compare the diff with each first and keep what is already done. Then do this round.\n\n`;
test("handoff: CONTINUE after 3 compactions opens a fresh thread told the old one, its report and PLAN", () => {
  const f = handoffHome(threeCompactions);
  setTurns(f, [{ lead: "Implement S2: own a.py.", reply: `reply on ${longThread}` }]);
  const r = ok(f.run({ PLAN: "/p/plan.md" }));
  const [created] = f.sent("thread.create");
  assert.ok(created, "a new thread");
  assert.equal(created.title, "[opus] Fix it");
  assert.equal(created.modelSelection.model, "claude-opus-5-5");
  assert.equal(created.modelSelection.instanceId, HANDOFF_WORKER_INSTANCE);
  assert.equal(created.modelSelection.options.find((o) => o.id === "effort").value, "high");
  const starts = f.sent("message.dispatch");
  assert.deepEqual(starts.map((s) => s.threadId), [created.threadId], "the old thread gets no turn");
  const file = path.join(f.jobDir, "handoff-3-messages.md");
  assert.equal(starts[0].text,
    `You take over from thread ${longThread}; its last report is ${path.join(f.jobDir, "report.md")}.\nPLAN: /p/plan.md\n\n${UNFINISHED}${pendingOne(file)}Its original task, for owned files, rules and Verify commands:\n\n<<<ORIGINAL TASK\nImplement S2: own a.py.\nORIGINAL TASK>>>\n\nEARLIER LEAD MESSAGES: ${file}\n\n## This round\n\n${fs.readFileSync(path.join(f.jobDir, "prompt.md"), "utf8")}`);
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
  setTurns(f, [{ lead: "Implement S2: own a.py.", reply: `reply on ${longThread}` }]);
  const r = f.run({ FAKE_SETTLE_REFUSE: longThread });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(fs.readdirSync(f.jobDir).filter((n) => /^handoff-/.test(n)), [], "no messages file for a hand-off that didn't happen");
  assert.match(r.stderr, new RegExp(`could not settle ${longThread} \\(handoff\\)`));
  assert.equal(f.sent("thread.create").length, 0);
  assert.equal(f.sent("message.dispatch").length, 0);
  assert.equal(f.read("exit_code"), "1\n");
  assert.equal(f.read("report.md"), `reply on ${longThread}`, "the old thread's last reply is kept as the report");
});

test("handoff: a worker under 2 compactions continues the same thread; the count is written", () => {
  const f = handoffHome(threeCompactions.slice(0, 2));
  ok(f.run());
  assert.equal(f.sent("thread.create").length, 0);
  const starts = f.sent("message.dispatch");
  assert.deepEqual(starts.map((s) => s.threadId), [longThread]);
  assert.ok(starts[0].text.startsWith("fix finding 2"));
  assert.equal(f.read("compactions"), "1\n");
  assert.equal(f.read("thread_ids_prev"), "");
});

test("handoff: a worker's fix round at 2 compactions goes to a fresh thread; no PLAN line without PLAN", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: "Implement S2: own a.py.", reply: `reply on ${longThread}` }]);
  ok(f.run());
  const [s] = f.sent("message.dispatch");
  assert.notEqual(s.threadId, longThread);
  assert.ok(!s.text.includes("PLAN:"));
  assert.ok(f.read("run.log").includes("(2 compactions)"));
});

// Plan 1120 S3: a worker's successor gets every lead message of the old thread in
// <job>/handoff-<k>-messages.md, each headed with the turn that answered it and how that turn ended,
// the original task once in its brief, and a pointer line for a later hand-off. The launcher's own
// nudges are left out by the exact texts it prints with --nudges (read here, not retyped).
const NUDGES = JSON.parse(spawnSync(process.execPath, [script, "--nudges"], { encoding: "utf8" }).stdout);
const [VERDICT_NUDGE_TEXT, WORKER_NUDGE_TEXT, WORKER_VERDICT_NUDGE_TEXT] = NUDGES;
const workerAppendix = fs.readFileSync(path.join(path.dirname(script), "worker-communication.md"), "utf8");
const asSent = (brief) => `${brief}\n\n${workerAppendix}`; // what the launcher sends for a worker brief
const IN_BRIEF = "inlined in the hand-off brief between the ORIGINAL TASK markers";
const S2_TASK = "Implement S2: own a.py. Verify: pytest a.";
// The old thread's turns, oldest first: { lead, reply, status = "completed", id, runless } is a user
// message (none without `lead`) and its run; `runless` adds the message with no run (queued, never started).
function setTurns(f, turns) {
  const d = f.db();
  d.runs = []; d.messages = [];
  let ordinal = 0;
  turns.forEach((t, i) => {
    const at = `2026-10-10T00:${String(i).padStart(2, "0")}:00Z`;
    if (t.runless) { d.messages.push({ thread_id: longThread, message_id: t.id ?? `lead-${i}`, run_id: null, role: "user", text: t.lead, created_at: at }); return; }
    const run_id = `run:${longThread}:${++ordinal}`;
    d.runs.push({ run_id, thread_id: longThread, ordinal, status: t.status ?? "completed", requested_at: at, completed_at: at });
    if (t.lead != null) d.messages.push({ thread_id: longThread, message_id: t.id ?? `lead-${i}`, run_id, role: "user", text: t.lead, created_at: at });
    if (t.reply) d.messages.push({ thread_id: longThread, message_id: `reply-${i}`, run_id, role: "assistant", text: t.reply, created_at: at.replace(/:00Z$/, ":30Z") });
  });
  fs.writeFileSync(path.join(path.dirname(f.preload), "t3.json"), JSON.stringify(d));
}
const setPrompt = (f, text) => fs.writeFileSync(f.prompt, text);
const entry = (n, turn, outcome, pending, text) => `## Message ${n} · turn ${turn} · ${outcome} · ${pending ? "PENDING" : "done"}\n\n${text}\n`;
const DONE = "completed with VERDICT: DONE", NO_VERDICT = "completed without VERDICT: DONE";
const messagesFiles = (f) => fs.readdirSync(f.jobDir).filter((n) => /^handoff-\d+-messages\.md$/.test(n));

test("handoff messages: an interrupted successor's inherited fix stays PENDING through a chained hand-off (pointer, no nesting)", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: S2_TASK, reply: "S2 built.\n\nVERDICT: DONE" }, { lead: "fix A: b.py drops the header", reply: "Half of A done; tests next." }]);
  setPrompt(f, "fix B: c.py");
  ok(f.run());
  const [s] = f.sent("message.dispatch");
  const file1 = path.join(f.jobDir, "handoff-2-messages.md");
  const body1 = fs.readFileSync(file1, "utf8");
  assert.ok(body1.startsWith(`# Lead messages to thread ${longThread}\n\n`), body1);
  assert.ok(body1.endsWith(`${entry(1, 1, DONE, false, `(the original task: ${IN_BRIEF})`)}\n${entry(2, 2, NO_VERDICT, true, "fix A: b.py drops the header")}`), body1);
  assert.ok(s.text.includes(`Every message its lead sent it is in ${file1}, oldest first, each headed with how its turn ended. Do every message marked PENDING there, in order (message 2 of 2: those after its last \`VERDICT: DONE\` turn)`), s.text);
  assert.ok(s.text.includes(`<<<ORIGINAL TASK\n${S2_TASK}\nORIGINAL TASK>>>\n\nEARLIER LEAD MESSAGES: ${file1}\n\n## This round\n\nfix B: c.py`), s.text);
  // The successor's only turn is interrupted before it finishes A or B; the lead's next round hands it off.
  const g = handoffHome(threeCompactions.slice(0, 3));
  setTurns(g, [{ lead: s.text, status: "interrupted" }]);
  setPrompt(g, "fix C: d.py");
  ok(g.run());
  const [t] = g.sent("message.dispatch");
  const file2 = path.join(g.jobDir, "handoff-2-messages.md");
  const body2 = fs.readFileSync(file2, "utf8");
  assert.ok(body2.includes(`## Message 1 · turn 1 · did not finish (interrupted) · PENDING\n\n(a hand-off brief) Earlier lead messages: ${file1}. Its PENDING messages were handed on with this brief: they are still pending unless this message's turn ended \`VERDICT: DONE\`.\n\nGiven with it:\n\nfix B: c.py`), body2);
  assert.ok(!body2.includes("fix A"), "the earlier fix stays in its own file, not nested");
  assert.ok(fs.readFileSync(file1, "utf8").includes(entry(2, 2, NO_VERDICT, true, "fix A: b.py drops the header")), "the pointed-to file still holds fix A as PENDING");
  assert.equal(t.text.split("<<<ORIGINAL TASK").length, 2, t.text);
  assert.equal(t.text.split("You take over from").length, 2, t.text);
  assert.ok(t.text.includes(`<<<ORIGINAL TASK\n${S2_TASK}\nORIGINAL TASK>>>\n\nEARLIER LEAD MESSAGES: ${file2}\n\n## This round\n\nfix C: d.py`), t.text);
  assert.ok(t.text.includes("Its last turn did not finish (interrupted): its work is not finished"), t.text);
  assert.ok(t.text.includes("(message 1 of 1: those after its last `VERDICT: DONE` turn)"), t.text);
  assert.equal(g.read("rounds"), "", "a worker has no rounds");
});

test("handoff messages: CONTINUE resending the original brief keeps the pending fix; the task appears once", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: asSent(S2_TASK), reply: "Most of S2." }, { lead: "fix A: b.py", reply: "A in progress." }]);
  setPrompt(f, S2_TASK);
  ok(f.run());
  const [s] = f.sent("message.dispatch");
  const body = f.read("handoff-2-messages.md");
  assert.ok(body.endsWith(`${entry(1, 1, NO_VERDICT, true, `(the original task: ${IN_BRIEF})`)}\n${entry(2, 2, NO_VERDICT, true, "fix A: b.py")}`), body);
  assert.equal(s.text.split(S2_TASK).length, 2, "the original task once");
  assert.ok(s.text.endsWith("## This round\n\nThe lead sent the original brief again (above, between the ORIGINAL TASK markers): finish it, after the PENDING messages."), s.text);
  assert.ok(s.text.includes("(messages 1, 2 of 2"), s.text);
});

test("handoff messages: the launcher's own nudges are left out; the fix before them stays PENDING", () => {
  assert.equal(NUDGES.length, 3);
  assert.ok(WORKER_VERDICT_NUDGE_TEXT.startsWith(WORKER_NUDGE_TEXT.replace(/\. Don't end the turn waiting\.$/, "")));
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: S2_TASK, reply: "S2 built.\n\nVERDICT: DONE" }, { lead: "fix A: b.py", reply: "Tests running in the background." },
    { lead: WORKER_VERDICT_NUDGE_TEXT, reply: "Still on it." }]);
  setPrompt(f, "fix B");
  ok(f.run());
  const body = f.read("handoff-2-messages.md");
  assert.ok(!body.includes("Your last turn ended"), body);
  // fix A's turn is the last run before the next lead message: the nudge's run, no verdict.
  assert.ok(body.endsWith(entry(2, 3, NO_VERDICT, true, "fix A: b.py")), body);
  // Another order: nudges between and after lead messages, and a turn with no lead message and no reply.
  const g = handoffHome(threeCompactions.slice(0, 3));
  setTurns(g, [{ lead: S2_TASK, reply: "Waiting on pytest." }, { lead: VERDICT_NUDGE_TEXT, reply: "Partial." }, { lead: "fix A: b.py", reply: "Review incomplete." },
    { lead: `${WORKER_NUDGE_TEXT}\n`, reply: "Fixed A.\n\nVERDICT: DONE" }, {}, { lead: WORKER_VERDICT_NUDGE_TEXT, status: "failed" }]);
  setPrompt(g, "fix B");
  ok(g.run());
  const gb = g.read("handoff-2-messages.md");
  for (const n of NUDGES) assert.ok(!gb.includes(n.trim()), `nudge left in: ${n.slice(0, 40)}`);
  // fix A's segment is runs 3-6; the failed nudge run 6 is the last word: not finished.
  assert.ok(gb.endsWith(`${entry(1, 2, NO_VERDICT, true, `(the original task: ${IN_BRIEF})`)}\n${entry(2, 6, "did not finish (failed)", true, "fix A: b.py")}`), gb);
});

test("handoff messages: a VERDICT: DONE turn then a new round: only the new round is PENDING", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: S2_TASK, reply: "S2 built.\n\nVERDICT: DONE" }, { lead: "fix A", reply: "A fixed.\n\nVERDICT: DONE" }, { lead: "fix B", reply: "Working on B." }]);
  setPrompt(f, "fix C");
  ok(f.run());
  const body = f.read("handoff-2-messages.md");
  assert.ok(body.endsWith(`${entry(1, 1, DONE, false, `(the original task: ${IN_BRIEF})`)}\n${entry(2, 2, DONE, false, "fix A")}\n${entry(3, 3, NO_VERDICT, true, "fix B")}`), body);
  const [s] = f.sent("message.dispatch");
  assert.ok(s.text.includes("(message 3 of 3: those after its last `VERDICT: DONE` turn)"), s.text);
  // All done: nothing pending, the successor is told not to redo them.
  const d = handoffHome(threeCompactions.slice(0, 3));
  setTurns(d, [{ lead: S2_TASK, reply: "Half." }, { lead: "fix A", reply: "A fixed.\n\nVERDICT: DONE" }]);
  ok(d.run());
  assert.ok(!d.read("handoff-2-messages.md").includes("PENDING\n"), d.read("handoff-2-messages.md"));
  assert.ok(d.sent("message.dispatch")[0].text.includes("oldest first: all are done (its last turn ended `VERDICT: DONE`), so don't redo them. Then do this round."));
  assert.ok(d.sent("message.dispatch")[0].text.includes("Its last turn completed with `VERDICT: DONE`.\n\n"));
});

test("handoff messages: several wordings and orders (limit resumes, a lead's own \"continue\", a resent brief, a never-started message)", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: S2_TASK, reply: "Built.\n\nVERDICT: DONE" }, { lead: "Please also fix the README.", status: "failed" },
    { lead: "Continue where you left off.", id: `limit-resume:${longThread}:2`, reply: "README half done." }, { lead: "continue", reply: "Hit a snag.\n\nVERDICT: BLOCKED" },
    { lead: S2_TASK, reply: "Rechecking." }, { lead: "Also run ruff.", runless: true }]);
  setPrompt(f, "fix Z");
  ok(f.run());
  const body = f.read("handoff-2-messages.md");
  assert.ok(!body.includes("Continue where you left off"), "a limit resume is T3's, not the lead's");
  assert.ok(body.endsWith([entry(1, 1, DONE, false, `(the original task: ${IN_BRIEF})`), entry(2, 3, NO_VERDICT, true, "Please also fix the README."),
    entry(3, 4, NO_VERDICT, true, "continue"), entry(4, 5, NO_VERDICT, true, `(the lead resent the original brief: ${IN_BRIEF})`),
    entry(5, "none", "not started", true, "Also run ruff.")].join("\n")), body);
  assert.ok(f.sent("message.dispatch")[0].text.includes("(messages 2, 3, 4, 5 of 5"));
  // No VERDICT: DONE anywhere: every message is pending, the first included.
  const g = handoffHome(threeCompactions.slice(0, 3));
  setTurns(g, [{ lead: S2_TASK, status: "interrupted" }, { lead: "fix A", reply: "VERDICT: DONE is what I'd write if done; not yet." }]);
  ok(g.run());
  assert.ok(g.read("handoff-2-messages.md").endsWith(`${entry(1, 1, "did not finish (interrupted)", true, `(the original task: ${IN_BRIEF})`)}\n${entry(2, 2, NO_VERDICT, true, "fix A")}`));
});

test("handoff messages: an old-format successor brief (ORIGINAL TASK + LAST ROUND) keeps its rounds; the task once", () => {
  const legacy = `You take over from thread 0000; its last report is /x/report.md.\n\nIts edits are uncommitted in the tree: read \`git status\` and \`git diff\` for its files first and keep what it finished. Its last turn ended without \`VERDICT: DONE\`: its work is not finished.\n\nIts original task, for owned files, rules and Verify commands:\n\n<<<ORIGINAL TASK\n${S2_TASK}\nORIGINAL TASK>>>\n\n## Its last round\n\n<<<LAST ROUND\nfix finding 2\nLAST ROUND>>>\n\n## This round\n\nfix finding 3`;
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: legacy, reply: "Finding 2 done, 3 next." }]);
  setPrompt(f, "fix finding 4");
  ok(f.run());
  const [s] = f.sent("message.dispatch");
  assert.equal(s.text.split("<<<ORIGINAL TASK").length, 2, s.text);
  assert.equal(s.text.split("You take over from").length, 2, s.text);
  assert.ok(!s.text.includes("LAST ROUND"), s.text);
  const body = f.read("handoff-2-messages.md");
  assert.ok(body.includes(`## Message 1 · turn 1 · ${NO_VERDICT} · PENDING\n\nYou take over from thread 0000;`), body);
  assert.ok(body.includes(`(the original task: ${IN_BRIEF})\n\n## Its last round\n\n<<<LAST ROUND\nfix finding 2\nLAST ROUND>>>\n\n## This round\n\nfix finding 3\n`), body);
  assert.equal(body.split(S2_TASK).length, 1, "the task isn't in the file");
});

// Plan 1120 S3 r1 F1: a generated hand-off brief is known by its whole layout (TAKEOVER line, the task
// between the markers, the EARLIER line right after them), never by one line. A lead message that
// only holds such a line, or quotes another task block, keeps all its text.
test("handoff messages: a lead message that only holds an EARLIER LEAD MESSAGES line keeps all its text (r1 F1 review probe)", () => {
  const lead = "Fix the cache first.\n\nEARLIER LEAD MESSAGES: /tmp/old.md\n\nThen run tests.";
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: S2_TASK, reply: "done\nVERDICT: DONE" }, { lead, reply: "working" }]);
  ok(f.run());
  const body = f.read("handoff-2-messages.md");
  assert.ok(body.includes("Fix the cache first."), body);
  assert.ok(body.endsWith(entry(2, 2, NO_VERDICT, true, lead)), body);
  assert.ok(!body.includes("(a hand-off brief)"), body);
});

test("handoff messages: other wordings that only look launcher-written keep all their text (r1 F1 sweep)", () => {
  const leads = [
    // the EARLIER line first, with a "## This round" heading after it
    "EARLIER LEAD MESSAGES: /tmp/old.md\n\n## This round\n\nfix D: e.py",
    // the lead's own takeover note: the TAKEOVER line and an EARLIER line, no task block
    "You take over from thread abc; see /tmp/x.md.\n\nEARLIER LEAD MESSAGES: /tmp/old.md\n\n## This round\n\nfix E: f.py",
    // another stage's brief quoted between the markers: not this task, kept
    "Compare with this older brief:\n\n<<<ORIGINAL TASK\nImplement S1: own b.py.\nORIGINAL TASK>>>\n\nthen fix F: g.py",
  ];
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: S2_TASK, reply: "Built.\n\nVERDICT: DONE" }, ...leads.map((lead) => ({ lead, reply: "on it" }))]);
  ok(f.run());
  const body = f.read("handoff-2-messages.md");
  assert.ok(body.endsWith(leads.map((lead, i) => entry(i + 2, i + 2, NO_VERDICT, true, lead)).join("\n")), body);
  // A takeover brief with the lead's text between the task block and an EARLIER line isn't the
  // launcher's layout: only the block holding this task is taken out, every other line stays.
  const g = handoffHome(threeCompactions.slice(0, 3));
  const mixed = `You take over from thread abc; its last report is /x/report.md.\n\n<<<ORIGINAL TASK\n${S2_TASK}\nORIGINAL TASK>>>\n\nAlso fix G.\n\nEARLIER LEAD MESSAGES: /tmp/old.md\n\nfix H`;
  setTurns(g, [{ lead: mixed, reply: "half" }]);
  ok(g.run());
  assert.ok(g.read("handoff-2-messages.md").endsWith(entry(1, 1, NO_VERDICT, true,
    `You take over from thread abc; its last report is /x/report.md.\n\n(the original task: ${IN_BRIEF})\n\nAlso fix G.\n\nEARLIER LEAD MESSAGES: /tmp/old.md\n\nfix H`)), g.read("handoff-2-messages.md"));
  assert.equal(g.sent("message.dispatch")[0].text.split(S2_TASK).length, 2, "the task once");
});

test("handoff messages: a first message that quotes a task block is the task whole, through a chained hand-off (r1 F1 sweep)", () => {
  const task = "Do S3: own c.py. The S1 brief, for reference:\n\n<<<ORIGINAL TASK\nImplement S1: own b.py.\nORIGINAL TASK>>>\n\nVerify: pytest c.";
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: task, reply: "Half of S3." }]);
  setPrompt(f, "fix A");
  ok(f.run());
  const [s] = f.sent("message.dispatch");
  assert.ok(s.text.includes(`<<<ORIGINAL TASK\n${task}\nORIGINAL TASK>>>\n\nEARLIER LEAD MESSAGES: `), s.text);
  assert.ok(f.read("handoff-2-messages.md").endsWith(entry(1, 1, NO_VERDICT, true, `(the original task: ${IN_BRIEF})`)), f.read("handoff-2-messages.md"));
  const g = handoffHome(threeCompactions.slice(0, 3));
  setTurns(g, [{ lead: s.text, reply: "Still half." }]);
  setPrompt(g, "fix B");
  ok(g.run());
  const [t] = g.sent("message.dispatch");
  assert.ok(t.text.includes(`<<<ORIGINAL TASK\n${task}\nORIGINAL TASK>>>\n\nEARLIER LEAD MESSAGES: ${path.join(g.jobDir, "handoff-2-messages.md")}\n\n## This round\n\nfix B`), t.text);
  assert.ok(g.read("handoff-2-messages.md").includes("(a hand-off brief) Earlier lead messages: "), g.read("handoff-2-messages.md"));
});

test("handoff messages: a successor brief behind T3's delegate_task line is still a hand-off brief; that line is kept (r1 F1 sweep)", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: S2_TASK, reply: "Half." }]);
  setPrompt(f, "fix A");
  ok(f.run());
  const [s] = f.sent("message.dispatch");
  const file1 = path.join(f.jobDir, "handoff-2-messages.md");
  const g = handoffHome(threeCompactions.slice(0, 3));
  setTurns(g, [{ lead: `Act as the implementation sub-agent for this task.\n\n${s.text}`, reply: "Still half." }]);
  setPrompt(g, "fix B");
  ok(g.run());
  const [t] = g.sent("message.dispatch");
  assert.equal(t.text.split("<<<ORIGINAL TASK").length, 2, t.text);
  assert.ok(t.text.includes(`<<<ORIGINAL TASK\n${S2_TASK}\nORIGINAL TASK>>>`), t.text);
  // The round as sent (with the worker appendix the launcher adds) follows "Given with it".
  assert.ok(g.read("handoff-2-messages.md").includes(`## Message 1 · turn 1 · ${NO_VERDICT} · PENDING\n\nAct as the implementation sub-agent for this task.\n\n(a hand-off brief) Earlier lead messages: ${file1}. Its PENDING messages were handed on with this brief: they are still pending unless this message's turn ended \`VERDICT: DONE\`.\n\nGiven with it:\n\nfix A\n`), g.read("handoff-2-messages.md"));
  assert.ok(!g.read("handoff-2-messages.md").includes("You take over from"), "no nesting");
});

// Plan 1120 S3 r2 F1: the outer task block is matched with nesting (only whole marker lines count; it
// ends where the depth returns to 0) and the EARLIER line counts only right after it. A task, round or
// findings that quote an earlier generated brief stay whole at every hop; unbalanced markers, or a
// lead's own words before the takeover line, mean the message is not a generated brief: kept whole.
const wrapped = (task) => `<<<ORIGINAL TASK\n${task}\nORIGINAL TASK>>>`;
// One CONTINUE hand-off of a thread whose only lead message is `lead`: what the successor was sent,
// its messages file and that file's path.
function continueHop(lead, round) {
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead, reply: "partial" }]);
  setPrompt(f, round);
  // A round quoting a brief asks for a verdict (its text names `VERDICT: DONE`): the successor gives one.
  fs.appendFileSync(f.preload, `\nglobalThis.fakeT3Outcome = (t) => ({ reply: "reply on " + t.thread_id + "\\n\\nVERDICT: DONE" });\n`);
  ok(f.run());
  return { text: f.sent("message.dispatch")[0].text, body: f.read("handoff-2-messages.md"), file: path.join(f.jobDir, "handoff-2-messages.md") };
}
// Hops from a raw task: at each one the successor holds the task block once and whole, the EARLIER
// line right after it names this hop's messages file and the round follows; message 1 lost nothing (the
// task at hop 1, then a pointer to the previous hop's file with that hop's round).
function chainHops(lead, rounds) {
  const task = lead.trim();
  let prev = null;
  return rounds.map((round, i) => {
    const hop = continueHop(lead, round);
    const block = `${wrapped(task)}\n\nEARLIER LEAD MESSAGES: ${hop.file}\n\n## This round\n\n${round}`;
    assert.equal(hop.text.split(block).length, 2, `hop ${i + 1}: the task block once, then this hop's file:\n${hop.text}`);
    assert.equal(hop.text.indexOf("You take over from"), 0, `hop ${i + 1}: one takeover, at the top:\n${hop.text}`);
    if (i === 0) assert.ok(hop.body.endsWith(entry(1, 1, NO_VERDICT, true, `(the original task: ${IN_BRIEF})`)), hop.body);
    else assert.ok(hop.body.includes(`## Message 1 · turn 1 · ${NO_VERDICT} · PENDING\n\n(a hand-off brief) Earlier lead messages: ${prev.file}. Its PENDING messages were handed on with this brief: they are still pending unless this message's turn ended \`VERDICT: DONE\`.\n\nGiven with it:\n\n${rounds[i - 1]}\n`), `hop ${i + 1}:\n${hop.body}`);
    prev = hop; lead = hop.text;
    return hop;
  });
}

test("recheck probe: quoted earlier handoff inside task survives two hops", () => {
  const task = "Implement the new parser.\n\nReference handoff:\n<<<ORIGINAL TASK\nOld task\nORIGINAL TASK>>>\n\nEARLIER LEAD MESSAGES: /tmp/earlier.md\n\nNow fix the parser and run tests.";
  const f = handoffHome(threeCompactions.slice(0,3)); setTurns(f,[{lead:task,reply:"partial"}]); setPrompt(f,"fix A"); ok(f.run());
  const sent=f.sent("message.dispatch")[0].text;
  const g=handoffHome(threeCompactions.slice(0,3)); setTurns(g,[{lead:sent,reply:"partial"}]); setPrompt(g,"fix B"); ok(g.run());
  const next=g.sent("message.dispatch")[0].text;
  assert.ok(next.includes(`<<<ORIGINAL TASK\n${task}\nORIGINAL TASK>>>`),next);
});

test("handoff messages: the recheck probe's task, three hops: whole, once, this hop's EARLIER file (r2 F1)", () => {
  chainHops("Implement the new parser.\n\nReference handoff:\n<<<ORIGINAL TASK\nOld task\nORIGINAL TASK>>>\n\nEARLIER LEAD MESSAGES: /tmp/earlier.md\n\nNow fix the parser and run tests.", ["fix A", "fix B", "fix C"]);
});

test("handoff messages: a task quoting a full earlier generated brief (its EARLIER line too), three hops (r2 F1)", () => {
  const old = continueHop(S2_TASK, "fix the old stage").text;
  assert.ok(old.includes(`${wrapped(S2_TASK)}\n\nEARLIER LEAD MESSAGES: `), old);
  chainHops(`Do S4: own d.py. The S2 hand-off, for reference:\n\n${old}\n\nVerify: pytest d.`, ["fix A", "fix B", "fix C"]);
});

test("handoff messages: a task quoting two generated briefs, three hops (r2 F1)", () => {
  const a = continueHop(S2_TASK, "fix the S2 stage").text, b = continueHop("Implement S3: own c.py.", "fix the S3 stage").text;
  chainHops(`Merge what these two hand-offs left:\n\n${a}\n\nand\n\n${b}\n\nThen run all tests.`, ["fix A", "fix B", "fix C"]);
});

test("handoff messages: a round after the EARLIER line that quotes a brief stays whole; the task stays this one (r2 F1)", () => {
  const quoted = continueHop("Implement S1: own b.py.", "fix the S1 stage").text;
  const round = `Fix F1: the header. The S1 hand-off, for comparison:\n\n${quoted}\n\nKeep its format.`;
  const [, second] = chainHops(S2_TASK, [round, "fix C"]);
  assert.ok(!second.text.includes("Implement S1"), "the quoted brief goes in the messages file, not the task");
  assert.ok(second.body.includes(`Given with it:\n\n${round}\n`), second.body);
});

test("handoff messages: unbalanced markers in a task: never a generated brief, the text kept whole (r2 F1)", () => {
  for (const stray of ["ORIGINAL TASK>>>", "<<<ORIGINAL TASK"]) {
    const task = `Implement S5: own e.py. A marker line on its own, as written:\n${stray}\n\nVerify: pytest e.`;
    const first = continueHop(task, "fix A");
    assert.ok(first.text.includes(`${wrapped(task)}\n\nEARLIER LEAD MESSAGES: ${first.file}\n\n## This round\n\nfix A`), first.text);
    assert.ok(first.body.endsWith(entry(1, 1, NO_VERDICT, true, `(the original task: ${IN_BRIEF})`)), first.body);
    // That brief's markers don't balance, so the next hop takes it whole as the task: nothing cut.
    const second = continueHop(first.text, "fix B");
    assert.ok(second.text.includes(`${wrapped(first.text.trim())}\n\nEARLIER LEAD MESSAGES: ${second.file}\n\n## This round\n\nfix B`), second.text);
    assert.ok(second.body.endsWith(entry(1, 1, NO_VERDICT, true, `(the original task: ${IN_BRIEF})`)), second.body);
  }
  // A brief's own task block balanced but a stray close line after the EARLIER line: kept whole too.
  const f = continueHop(S2_TASK, "fix A");
  const lead = `${f.text}\n\nORIGINAL TASK>>>`;
  const g = continueHop(lead, "fix B");
  assert.ok(g.text.includes(wrapped(lead.trim())), g.text);
});

test("handoff messages: a lead's own words before a generated brief: the message kept whole, nested once, not again (r2 F1)", () => {
  const brief = continueHop(S2_TASK, "fix A").text;
  const lead = `Lead note: work in the worktree.\n\n${brief}`;
  const [, third] = chainHops(lead, ["fix B", "fix C"]);
  assert.equal(third.text.split("<<<ORIGINAL TASK").length, 3, `the lead's message once, with the brief it holds:\n${third.text}`);
});

test("handoff messages: a brief from before S3 whose task quotes a block: the task whole, only its outer block replaced; unbalanced markers kept whole (r2 F1)", () => {
  const task = "Do S3: own c.py. The S1 brief, for reference:\n\n<<<ORIGINAL TASK\nImplement S1: own b.py.\nORIGINAL TASK>>>\n\nVerify: pytest c.";
  const old = `You take over from thread abc; its last report is /x/report.md.\n\nIts original task:\n\n${wrapped(task)}\n\nLAST ROUND\n\nfix the header`;
  const unbalanced = `Again, as sent:\n\n${wrapped(task)}\nORIGINAL TASK>>>\n\nthen fix G.`;
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: old, reply: "half" }, { lead: unbalanced, reply: "still half" }]);
  setPrompt(f, "fix H");
  ok(f.run());
  const text = f.sent("message.dispatch")[0].text, body = f.read("handoff-2-messages.md");
  assert.equal(text.split(`${wrapped(task)}\n\nEARLIER LEAD MESSAGES: ${path.join(f.jobDir, "handoff-2-messages.md")}\n\n## This round\n\nfix H`).length, 2, text);
  assert.ok(body.endsWith(entry(1, 1, NO_VERDICT, true, `You take over from thread abc; its last report is /x/report.md.\n\nIts original task:\n\n(the original task: ${IN_BRIEF})\n\nLAST ROUND\n\nfix the header`)
    + "\n" + entry(2, 2, NO_VERDICT, true, unbalanced)), body);
});

// Plan 1120 S3 r1 F2: without the old thread's lead messages a hand-off would start a successor with
// only the new round. A failed read, none, or an empty first one: nothing saved, settled, written or
// started; exit 1 (exit_code 1), as a refused settle.
const failMessagesRead = `\nimport child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';\nconst baseExec=child.execFileSync; child.execFileSync=function(cmd,args,...rest){if(args?.[3]?.includes('select message_id, run_id, created_at, payload_json')) throw new Error('simulated read failure'); return baseExec.call(this,cmd,args,...rest)}; syncBuiltinESMExports();\n`;
function assertNoHandoff(f, r, why) {
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`handoff: lead messages of ${longThread}: ${why}; nothing settled or started.`), r.stderr);
  assert.ok(f.read("run.log").includes(`handoff: lead messages of ${longThread}: ${why}`), f.read("run.log"));
  assert.equal(f.sent("message.dispatch").length, 0, JSON.stringify(f.sent("message.dispatch").map((x) => x.text)));
  assert.equal(f.sent("thread.create").length, 0);
  assert.equal(f.sent("thread.settle").length, 0, "the old thread isn't settled");
  assert.deepEqual(fs.readdirSync(f.jobDir).filter((n) => /^handoff-/.test(n)), []);
  assert.equal(f.read("exit_code"), "1\n");
  assert.equal(f.read("report.md"), "old report", "nothing saved over the report");
  assert.equal(f.read("thread_id"), longThread);
}
test("handoff: a failed lead-message read stops the hand-off before anything changes; exit 1 (r1 F2 review probe)", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  setTurns(f, [{ lead: S2_TASK, reply: "working" }, { lead: "fix lost work", reply: "partial" }]);
  fs.appendFileSync(f.preload, failMessagesRead);
  const r = f.run();
  assertNoHandoff(f, r, "couldn't read them (simulated read failure)");
});

test("handoff: no lead message, or an empty first one, stops the hand-off too (r1 F2)", () => {
  const f = handoffHome(threeCompactions); // the old thread has a reply and no lead message
  assertNoHandoff(f, f.run(), "it has none");
  const g = handoffHome(threeCompactions.slice(0, 3));
  setTurns(g, [{ lead: "  \n", reply: "?" }, { lead: "fix A", reply: "partial" }]);
  assertNoHandoff(g, g.run(), "its first message is empty");
  // A reviewer's hand-off reads no lead messages, so it still goes ahead.
  const h = handoffHome(threeCompactions);
  fs.appendFileSync(h.preload, `\nglobalThis.fakeT3Outcome = () => ({ reply: "F1 fixed.\\n\\nVERDICT: APPROVE" });\n`);
  setPrompt(h, "RECHECK ONLY. F1 only");
  ok(h.run());
  assert.equal(h.sent("message.dispatch").length, 1);
  assert.notEqual(h.sent("message.dispatch")[0].threadId, longThread);
});

test("handoff: a worker's successor is told its last turn's state; only VERDICT: DONE is finished (final F1)", () => {
  // A completed turn ending VERDICT: DONE is the only "finished".
  const d = handoffHome(threeCompactions.slice(0, 3));
  setTurns(d, [{ lead: S2_TASK, reply: "F1 fixed.\n\nVERDICT: DONE" }]);
  ok(d.run());
  assert.ok(d.sent("message.dispatch")[0].text.includes("Its last turn completed with `VERDICT: DONE`."));
  // A reply that only mentions the verdict mid-line isn't finished (final r3 F1).
  const no = handoffHome(threeCompactions.slice(0, 3));
  setTurns(no, [{ lead: S2_TASK, reply: "Retry still fails. I cannot give VERDICT: DONE" }]);
  ok(no.run());
  assert.ok(no.sent("message.dispatch")[0].text.includes("Its last turn ended without `VERDICT: DONE`: its work is not finished"));
  assert.ok(no.read("handoff-2-messages.md").includes(`· ${NO_VERDICT} · PENDING`));
});

test("handoff: HANDOFF_COMPACTIONS doesn't turn a reviewer into a worker (final F5)", () => {
  const f = handoffHome(threeCompactions);
  const d = f.db(); d.messages.unshift({ thread_id: longThread, message_id: "first", run_id: `run:${longThread}:1`, role: "user", text: "REVIEW ONLY. the stage", created_at: "2026-10-10T00:00:00Z" }); fs.writeFileSync(path.join(path.dirname(f.prompt), "t3.json"), JSON.stringify(d));
  fs.writeFileSync(f.prompt, "RECHECK ONLY. F1 only");
  f.run({ HANDOFF_COMPACTIONS: "3" });
  const [s] = f.sent("message.dispatch");
  assert.ok(s && s.threadId !== longThread, "handed off");
  assert.ok(!s.text.includes("ORIGINAL TASK") && !s.text.includes("git diff"), s.text);
});

test("handoff: an Opus review (RECHECK ONLY brief or a -review JOB) keeps a reviewer's 3", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  fs.writeFileSync(f.prompt, "RECHECK ONLY. F1 again.\n");
  ok(f.run());
  assert.equal(f.sent("thread.create").length, 0, "the reviewer continues at 2 compactions");
});

test("handoff: HANDOFF_COMPACTIONS=3 keeps a twice-compacted worker on its thread", () => {
  const f = handoffHome(threeCompactions.slice(0, 3));
  ok(f.run({ HANDOFF_COMPACTIONS: "3" }));
  assert.equal(f.sent("thread.create").length, 0);
  assert.deepEqual(f.sent("message.dispatch").map((s) => s.threadId), [longThread]);
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
  setTurns(f, [{ lead: "Implement S2: own a.py.", reply: `reply on ${longThread}` }]);
  ok(f.run());
  assert.deepEqual(f.db().reportAtStart, [`reply on ${longThread}`]);
});

test("handoff: a quota retry keeps the takeover message; no TITLE keeps the old title", () => {
  const f = handoffHome(threeCompactions);
  f.oldThread({ title: "[gemini-flash] Look up the docs", model_selection_json: JSON.stringify({ instanceId: "antigravity", model: "gemini-3.8-flash-high" }) });
  setTurns(f, [{ lead: "Look up the docs for X.", reply: "Half." }]);
  ok(f.run({ FAKE_QUOTA: "1", PLAN: "/p/plan.md", TITLE: "" }));
  const files = fs.readdirSync(f.jobDir).filter((n) => /^handoff-\d+-messages\.md$/.test(n));
  assert.deepEqual(files, ["handoff-3-messages.md"], "one messages file for one hand-off");
  const created = f.sent("thread.create");
  assert.deepEqual(created.map((c) => c.modelSelection.model), ["gemini-3.8-flash-high", "claude-haiku-5-5"]);
  assert.equal(created[0].title, "[gemini-flash] Look up the docs");
  const starts = f.sent("message.dispatch");
  assert.equal(starts.length, 2);
  for (const s of starts) assert.ok(s.text.startsWith(`You take over from thread ${longThread};`) && s.text.includes("PLAN: /p/plan.md")
    && s.text.includes(`EARLIER LEAD MESSAGES: ${path.join(f.jobDir, files[0])}\n`), s.text);
  assert.equal(f.read("thread_ids_prev"), `${longThread}\n`, "the old thread is recorded once");
});

test("--compactions: v2 compaction items and pre-0.1.0 activity rows both count", () => {
  const f = handoffHome(threeCompactions.slice(0, 3), ["2026-10-17T00:39:39Z"]);
  const r = ok(f.run({}, ["--compactions", longThread]));
  assert.equal(r.stdout.trim(), "3");
});

test("handoff: 1 old compaction + 1 since 0.1.0 reach a worker's bar", () => {
  const f = handoffHome(threeCompactions.slice(0, 2), ["2026-10-17T00:39:39Z"]);
  setTurns(f, [{ lead: "Implement S2: own a.py.", reply: `reply on ${longThread}` }]);
  ok(f.run());
  const [s] = f.sent("message.dispatch");
  assert.notEqual(s.threadId, longThread);
  assert.ok(f.read("run.log").includes("(2 compactions)"));
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

// New stage, fresh reviewer: a sol62/astra thread ATTACHed with CONTINUE under a
// JOB other than the one whose job dir records it starts a fresh thread; the same JOB continues.
const sol62Sel = JSON.stringify({ instanceId: "codex", model: "gpt-6.2-sol", options: [{ id: "reasoningEffort", value: "medium" }, { id: "serviceTier", value: "default" }] });
function reviewerHome(rows = []) {
  const f = handoffHome(rows);
  f.oldThread({ title: "[sol62] Review S1", model_selection_json: sol62Sel });
  const readJob = (job, file) => { try { return fs.readFileSync(path.join(f.jobs, job, file), "utf8"); } catch { return ""; } };
  const review = (job, extra = {}) => f.run({ JOB: job, TITLE: "Review S2", REPORT_FILE: path.join(f.jobs, job, "report.md"), ...extra }, ["sol62", f.prompt]);
  return { ...f, readJob, review };
}

test("new stage: a sol62 thread recorded under another JOB gets a fresh reviewer thread, printed and logged", () => {
  const f = reviewerHome();
  const r = ok(f.review("p2"));
  const [created] = f.sent("thread.create");
  assert.ok(created, "a fresh thread");
  assert.equal(created.modelSelection.model, "gpt-6.2-sol");
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

// A review turn that ends without its VERDICT line is not the report (a reviewer stopped to wait on
// a helper, was woken by it and approved; the job had already saved the no-verdict turn and exited).
// The first turn ends "verdict follows"; FAKE_WAKE=self then has the helper wake the thread into a
// turn of its own, FAKE_WAKE=none never does, so only the nudge brings the answer.
const wakePreload = `
const wakeFs = await import("node:fs");
const prevWake = globalThis.fakeT3Outcome;
let turns = 0;
globalThis.fakeT3Outcome = (thread, command, db) => {
  if (++turns > 1) return { reply: "nudged packet\\n\\nVERDICT: APPROVE" };
  if (process.env.FAKE_WAKE === "self") setTimeout(() => {
    const d = JSON.parse(wakeFs.readFileSync(process.env.FAKE_T3, "utf8"));
    const ordinal = Math.max(...d.runs.filter((r) => r.thread_id === thread.thread_id).map((r) => r.ordinal)) + 1;
    const run_id = "wake:" + ordinal, at = new Date().toISOString();
    d.runs.push({ run_id, thread_id: thread.thread_id, ordinal, status: "completed", requested_at: at, completed_at: at });
    d.messages.push({ thread_id: thread.thread_id, message_id: run_id + ":reply", run_id, role: "assistant", text: "woken packet\\n\\nVERDICT: APPROVE", created_at: at });
    wakeFs.writeFileSync(process.env.FAKE_T3, JSON.stringify(d));
  }, 2000);
  return { ...prevWake(thread, command, db), reply: process.env.FAKE_FIRST ?? "Scratch tests still running; verdict follows." };
};
`;
function wakeHome(brief = "RECHECK. End with VERDICT: APPROVE or VERDICT: REVISE.") {
  const f = reviewerHome();
  fs.appendFileSync(f.preload, wakePreload);
  fs.writeFileSync(f.prompt, brief);
  return f;
}

test("verdict: a reviewer woken by its helper after a no-verdict turn: that turn is the report, no nudge", () => {
  const f = wakeHome();
  const r = ok(f.review("p1", { FAKE_WAKE: "self", VERDICT_WAIT_MIN: "1" }));
  assert.equal(f.read("report.md"), "woken packet\n\nVERDICT: APPROVE");
  assert.equal(f.sent("message.dispatch").length, 1, "no nudge sent");
  assert.ok(!r.stderr.includes("asked it to finish"), r.stderr);
  assert.match(f.read("run.log"), /no verdict in/);
});

test("verdict: a reviewer that stays idle without a verdict is asked once, and its answer is the report", () => {
  const f = wakeHome();
  const r = ok(f.review("p1", { FAKE_WAKE: "none", VERDICT_WAIT_MIN: "0.1" }));
  const sends = f.sent("message.dispatch");
  assert.equal(sends.length, 2);
  assert.match(sends[1].text, /^Your last turn ended without a verdict/);
  assert.equal(sends[1].threadId, longThread);
  assert.equal(f.read("report.md"), "nudged packet\n\nVERDICT: APPROVE");
  assert.match(r.stderr, /reviewer ended a turn without a verdict: asked it to finish/);
});

// A worker that ends its turn only saying it waits (tests in the background, a restart-idle loop,
// replays) has not answered; the job waits for its background job's wake-up instead of settling the
// thread, which would stop the job.
test("waiting: a worker (no verdict asked) ending on \"I'm waiting for …\" is woken by its job: that turn is the report", () => {
  const f = wakeHome("Fix the follow-up text. Restart the server once idle, then report.");
  const r = ok(f.review("p1", { FAKE_WAKE: "self", VERDICT_WAIT_MIN: "1", FAKE_FIRST: "Tests pass.\n\nI'm waiting for the backend to come back up and idle." }));
  assert.equal(f.read("report.md"), "woken packet\n\nVERDICT: APPROVE");
  assert.equal(f.sent("message.dispatch").length, 1, "no nudge sent");
  assert.deepEqual(f.sent("thread.settle").map((c) => c.threadId), [longThread], "settled once, after the wake-up turn");
  assert.match(f.read("run.log"), /waiting reply in/);
  assert.ok(!r.stderr.includes("asked it to finish"), r.stderr);
});

test("waiting: a DONE/BLOCKED worker ending \"When the replays finish, I'll …\" that stays idle is asked once, in worker words", () => {
  const f = wakeHome("Build S2. Last line `VERDICT: DONE` or `VERDICT: BLOCKED`.");
  const r = ok(f.review("p1", { FAKE_WAKE: "none", VERDICT_WAIT_MIN: "0.1", FAKE_FIRST: "Ruff is clean.\n\nOnce the test runs are done I'll tally the hosts, then write the packet." }));
  const sends = f.sent("message.dispatch");
  assert.equal(sends.length, 2);
  assert.match(sends[1].text, /^Your last turn ended on waiting/);
  assert.match(sends[1].text, /VERDICT: DONE/);
  assert.doesNotMatch(sends[1].text, /APPROVE/);
  assert.equal(f.read("report.md"), "nudged packet\n\nVERDICT: APPROVE");
  assert.match(r.stderr, /ended a turn on waiting reply: asked it to finish/);
});

test("waiting: \"Full suite is running in the background.\", \"Awaiting task completion.\" and an aside wait for the wake-up too", () => {
  for (const last of ["Full suite is running in the background.", "Tests running in the background. I'll report when done.", "I'll report when the tests finish.",
    "The build is still running in the background.", "Playwright running in the background; I'll post the packet once it lands.", "I'll send the full report as soon as pytest is done.",
    "Three helpers are running in the background. Their reports are not in yet.", "explorers still running in background", "Two Gemini explorers still running in background.", "Suite still running in background.",
    "Two reviewers are running in the background. Their reports are not in yet.", "The reviewer is still running in the background.", "Both delegates running in the background.",
    "Four workers are running in background; their packets come next.", "The subagents are still running in the background.", "Child threads running in the background.",
    "Task launched. Awaiting task completion.", "Waiting on the idle loop (the user is busy; restart only once idle)."]) {
    const f = wakeHome("Restart the server once idle and report.");
    ok(f.review("p1", { FAKE_WAKE: "self", VERDICT_WAIT_MIN: "1", FAKE_FIRST: last }));
    assert.equal(f.read("report.md"), "woken packet\n\nVERDICT: APPROVE", last);
    assert.equal(f.sent("message.dispatch").length, 1, last);
  }
});

test("waiting: a worker brief that only mentions APPROVE gets the worker nudge, not the review one", () => {
  const f = wakeHome("Implement the APPROVE button on drafts, then report.");
  ok(f.review("p1", { FAKE_WAKE: "none", VERDICT_WAIT_MIN: "0.1", FAKE_FIRST: "Now waiting for the Playwright run to finish." }));
  const sends = f.sent("message.dispatch");
  assert.equal(sends.length, 2);
  assert.match(sends[1].text, /^Your last turn ended on waiting/);
  assert.doesNotMatch(sends[1].text, /VERDICT/);
});

test("waiting: a brief that only mentions \"VERDICT:\" without a value asks for no verdict line", () => {
  const f = wakeHome("Implement the VERDICT: label, then report.");
  ok(f.review("p1", { FAKE_WAKE: "none", VERDICT_WAIT_MIN: "0.1", FAKE_FIRST: "Implemented the label." }));
  assert.equal(f.sent("message.dispatch").length, 1);
  assert.equal(f.read("report.md"), "Implemented the label.");
});

test("waiting: a finished worker report that merely mentions waiting on a person, a decision or a service is the report at once", () => {
  for (const last of ["Changes are uncommitted, waiting for your review.", "Committed 3 files; the nightly sync keeps its own schedule.",
    "Embeddings haven't been run and are still waiting on a separate GO.", "I'm waiting for your go.", "Ready to merge; awaiting Sam's decision on F2.",
    "I'm waiting for Sam to pick a name.", "Changes complete. The queue is still running in the background.", "Done. The sync service is running in the background as before.",
    "Done. The indexer still runs in background mode.", "I'll report back once you confirm the copy.", "Optional: a \"queue still waiting\" banner when a reply arrives.", "Sidebar groups: Running, Waiting, Idle, Done."]) {
    const f = wakeHome("Rename the setting and report what changed.");
    ok(f.review("p1", { FAKE_WAKE: "none", VERDICT_WAIT_MIN: "0.1", OWNER_NAME: "Sam", FAKE_FIRST: `Renamed in 2 files.\n\n${last}` }));
    assert.equal(f.sent("message.dispatch").length, 1, last);
    assert.equal(f.read("report.md"), `Renamed in 2 files.\n\n${last}`);
  }
});

// Review budget (orchestrate §9): each review launch that sends a turn is a round in the job dir's
// `rounds`; past REVIEW_ROUNDS nothing is sent and the run exits 3. A review is known by its brief,
// its JOB name or an earlier counted round, so free-form recheck briefs count too.
test("review budget: rounds 1-3 go (a free-form recheck counts), the 4th sends nothing and exits 3", () => {
  const f = reviewerHome();
  fs.writeFileSync(f.prompt, "RECHECK ONLY. F1 open.");
  ok(f.review("p1"));
  fs.writeFileSync(f.prompt, "# Stage 2 recheck 2\n\nF1 fixed.");
  ok(f.review("p1"));
  ok(f.review("p1"));
  assert.equal(f.readJob("p1", "rounds"), "3\n");
  const before = f.sent("message.dispatch").length;
  const r = f.review("p1");
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /review budget: round 4 > 3 for p1; nothing sent\..*REVIEW_ROUNDS=5/);
  assert.equal(f.sent("message.dispatch").length, before, "no turn");
  assert.equal(f.readJob("p1", "exit_code"), "3\n");
  assert.ok(ok(f.run({ JOB: "p1", REVIEW_ROUNDS: "5", REPORT_FILE: path.join(f.jobs, "p1", "report.md") }, ["sol62", f.prompt])));
  assert.equal(f.readJob("p1", "rounds"), "4\n", "REVIEW_ROUNDS=5 allows round 4");
});

test("review budget: a -review/-final JOB counts with any brief; a worker job doesn't", () => {
  const f = reviewerHome();
  fs.writeFileSync(f.prompt, "FINAL REVIEW ONLY (all stages).");
  for (const job of ["x-final-sol", "x-s1-review", "x-s2-recheck1"]) { ok(f.review(job)); assert.equal(f.readJob(job, "rounds"), "1\n", job); }
  fs.writeFileSync(f.prompt, "fix finding 2");
  for (const job of ["x-s1-impl", "x-finalize"]) { ok(f.review(job)); assert.equal(f.readJob(job, "rounds"), "", job); }
});

// Provider-error turns (plan 1120 S3b, chk_335c542350db4fa8): a launch that ends failed with a
// provider error and no reply gives its round back; 3 such turns stop the job. FAKE_PROVIDER_ERROR
// fails every new turn (not /compact) with that message; FAKE_PROVIDER_REPLY also stores a reply first.
const FLAGGED = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. Our usage policies apply to all requests; repeated flags on one conversation may end it early. Request id req_0123456789abcdef.";
const providerPreload = `
const base = globalThis.fakeT3Outcome;
globalThis.fakeT3Outcome = (thread, command, db) => process.env.FAKE_PROVIDER_ERROR && command.text !== "/compact"
  ? { error: { class: "provider_error", message: process.env.FAKE_PROVIDER_ERROR }, ...(process.env.FAKE_PROVIDER_REPLY ? { reply: process.env.FAKE_PROVIDER_REPLY } : {}) }
  : base(thread, command, db);
`;
function providerHome() {
  const f = reviewerHome();
  fs.appendFileSync(f.preload, providerPreload);
  fs.writeFileSync(f.prompt, "RECHECK ONLY. F1 open.");
  return f;
}
const failedLine = (n) => `round ${n} not counted: provider error: ${FLAGGED.slice(0, 160)}`;

test("review budget: a provider-error turn with no reply isn't a round", () => {
  const f = providerHome();
  const r = f.review("p1", { FAKE_PROVIDER_ERROR: FLAGGED });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(f.sent("message.dispatch").length, 1, "the turn was sent");
  assert.equal(fs.existsSync(path.join(f.jobs, "p1", "rounds")), false, "no rounds file before, none after");
  const failed = f.readJob("p1", "rounds_failed").split("\n").filter(Boolean);
  assert.equal(failed.length, 1, failed.join("\n"));
  assert.ok(failed[0].endsWith(` ${longThread} ${failedLine(1)}`), failed[0]);
  assert.ok(f.readJob("p1", "run.log").includes(failedLine(1)), f.readJob("p1", "run.log"));
  assert.ok(r.stderr.includes(failedLine(1)), r.stderr);
  // Case 2: the next launch completes and is round 1; rounds_failed stays as it was.
  ok(f.review("p1"));
  assert.equal(f.readJob("p1", "rounds"), "1\n");
  assert.equal(f.readJob("p1", "rounds_failed").split("\n").filter(Boolean).length, 1);
  // A counted round stays as it was ("1\n" stays "1\n").
  assert.equal(f.review("p1", { FAKE_PROVIDER_ERROR: FLAGGED }).status, 1);
  assert.equal(f.readJob("p1", "rounds"), "1\n");
  assert.ok(f.readJob("p1", "rounds_failed").trim().split("\n")[1].endsWith(failedLine(2)), f.readJob("p1", "rounds_failed"));
});

test("review budget: a turn that replied and then failed still counts", () => {
  const f = providerHome();
  assert.notEqual(f.review("p1", { FAKE_PROVIDER_ERROR: FLAGGED, FAKE_PROVIDER_REPLY: "Half a review: F1 still open." }).status, 0);
  assert.equal(f.readJob("p1", "rounds"), "1\n");
  assert.equal(fs.existsSync(path.join(f.jobs, "p1", "rounds_failed")), false);
  // A usage limit isn't a provider error: the go-around handles it, and nothing is written here.
  const g = providerHome();
  g.review("p1", { FAKE_PROVIDER_ERROR: "You've hit your usage limit. Resets 5pm." });
  assert.equal(fs.existsSync(path.join(g.jobs, "p1", "rounds_failed")), false);
});

test("review budget: 3 provider-error turns refuse the 4th send with exit 3", () => {
  const f = providerHome();
  for (let n = 0; n < 3; n++) assert.equal(f.review("p1", { FAKE_PROVIDER_ERROR: FLAGGED }).status, 1);
  assert.equal(fs.existsSync(path.join(f.jobs, "p1", "rounds")), false, "a job whose every round failed has no rounds file");
  const before = f.sent("message.dispatch").length;
  assert.equal(before, 3);
  // rounds_failed alone keeps it a review (its brief needn't say so).
  fs.writeFileSync(f.prompt, "Look again at F1.");
  const r = f.review("p1");
  const line = "3 provider-error turns on p1: start a fresh review (new JOB) or another model, or write closed.md";
  assert.equal(r.status, 3, r.stderr);
  assert.ok(r.stderr.includes(line), r.stderr);
  assert.ok(f.readJob("p1", "run.log").includes(line));
  assert.equal(f.sent("message.dispatch").length, before, "nothing sent");
  assert.equal(f.readJob("p1", "exit_code"), "3\n");
  // An uncapped Opus review stops the same way.
  assert.equal(f.run({ JOB: "p1", REPORT_FILE: path.join(f.jobs, "p1", "report.md") }, ["opus", f.prompt]).status, 3);
  assert.equal(f.sent("message.dispatch").length, before);
});
