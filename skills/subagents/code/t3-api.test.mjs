// node --test skills/subagents/code/t3-api.test.mjs
import "./testdata/use-test-accounts.mjs"; // first: fixed test accounts
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claude } from "./accounts.mjs";

// createMainThread records each new main thread in AGENT_JOBS_DIR/main-threads.jsonl (read on
// every call): keep it in a temp dir so no test writes the real state dir.
const JOBS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "t3-api-jobs-"));
process.env.AGENT_JOBS_DIR = JOBS_TMP;
const registryLines = () => { try { return fs.readFileSync(mainThreadsFile(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const withoutAt = (lines) => lines.map(({ at, ...l }) => l);
import { abandonThread, busyProviderSelection, conversationInstance, createMainThread, currentThread, mainThreadRoles, mainThreadsFile, recordMainThread, recordMissingMainThread, getThread, interruptThread, isWorker, jobThreadIds, asOrchSelection, mainModelSelection, orchModelSelection, orchestratorArgs, projectFor, renameThread, sendMessage, snoozeThread, t3TokenFrom, workerThreadTitle } from "./t3-api.mjs";

test("TITLE worker: the title is the fix (with a model hint), never \"[model] job\"", () => {
  assert.equal(workerThreadTitle({ model: "opus", job: "p65-s3-impl", title: "Board lanes, priority tags" }), "[opus] Board lanes, priority tags");
  assert.equal(workerThreadTitle({ model: "opus", job: "p65-s3-impl", title: "Board lanes", attempt: 2 }), "[opus] Board lanes (retry 1)");
  assert.equal(workerThreadTitle({ model: "sol62", job: "p65-s3-review" }), "[sol62] p65-s3-review");
  assert.equal(workerThreadTitle({ model: "sol62", job: "p65-s3-review", title: "  " }), "[sol62] p65-s3-review");
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
  assert.deepEqual(mainModelSelection("fable", "high"), { instanceId: claude.t3Instance, model: "claude-fable-5-2", options: [{ id: "effort", value: "high" }] });
  assert.notEqual(mainModelSelection().instanceId, claude.t3WorkerInstance);
  assert.throws(() => mainModelSelection("gpt"), /--model is/);
});

test("projectFor: the first root with a T3 project", () => {
  const query = () => [{ project_id: "p-app", workspace_root: "/work/app" }, { project_id: "p-skills", workspace_root: "/work/russell-skills/" }];
  assert.equal(projectFor(["/nowhere", "/work/russell-skills"], query), "p-skills");
  assert.throws(() => projectFor(["/nowhere"], query), /no T3 project for \/nowhere/);
});

test("projectFor: a repo inside a workspace folder falls back to the deepest holder, never home", () => {
  const query = () => [{ project_id: "p-home", workspace_root: "/home/u" }, { project_id: "p-ws", workspace_root: "/home/u/studio" }, { project_id: "p-app", workspace_root: "/home/u/studio/app" }];
  assert.equal(projectFor(["/home/u/studio/app"], query, "/home/u"), "p-app");
  assert.equal(projectFor(["/home/u/studio/site", "/home/u/studio/site"], query, "/home/u"), "p-ws");
  assert.equal(projectFor(["/home/u/studio/site/sub"], query, "/home/u"), "p-ws");
  assert.throws(() => projectFor(["/home/u/loose-repo"], query, "/home/u"), /no T3 project for \/home\/u\/loose-repo/);
  assert.throws(() => projectFor(["/home/u/studio-old"], query, "/home/u"), /no T3 project/);
});

test("projectFor: archived projects never count; an old symlinked root is read at its real path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-"));
  const ws = path.join(dir, "studio"), app = path.join(ws, "app"), old = path.join(dir, "app_old");
  fs.mkdirSync(app, { recursive: true });
  fs.symlinkSync(app, old);
  const query = () => [
    { project_id: "p-old", workspace_root: old, archived_at: "2026-11-13" },
    { project_id: "p-ws", workspace_root: ws, archived_at: null },
  ];
  assert.equal(projectFor([old], query, "/nowhere-home"), "p-ws");
  assert.equal(projectFor([app], query, "/nowhere-home"), "p-ws");
  fs.rmSync(dir, { recursive: true, force: true });
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

test("main-thread registry: one line per real creation, none for a resume that finds the thread already registered, role and from as given", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
  process.env.AGENT_JOBS_DIR = dir;
  try {
    assert.equal(mainThreadsFile(), path.join(dir, "main-threads.jsonl"));
    const send = async () => {};
    const sel = mainModelSelection();
    const base = { messageId: "m", projectId: "p", text: "brief", modelSelection: sel };
    const fresh = () => { throw new Error("no reads on a fresh create"); };
    await createMainThread({ ...base, threadId: "lead-a", title: "Porch lights schedule" }, { send, query: fresh });
    await createMainThread({ ...base, threadId: "pass-b", title: "Sorting: 4 new notes", role: "triage" }, { send, query: fresh });
    // A resume that finds the thread made appends nothing; one that has to create it records it.
    await createMainThread({ ...base, threadId: "lead-a", title: "Porch lights schedule", resume: true }, { send, query: (sql) => (sql.includes("pinned_at") ? [{ pinned_at: null }] : [{ 1: 1 }]) });
    await createMainThread({ ...base, threadId: "next-c", title: "Porch lights schedule", resume: true, role: "orchestrator", from: "lead-a" }, { send, query: () => [] });
    await createMainThread({ ...base, threadId: "next-d", title: "Weekend errands", resume: true, role: "own", from: "chat-z" }, { send, query: () => [] });
    assert.deepEqual(withoutAt(registryLines()), [
      { threadId: "lead-a", role: "orchestrator", title: "Porch lights schedule" },
      { threadId: "pass-b", role: "triage", title: "Sorting: 4 new notes" },
      { threadId: "next-c", role: "orchestrator", title: "Porch lights schedule", from: "lead-a" },
      { threadId: "next-d", role: "own", title: "Weekend errands", from: "chat-z" },
    ]);
    for (const l of registryLines()) assert.ok(Number.isFinite(Date.parse(l.at)), l.at);
    // A failed thread.create records nothing.
    await assert.rejects(createMainThread({ ...base, threadId: "never", title: "Refused" }, { send: async () => { throw new Error("T3 down"); }, query: fresh }));
    assert.equal(registryLines().length, 4);
    const roles = mainThreadRoles();
    assert.deepEqual(roles.get("next-c"), { role: "orchestrator", from: "lead-a", title: "Porch lights schedule", at: roles.get("next-c").at });
    assert.deepEqual([...roles.keys()], ["lead-a", "pass-b", "next-c", "next-d"]);
  } finally { process.env.AGENT_JOBS_DIR = JOBS_TMP; }
});

test("main-thread registry (crash recovery): a resume that finds the thread made adds the lost line, only when there is none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-crash-"));
  process.env.AGENT_JOBS_DIR = dir;
  try {
    const sent = [];
    const send = async (c) => { sent.push(c.type); };
    const base = { messageId: "m", projectId: "p", text: "brief", modelSelection: mainModelSelection(), resume: true };
    // T3 has the thread (created before the crash), no first message yet, and no registry line.
    const made = (sql) => (sql.includes("pinned_at") ? [{ pinned_at: null }] : []);
    await createMainThread({ ...base, threadId: "lead-k", title: "Pantry restock", role: "orchestrator", from: "lead-j" }, { send, query: made });
    await createMainThread({ ...base, threadId: "pass-m", title: "Sorting: 5 new notes", role: "triage" }, { send, query: made });
    assert.deepEqual(sent, ["message.dispatch", "message.dispatch"], "no second thread.create");
    // A further resume, and one for a thread that already has a line (even with another role), add nothing.
    recordMainThread({ threadId: "chat-n", role: "own", title: "Dentist follow-up" });
    await createMainThread({ ...base, threadId: "lead-k", title: "Pantry restock" }, { send, query: made });
    await createMainThread({ ...base, threadId: "chat-n", title: "Dentist follow-up", role: "orchestrator" }, { send, query: made });
    assert.deepEqual(withoutAt(registryLines()), [
      { threadId: "lead-k", role: "orchestrator", title: "Pantry restock", from: "lead-j" },
      { threadId: "pass-m", role: "triage", title: "Sorting: 5 new notes" },
      { threadId: "chat-n", role: "own", title: "Dentist follow-up" },
    ]);
    assert.equal(recordMissingMainThread({ threadId: "chat-n", role: "orchestrator", title: "x" }), null);
    assert.equal(mainThreadRoles().get("chat-n").role, "own");
  } finally { process.env.AGENT_JOBS_DIR = JOBS_TMP; }
});

