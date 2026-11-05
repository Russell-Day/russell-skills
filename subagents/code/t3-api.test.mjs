// node --test subagents/code/t3-api.test.mjs
import "./testdata/use-test-accounts.mjs"; // first: fixed test accounts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claude } from "./accounts.mjs";
import { abandonThread, createMainThread, currentThread, getThread, interruptThread, isWorker, jobThreadIds, mainModelSelection, orchestratorArgs, projectFor, renameThread, sendMessage, snoozeThread, workerThreadTitle } from "./t3-api.mjs";

test("TITLE worker: the title is the fix (with a model hint), never \"[model] job\"", () => {
  assert.equal(workerThreadTitle({ model: "opus", job: "p65-s3-impl", title: "Board lanes, priority tags" }), "[opus] Board lanes, priority tags");
  assert.equal(workerThreadTitle({ model: "opus", job: "p65-s3-impl", title: "Board lanes", attempt: 2 }), "[opus] Board lanes (retry 1)");
  assert.equal(workerThreadTitle({ model: "sol61", job: "p65-s3-review" }), "[sol61] p65-s3-review");
  assert.equal(workerThreadTitle({ model: "sol61", job: "p65-s3-review", title: "  " }), "[sol61] p65-s3-review");
});

test("isWorker: \"[model] job\" title, or a job dir that recorded the thread (thread_id or threads)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-"));
  fs.mkdirSync(path.join(root, "p65-s3-impl"));
  fs.writeFileSync(path.join(root, "p65-s3-impl", "thread_id"), "t-latest\n");
  fs.writeFileSync(path.join(root, "p65-s3-impl", "threads"), "t-first\nt-latest\n");
  fs.mkdirSync(path.join(root, "no-thread-yet"));
  const ids = jobThreadIds([root, path.join(root, "missing-root")]);
  assert.deepEqual([...ids].sort(), ["t-first", "t-latest"]);
  assert.equal(isWorker("t-latest", "[opus] Board lanes", ids), true); // TITLE worker, known by its job dir
  assert.equal(isWorker("t-first", "[opus] Board lanes", ids), true); // an earlier retry thread of that job
  assert.equal(isWorker("main", "[opus] old-style job", ids), true);
  assert.equal(isWorker("main", "Board lanes", ids), false); // a main thread named like a fix
  assert.equal(isWorker("main", "Triaging: 3 new items", ids), false);
  assert.equal(isWorker("thread:delegated-task:command%3Aabc", "Port the adapter", ids), true); // a delegate_task child
});

test("currentThread: the caller's thread from its Claude Code or Codex session id", () => {
  const rows = { "claudeAgent:abc": [{ thread_id: "claude-thread" }], "codex:xyz": [{ thread_id: "codex-thread" }], "claudeAgent:two": [{ thread_id: "a" }, { thread_id: "b" }] };
  const query = (_sql, [provider, like]) => rows[`${provider}:${like.slice(1, -1)}`] ?? [];
  assert.equal(currentThread({ CLAUDE_CODE_SESSION_ID: "abc" }, query), "claude-thread");
  assert.equal(currentThread({ CODEX_THREAD_ID: "xyz", CLAUDE_CODE_SESSION_ID: "abc" }, query), "codex-thread");
  assert.equal(currentThread({ CLAUDE_CODE_SESSION_ID: "two" }, query), null); // ambiguous: no guess
  assert.equal(currentThread({}, query), null);
});

test("renameThread sends T3's thread.metadata.update with the title", async () => {
  const sent = [];
  assert.equal(await renameThread("t1", "  Board lanes, priority tags ", async (c) => sent.push(c)), "Board lanes, priority tags");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "thread.metadata.update");
  assert.equal(sent[0].threadId, "t1");
  assert.equal(sent[0].title, "Board lanes, priority tags");
  assert.match(sent[0].commandId, /^[0-9a-f-]{36}$/);
  await assert.rejects(renameThread("t1", " ", async (c) => sent.push(c)), /non-empty title/);
  assert.equal(sent.length, 1);
});

test("orchestratorArgs: title and brief, --model/--effort in any order, defaults opus medium", () => {
  assert.deepEqual(orchestratorArgs(["Round 4: board lanes", "brief.md"]), { title: "Round 4: board lanes", briefFile: "brief.md", model: "opus", effort: "high" });
  assert.deepEqual(orchestratorArgs(["--effort", "high", "T", "b.md", "--model", "fable"]), { title: "T", briefFile: "b.md", model: "fable", effort: "high" });
  for (const bad of [[], ["T"], ["  ", "b.md"], ["T", "b.md", "extra"], ["T", "b.md", "--model"]]) assert.throws(() => orchestratorArgs(bad), /usage|needs a value/);
});