test("main-thread registry: unwritable → the thread is still created and stderr warns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-ro-"));
  const blocker = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocker, "a file where the jobs dir should be");
  process.env.AGENT_JOBS_DIR = blocker; // mkdir and append both fail (ENOTDIR/EEXIST), even as root
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const sent = [];
    await createMainThread({ threadId: "lead-ro", messageId: "m", projectId: "p", title: "Garage door check", text: "b", modelSelection: mainModelSelection() }, { send: async (c) => sent.push(c.type), query: () => [] });
    assert.deepEqual(sent, ["thread.create", "message.dispatch"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^main-thread registry .*not-a-dir\/main-threads\.jsonl: .*; thread lead-ro \(orchestrator\) started without a record$/);
    assert.equal(recordMainThread({ threadId: "x", role: "triage", title: "t" }), null);
    assert.deepEqual(mainThreadRoles(), new Map()); // unreadable: empty, with a warning
  } finally { console.error = orig; process.env.AGENT_JOBS_DIR = JOBS_TMP; }
});

test("mainThreadRoles: last line per thread wins, garbage and incomplete lines are skipped, missing file is empty", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "registry-read-")), "main-threads.jsonl");
  assert.deepEqual(mainThreadRoles({ file }), new Map());
  fs.writeFileSync(file, [
    JSON.stringify({ threadId: "t-1", role: "own", title: "Tax forms", at: "2026-11-01T10:00:00Z" }),
    "{not json",
    JSON.stringify({ threadId: "t-2", title: "no role" }),
    JSON.stringify({ role: "orchestrator", title: "no thread" }),
    "",
    JSON.stringify({ threadId: "t-3", role: "triage", title: "Sorting: 2 new notes", at: "2026-11-02T09:00:00Z" }),
    JSON.stringify({ threadId: "t-1", role: "orchestrator", title: "Tax forms, round 2", at: "2026-11-03T08:00:00Z", from: "t-0" }),
    "",
  ].join("\n"));
  assert.deepEqual(mainThreadRoles({ file }), new Map([
    ["t-1", { role: "orchestrator", from: "t-0", title: "Tax forms, round 2", at: "2026-11-03T08:00:00Z" }],
    ["t-3", { role: "triage", from: null, title: "Sorting: 2 new notes", at: "2026-11-02T09:00:00Z" }],
  ]));
  // A line written by recordMainThread reads back.
  recordMainThread({ threadId: "t-4", role: "own", title: "Birthday plans", from: "t-9" }, { file, at: "2026-11-04T12:00:00Z" });
  assert.deepEqual(mainThreadRoles({ file }).get("t-4"), { role: "own", from: "t-9", title: "Birthday plans", at: "2026-11-04T12:00:00Z" });
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

test("sendMessage keepBusyProvider: a refused account move goes out once more on the account still running", async () => {
  const busy = new Error('T3 action failed: message.dispatch {"cause":"The previous provider is still running background agents or commands, and switching would end them."}');
  const mei = { instanceId: "claudeAgent_mei", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] };
  // A fake state DB: the thread's provider threads, its fresh-context runs, each instance's last model.
  const fakeDb = ({ providerThreads, fresh = [], models }) => (sql, params = []) => {
    if (/join orchestration_v2_projection_provider_threads/.test(sql)) return providerThreads;
    if (/freshContext/.test(sql)) return fresh;
    if (/modelSelection.model/.test(sql)) return models[params[1]] ? [{ model: models[params[1]] }] : [];
    return [{ thread_id: "t1", payload_json: JSON.stringify({ id: "t1", title: "T", modelSelection: mei }), run_status: "completed", run_id: "r1", active_run_id: null }];
  };
  const models = { claude_personal: "claude-opus-5-5", claudeAgent_mei: "claude-opus-5-5", codex: "gpt-6-sol" };
  // The conversation is still on claude_personal (its last run there ran Opus).
  const query = fakeDb({ providerThreads: [{ instance: "claude_personal", first: 4, last: 10, owner: null, active: 1 }, { instance: "claudeAgent_mei", first: 1, last: 3, owner: null, active: 0 }], models });
  const sent = [];
  const refuseMei = async (c) => { sent.push(c); if ((c.modelSelection?.instanceId ?? "claudeAgent_mei") === "claudeAgent_mei") throw busy; };
  // No selection given: the thread's own (mei) is refused, so it goes on claude_personal with the same model.
  const id = await sendMessage("t1", "Restarted the server now!", { createdBy: "user", keepBusyProvider: true, query }, refuseMei);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].modelSelection, { ...mei, instanceId: "claude_personal" });
  assert.equal(sent[1].messageId, id);
  assert.notEqual(sent[1].commandId, sent[0].commandId); // T3 replays a refused command id
  // Without the option, or for any other refusal, the error stands and nothing is resent.
  sent.length = 0;
  await assert.rejects(sendMessage("t1", "x", { query }, refuseMei), /background agents/);
  assert.equal(sent.length, 1);
  sent.length = 0;
  await assert.rejects(sendMessage("t1", "x", { keepBusyProvider: true, query }, async (c) => { sent.push(c); throw new Error("thread archived"); }), /archived/);
  assert.equal(sent.length, 1);
  // Another provider (Codex conversation, Claude wanted): not an account move, the refusal stands.
  const codexQuery = fakeDb({ providerThreads: [{ instance: "codex", first: 4, last: 10, owner: null, active: 1 }], models });
  await assert.rejects(sendMessage("t1", "x", { keepBusyProvider: true, query: codexQuery }, refuseMei), /background agents/);
  // Already on that instance: nothing to keep.
  assert.equal(busyProviderSelection("t1", { ...mei, instanceId: "claude_personal" }, query), null);
  // T3's conversationProviderThread: a scheduled fresh-context run started the active (mei) provider
  // thread, so a message continues the claude_personal conversation, and that is the one kept.
  const scheduled = fakeDb({ providerThreads: [{ instance: "claudeAgent_mei", first: 11, last: 11, owner: null, active: 1 }, { instance: "claude_personal", first: 4, last: 10, owner: null, active: 0 }],
    fresh: [{ ordinal: 11, status: "completed", started: "2026-11-23T17:00:00Z", scheduled: 1 }], models });
  assert.equal(conversationInstance("t1", scheduled), "claude_personal");
  assert.deepEqual(busyProviderSelection("t1", mei, scheduled), { ...mei, instanceId: "claude_personal" });
  // An unscheduled fresh run is a context boundary: provider threads before it never continue.
  const bounded = fakeDb({ providerThreads: [{ instance: "claudeAgent_mei", first: 12, last: 12, owner: null, active: 1 }, { instance: "claude_personal", first: 4, last: 10, owner: null, active: 0 }],
    fresh: [{ ordinal: 11, status: "completed", started: "x", scheduled: 0 }, { ordinal: 12, status: "completed", started: "x", scheduled: 1 }], models });
  assert.equal(conversationInstance("t1", bounded), "claudeAgent_mei");
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