test("mainModelSelection: the orchestrator profile, never the worker profile", () => {
  assert.deepEqual(mainModelSelection(), { instanceId: claude.t3Instance, model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }, { id: "fastMode", value: false }] });
  assert.deepEqual(mainModelSelection("fable", "high"), { instanceId: claude.t3Instance, model: "claude-fable-5-1", options: [{ id: "effort", value: "high" }] });
  assert.notEqual(mainModelSelection().instanceId, claude.t3WorkerInstance);
  assert.throws(() => mainModelSelection("gpt"), /--model is/);
});

test("projectFor: the first root with a T3 project", () => {
  const query = () => [{ project_id: "p-app", workspace_root: "/work/app" }, { project_id: "p-skills", workspace_root: "/work/russell-skills/" }];
  assert.equal(projectFor(["/nowhere", "/work/russell-skills"], query), "p-skills");
  assert.throws(() => projectFor(["/nowhere"], query), /no T3 project for \/nowhere/);
});

test("createMainThread: create, then first message, never pinned; resume skips what happened; pin only when asked", async () => {
  const sent = [];
  const send = async (c) => { sent.push(c); };
  const sel = mainModelSelection();
  const args = { threadId: "t1", messageId: "m1", projectId: "p1", title: "Round 4", text: "the brief", modelSelection: sel };
  await createMainThread(args, { send, query: () => { throw new Error("no reads on a fresh create"); } });
  assert.deepEqual(sent.map((c) => c.type), ["thread.create", "message.dispatch"]);
  assert.equal(sent[0].title, "Round 4");
  assert.equal(sent[0].projectId, "p1");
  assert.deepEqual(sent[0].modelSelection, sel);
  assert.deepEqual([sent[1].messageId, sent[1].text, sent[1].createdBy, sent[1].creationSource, sent[1].dispatchMode], ["m1", "the brief", "agent", "server", { type: "start_immediately" }]);
  assert.deepEqual(sent[1].modelSelection, sel);
  const resumeWith = async (row, hasMessage, extra = {}) => {
    sent.length = 0;
    await createMainThread({ ...args, resume: true, ...extra }, { send, query: (sql) => (sql.includes("pinned_at") ? (row ? [row] : []) : hasMessage ? [{ 1: 1 }] : []) });
    return sent.map((c) => c.type);
  };
  assert.deepEqual(await resumeWith(null, false), ["thread.create", "message.dispatch"]);
  assert.deepEqual(await resumeWith({ pinned_at: null }, false), ["message.dispatch"]);
  assert.deepEqual(await resumeWith({ pinned_at: null }, true), []);
  // A hand-off carrying the user's own pin.
  assert.deepEqual(await resumeWith(null, false, { pin: true }), ["thread.create", "thread.pin", "message.dispatch"]);
  assert.deepEqual(await resumeWith({ pinned_at: null }, false, { pin: true }), ["thread.pin", "message.dispatch"]);
  assert.deepEqual(await resumeWith({ pinned_at: "2026-10-08T10:00:00Z" }, true, { pin: true }), []);
});

test("sendMessage: message.dispatch with T3's required keys; auto steers or queues, queue waits, start starts", async () => {
  const sent = [];
  const send = async (c) => { sent.push(c); };
  const id = await sendMessage("t1", "hello", {}, send);
  await sendMessage("t1", "later", { mode: "queue", createdBy: "agent" }, send);
  await sendMessage("t1", "go", { mode: "start", messageId: "m9" }, send);
  assert.equal(sent[0].messageId, id);
  for (const key of ["commandId", "createdBy", "creationSource", "threadId", "messageId", "text", "attachments", "dispatchMode"]) assert.ok(key in sent[0], key);
  assert.deepEqual(sent.map((c) => [c.type, c.text, c.createdBy, c.dispatchMode.type, c.deliveryIntent]),
    [["message.dispatch", "hello", "agent", "start_immediately", "auto"], ["message.dispatch", "later", "agent", "queue_after_active", undefined], ["message.dispatch", "go", "agent", "start_immediately", undefined]]);
  // A send that stands for the user says so; it is still a server send, never their typing.
  await sendMessage("t1", "continue", { createdBy: "user" }, send);
  assert.deepEqual([sent[3].createdBy, sent[3].creationSource], ["user", "server"]);
  assert.equal(sent[2].messageId, "m9");
  await assert.rejects(sendMessage("t1", "x", { mode: "steer" }, send), /mode/);
  await assert.rejects(sendMessage("t1", "x", { createdBy: "bot" }, send), /createdBy/);
});