test("listThreads includeSettled: false drops settled threads in SQL, by the same rule as `settled`", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-api-settled-"));
  fs.mkdirSync(path.join(home, ".t3/userdata"), { recursive: true });
  fs.writeFileSync(path.join(home, ".t3/userdata/server-runtime.json"), JSON.stringify({ port: 1 }));
  const at = "2026-10-09T12:00:00.000Z";
  fs.writeFileSync(path.join(home, "t3.json"), JSON.stringify({ projects: [{ project_id: "proj-1", workspace_root: home }], messages: [], commands: [],
    threads: [{ thread_id: "open-a" }, { thread_id: "settled-b", settled_at: at }, { thread_id: "override-c", settled_override: "settled" },
      { thread_id: "unsettled-d", settled_override: "unsettled" }, { thread_id: "archived-e", archived_at: at }].map((t) => ({ title: t.thread_id, created_at: at, ...t })),
    runs: [{ run_id: "r1", thread_id: "open-a", ordinal: 1, status: "completed", requested_at: at, completed_at: at }] }));
  const script = path.join(home, "list.mjs");
  fs.writeFileSync(script, `import { listThreads } from ${JSON.stringify(path.join(here, "t3-api.mjs"))};
const ids = (o) => listThreads(o).map((t) => t.id + (t.settled ? "*" : "")).sort();
console.log(JSON.stringify({ all: ids(), open: ids({ includeSettled: false }) }));`);
  const r = spawnSync(process.execPath, ["--import", path.join(here, "testdata/fake-t3.mjs"), script],
    { env: { ...process.env, HOME: home, FAKE_T3: path.join(home, "t3.json") }, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.all, ["open-a", "override-c*", "settled-b*", "unsettled-d"]);
  assert.deepEqual(got.open, got.all.filter((id) => !id.endsWith("*"))); // the SQL filter equals the JS rule
});

test("t3TokenFrom: the last non-empty token-shaped line; log lines and blanks around it never count", () => {
  const tok = "eyJhbGciOiJIUzI1NiJ9_-x.c2lnbmF0dXJl";
  assert.equal(t3TokenFrom(`${tok}\n`), tok);
  assert.equal(t3TokenFrom(`timestamp=2026-11-23T23:10:00Z level=INFO fiber=#12 message="Migrations ran"\n${tok}\n\n`), tok);
  assert.equal(t3TokenFrom(`  ${tok}  \r\n[t3] warn: runtime selected\n`), tok);
  assert.equal(t3TokenFrom(`old.token1234-old.token1234-old-token\n${tok}`), tok);
  assert.equal(t3TokenFrom(`${tok}\nlogentry.example\n`), tok); // too short to be a token
  assert.equal(t3TokenFrom("short.tok\n"), null);
  assert.equal(t3TokenFrom("level=INFO message=\"no token here\"\n\n"), null);
  assert.equal(t3TokenFrom(""), null);
});

// t3Connect against a fake `t3` CLI (on PATH, its outputs in order from a script) and a local
// ticket server that records the Authorization header and answers 500, so connect stops there.
async function connectWithFakeCli(outputs, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-api-token-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, ".t3/userdata"), { recursive: true });
  outputs.forEach((o, i) => fs.writeFileSync(path.join(home, `out${i + 1}`), o));
  fs.writeFileSync(path.join(bin, "t3"), `#!/bin/sh\n[ "$1" = --version ] && { echo "t3 v0.0-test"; exit 0; }\nn=$(( $(cat "${home}/calls" 2>/dev/null || echo 0) + 1 ))\necho $n > "${home}/calls"\ncat "${home}/out$n"\n`, { mode: 0o755 });
  const headers = [];
  const server = http.createServer((req, res) => { headers.push(req.headers.authorization); res.writeHead(500); res.end(); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  fs.writeFileSync(path.join(home, ".t3/userdata/server-runtime.json"), JSON.stringify({ port: server.address().port }));
  const code = `import { t3Connect } from ${JSON.stringify(path.join(here, "t3-api.mjs"))};\ntry { await t3Connect("test"); console.log("connected"); } catch (e) { console.log(JSON.stringify({ message: e.message, tokenRejected: !!e.tokenRejected })); }`;
  const { T3_SESSION_TOKEN, ...base } = process.env;
  const stdout = await new Promise((ok, fail) => execFile(process.execPath, ["--input-type=module", "-e", code],
    { env: { ...base, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: "utf8", timeout: 30000 }, (e, out, err) => (e ? fail(new Error(`${e.message}\n${err}`)) : ok(out))));
  server.close();
  const calls = Number(fs.readFileSync(path.join(home, "calls"), "utf8").trim() || 0);
  return { result: JSON.parse(stdout), headers, calls };
}

test("t3Connect: a T3 log line on the token CLI's stdout never reaches the Bearer header", async () => {
  const tok = "eyJhbGciOiJIUzI1NiJ9.c2lnbmF0dXJl";
  const r = await connectWithFakeCli([`timestamp=2026-11-23T23:10:00Z level=INFO message="Using runtime 0.1.3"\n${tok}\n`]);
  assert.deepEqual(r.headers, [`Bearer ${tok}`]);
  assert.equal(r.calls, 1);
  assert.match(r.result.message, /websocket ticket: HTTP 500/);
});

test("t3Connect: no token-shaped line mints once more; twice in a row is a loud error, never a bad header", async () => {
  const tok = "eyJhbGciOiJIUzI1NiJ9.c2lnbmF0dXJl";
  const again = await connectWithFakeCli(["level=WARN message=\"busy\"\n", `${tok}\n`]);
  assert.equal(again.calls, 2);
  assert.deepEqual(again.headers, [`Bearer ${tok}`]);
  const twice = await connectWithFakeCli(["level=WARN a\n", "level=WARN b\n", `${tok}\n`]);
  assert.equal(twice.calls, 2);
  assert.deepEqual(twice.headers, []);
  assert.match(twice.result.message, /T3 API changed .*printed no token-shaped line twice/);
});

test("t3Connect: T3_SESSION_TOKEN skips the CLI and keeps tokenRejected on 401", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-api-envtok-"));
  fs.mkdirSync(path.join(home, ".t3/userdata"), { recursive: true });
  const headers = [];
  const server = http.createServer((req, res) => { headers.push(req.headers.authorization); res.writeHead(401); res.end(); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  fs.writeFileSync(path.join(home, ".t3/userdata/server-runtime.json"), JSON.stringify({ port: server.address().port }));
  const code = `import { t3Connect } from ${JSON.stringify(path.join(here, "t3-api.mjs"))};\ntry { await t3Connect("test"); } catch (e) { console.log(JSON.stringify({ message: e.message, tokenRejected: !!e.tokenRejected })); }`;
  const stdout = await new Promise((ok, fail) => execFile(process.execPath, ["--input-type=module", "-e", code],
    { env: { ...process.env, HOME: home, PATH: "/nonexistent", T3_SESSION_TOKEN: " parent.token123 " }, encoding: "utf8", timeout: 30000 }, (e, out, err) => (e ? fail(new Error(`${e.message}\n${err}`)) : ok(out))));
  server.close();
  assert.deepEqual(headers, ["Bearer parent.token123"]);
  const r = JSON.parse(stdout);
  assert.equal(r.tokenRejected, true);
  assert.match(r.message, /^T3 token rejected/);
});

test("orchModelSelection / asOrchSelection: agent-started leads go to the orchestrator instance, the user's own stay", () => {
  const acct = { t3Instance: "mei", t3OrchInstance: "mei_orch", second: { t3Instance: "ultra", t3OrchInstance: "ultra_orch" } };
  const main = mainModelSelection("opus", "high");
  assert.deepEqual(orchModelSelection("opus", "high", acct), { ...main, instanceId: "mei_orch" });
  assert.equal(orchModelSelection("opus", "high", { t3Instance: "mei" }).instanceId, "mei", "no orch instance: the plain one");
  const on = (instanceId) => ({ instanceId, model: "claude-opus-5-5" });
  assert.deepEqual(asOrchSelection(on("mei"), "orchestrator", acct), on("mei_orch"));
  assert.deepEqual(asOrchSelection(on("ultra"), "triage", acct), on("ultra_orch"), "the second account maps to its own orch");
  assert.deepEqual(asOrchSelection(on("mei"), "own", acct), on("mei"), "the user's own thread never moves to _orch");
  for (const i of ["mei_orch", "mei_workers", "codex"]) assert.deepEqual(asOrchSelection(on(i), "orchestrator", acct), on(i));
  assert.equal(asOrchSelection(undefined, "orchestrator", acct), undefined);
  assert.deepEqual(asOrchSelection(on("mei"), "orchestrator", { t3Instance: "mei" }), on("mei"), "no orch configured: unchanged");
});