test("interruptThread: run.interrupt on the live run; nothing when idle", async () => {
  const sent = [];
  const send = async (c) => { sent.push(c); };
  const row = (active) => [{ thread_id: "t1", payload_json: JSON.stringify({ id: "t1", title: "T" }), run_status: active ? "running" : "completed", run_id: "r1", active_run_id: active ? "r1" : null }];
  assert.equal(await interruptThread("t1", "timeout", { query: () => row(true), send }), "r1");
  assert.deepEqual([sent[0].type, sent[0].threadId, sent[0].runId, sent[0].reason], ["run.interrupt", "t1", "r1", "timeout"]);
  assert.equal(await interruptThread("t1", "timeout", { query: () => row(false), send }), null);
  assert.equal(sent.length, 1);
});

test("snoozeThread: an ISO time, or a loud error", async () => {
  const sent = [];
  await snoozeThread("t1", "2026-10-17T09:00:00Z", async (c) => sent.push(c));
  assert.deepEqual([sent[0].type, sent[0].snoozedUntil], ["thread.snooze", "2026-10-17T09:00:00.000Z"]);
  await assert.rejects(snoozeThread("t1", "tomorrow", async (c) => sent.push(c)), /ISO/);
});

// T3's own tables (testdata/statev2-schema.sql) in memory, for the adapter's real SQL.
const here = path.dirname(new URL(import.meta.url).pathname);
const sqlite = `import json,sqlite3,sys
c=sqlite3.connect(':memory:'); c.row_factory=sqlite3.Row
c.executescript(open(sys.argv[1]).read())
for t,rows in json.load(sys.stdin).items():
  for r in rows: c.execute('insert into %s (%s) values (%s)' % (t, ','.join(r), ','.join('?'*len(r))), list(r.values()))
print(json.dumps([dict(x) for x in c.execute(sys.argv[2], json.loads(sys.argv[3]))]))`;
const v2 = (tables) => (sql, params = []) => JSON.parse(execFileSync("python3", ["-c", sqlite, path.join(here, "testdata/statev2-schema.sql"), sql, JSON.stringify(params)], { input: JSON.stringify(tables), encoding: "utf8" }));
const at = (min) => `2026-10-17T01:${String(min).padStart(2, "0")}:00.000Z`;
const v2Thread = { thread_id: "t1", project_id: "p", title: "T", default_provider: "claudeAgent", runtime_mode: "full-access", interaction_mode: "default",
  created_at: at(0), updated_at: at(0), payload_json: JSON.stringify({ id: "t1", title: "T" }) };
const v2Run = (ordinal, status, { started = true, done = null } = {}) => ({ run_id: `r${ordinal}`, thread_id: "t1", ordinal, provider: "claudeAgent", status,
  requested_at: at(ordinal), completed_at: done, payload_json: JSON.stringify({ id: `r${ordinal}`, rootNodeId: `r${ordinal}:root`, startedAt: started ? at(ordinal) : null }) });
const limitItem = { turn_item_id: "e1", thread_id: "t1", run_id: "r1", node_id: "r1:root", ordinal: 1, type: "error", status: "failed", updated_at: at(2),
  payload_json: JSON.stringify({ type: "error", failure: { class: "usage_limit", message: "You've hit your usage limit.", resetAt: "2026-10-17T05:00:00Z" } }) };

test("getThread: a usage-limited run stays the thread's outcome when a newer run was cancelled before starting or is queued", () => {
  const tables = (later) => ({ orchestration_v2_projection_threads: [v2Thread], orchestration_v2_projection_turn_items: [limitItem],
    orchestration_v2_projection_runs: [v2Run(1, "failed", { done: at(2) }), later] });
  for (const later of [v2Run(2, "cancelled", { started: false, done: at(3) }), v2Run(2, "queued", { started: false })]) {
    const t = getThread("t1", v2(tables(later)));
    assert.deepEqual([t.latestRunId, t.status, t.busy, t.lastErrorClass, t.usageLimitResetAt], ["r1", "failed", false, "usage_limit", "2026-10-17T05:00:00Z"], later.status);
  }
  // A newer run that really ran (here: completed) is the outcome, as before.
  const t = getThread("t1", v2(tables(v2Run(2, "completed", { done: at(4) }))));
  assert.deepEqual([t.latestRunId, t.status, t.lastErrorClass], ["r2", "completed", null]);
  // A held queued run never stands for the thread, a non-limit failure keeps the newest run.
  const plain = { ...limitItem, payload_json: JSON.stringify({ type: "error", failure: { class: "provider_error", message: "boom" } }) };
  const u = getThread("t1", v2({ ...tables(v2Run(2, "cancelled", { started: false, done: at(3) })), orchestration_v2_projection_turn_items: [plain] }));
  assert.deepEqual([u.latestRunId, u.status, u.lastErrorClass], ["r2", "cancelled", null]);
});

test("getThread: busy while a run is live even when a newer run was cancelled before starting (a message folded into the turn)", () => {
  const t = getThread("t1", v2({ orchestration_v2_projection_threads: [v2Thread],
    orchestration_v2_projection_runs: [v2Run(1, "running"), v2Run(2, "cancelled", { started: false, done: at(3) })] }));
  assert.deepEqual([t.latestRunId, t.status, t.busy, t.activeRunId], ["r2", "cancelled", true, "r1"]);
});

test("abandonThread: removes queued messages, interrupts the live run, waits for it to end, then settles", async () => {
  const sent = [];
  let state = { run: "running", queued: ["q1"] };
  const query = (sql) => {
    if (sql.startsWith("select run_id from")) return state.queued.map((run_id) => ({ run_id }));
    const live = state.run === "running";
    return [{ thread_id: "t1", payload_json: JSON.stringify({ id: "t1", settledAt: state.settled ?? null }), run_id: "r1", run_status: state.run, active_run_id: live ? "r1" : null }];
  };
  const send = async (c) => {
    sent.push(c.type);
    if (c.type === "queued-run.cancel") state.queued = state.queued.filter((q) => q !== c.runId);
    if (c.type === "run.interrupt") setTimeout(() => { state.run = "interrupted"; }, 5); // ends a moment later
    if (c.type === "thread.settle") state.settled = at(9);
  };
  await abandonThread("t1", { reason: "usage limit", pollMs: 2, query, send });
  assert.deepEqual(sent.filter((t, i) => t !== sent[i - 1]), ["queued-run.cancel", "run.interrupt", "thread.settle"]);
  assert.equal(sent.filter((t) => t === "run.interrupt").length, 1, "one interrupt per run");
  // Already settled: nothing to do. A refusal or a run that won't stop is an error, never a quiet return.
  sent.length = 0;
  await abandonThread("t1", { query, send });
  assert.deepEqual(sent, []);
  state = { run: "completed", queued: [] };
  await assert.rejects(abandonThread("t1", { query, send: async (c) => { if (c.type === "thread.settle") throw new Error("Thread t1 is still running."); } }), /still running/);
  state = { run: "running", queued: [] };
  await assert.rejects(abandonThread("t1", { timeoutMs: 10, pollMs: 2, query, send: async () => {} }), /still running after .* not settled/);
  await assert.rejects(abandonThread("gone", { query: () => [], send }), /no thread gone/);
});

test("t3-api.mjs --check runs through a symlinked skills dir (~/.agents/skills/subagents → russell-skills)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-api-link-"));
  fs.mkdirSync(path.join(home, ".t3/userdata"), { recursive: true });
  fs.writeFileSync(path.join(home, ".t3/userdata/server-runtime.json"), JSON.stringify({ port: 1 }));
  fs.writeFileSync(path.join(home, "t3.json"), JSON.stringify({ projects: [], threads: [], runs: [], messages: [], commands: [] }));
  const link = path.join(home, "skills-code");
  fs.symlinkSync(here, link);
  const r = spawnSync(process.execPath, ["--import", path.join(here, "testdata/fake-t3.mjs"), path.join(link, "t3-api.mjs"), "--check"],
    { env: { ...process.env, HOME: home, FAKE_T3: path.join(home, "t3.json") }, encoding: "utf8", timeout: 60000 });
  assert.match(r.stdout, /^T3 \S+: ok|T3 API changed/, `the guard must run the check: ${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.trim().length > 0, "--check printed nothing");
});
