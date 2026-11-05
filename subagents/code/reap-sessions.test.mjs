// node --test subagents/code/reap-sessions.test.mjs
import "./testdata/use-test-accounts.mjs"; // first: fixed test accounts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detachSession, liveSessions } from "./t3-api.mjs";
import { codexBackground, codexPending, pendingBackground, reap, reapable, sessionBackground } from "./reap-sessions.mjs";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const min = (m) => new Date(NOW - m * 60000).toISOString();
const session = (threadId, edits = {}) => ({ providerSessionId: `ps-${threadId}`, threadId, model: "claude-opus-5-5", title: threadId,
  deleted: false, archivedAt: null, settled: false, snoozedUntil: null, child: false, liveRuns: 0, tasksRunning: 0, lastActivityAt: min(30), ...edits });
const child = (name) => `thread:delegated-task:command%3Amcp%3Alead%3Adelegate-task%3A${name}`;

// T3's own tables (testdata/statev2-schema.sql) in memory, for liveSessions' real SQL.
const here = path.dirname(new URL(import.meta.url).pathname);
const sqlite = `import json,sqlite3,sys
c=sqlite3.connect(':memory:'); c.row_factory=sqlite3.Row
c.executescript(open(sys.argv[1]).read())
for t,rows in json.load(sys.stdin).items():
  for r in rows: c.execute('insert into %s (%s) values (%s)' % (t, ','.join(r), ','.join('?'*len(r))), list(r.values()))
print(json.dumps([dict(x) for x in c.execute(sys.argv[2], json.loads(sys.argv[3]))]))`;
const v2 = (tables) => (sql, params = []) => JSON.parse(execFileSync("python3", ["-c", sqlite, path.join(here, "testdata/statev2-schema.sql"), sql, JSON.stringify(params)], { input: JSON.stringify(tables), encoding: "utf8" }));

// A live DB: one thread per case, each with a ready, bound Claude session.
function tables() {
  const threads = [], runs = [], sessions = [], bindings = [], subagents = [], providerThreads = [];
  const add = (id, payload, { runs: rs = [["completed", 40]], session = {}, bound = true, task, nativeId } = {}) => {
    threads.push({ thread_id: id, project_id: "p", title: id, default_provider: "claudeAgent", runtime_mode: "full-access", interaction_mode: "default",
      created_at: min(120), updated_at: min(30), payload_json: JSON.stringify({ id, title: id, ...payload }) });
    rs.forEach(([status, ago, extra = {}], i) => runs.push({ run_id: `${id}:r${i}`, thread_id: id, ordinal: i + 1, provider: "claudeAgent", status,
      requested_at: min(ago + 1), completed_at: ["completed", "failed", "cancelled", "interrupted"].includes(status) ? min(ago) : null,
      payload_json: JSON.stringify({ startedAt: min(ago + 1), ...extra }) }));
    const sid = `ps-${id}`;
    sessions.push({ provider_session_id: sid, thread_id: id, provider: "claudeAgent", status: "ready", model: "claude-opus-5-5", updated_at: min(60),
      payload_json: "{}", driver: "claudeAgent", provider_instance_id: "claudeAgent_main", ...session });
    if (bound) bindings.push({ provider_session_id: sid, thread_id: id });
    if (nativeId) providerThreads.push({ provider_thread_id: `pt-${id}`, thread_id: id, provider: "claudeAgent_workers", provider_session_id: sid, status: "idle",
      updated_at: min(30), payload_json: JSON.stringify({ nativeThreadRef: { driver: "claudeAgent", nativeId, strength: "strong" } }) });
    if (task) subagents.push({ subagent_id: `sa-${id}`, thread_id: "lead", parent_node_id: "n", provider: "claudeAgent", child_thread_id: id, origin: "app_owned",
      status: task, updated_at: min(60), payload_json: "{}" });
  };
  add("settled", { settledAt: min(35) });
  add("archived", { archivedAt: min(35) });
  add("snoozed", { snoozedUntil: "2026-10-28T09:00:00.000Z" });
  add(child("done"), { lineage: { relationshipToParent: "subagent" } }, { task: "completed" });
  add("open", {});
  add("woke", { snoozedUntil: min(10) });
  add("settled-running", { settledAt: min(35) }, { runs: [["completed", 40], ["running", 2]] });
  add("settled-queued", { settledAt: min(35) }, { runs: [["completed", 40], ["queued", 1]] });
  add("settled-held", { settledAt: min(35) }, { runs: [["completed", 40], ["queued", 38, { queueHeld: true }]] });
  add("settled-recent", { settledAt: min(3) }, { runs: [["completed", 3]] });
  add(child("running"), {}, { task: "running" });
  add("released", { settledAt: min(35) }, { session: { status: "stopped" } });
  add("detached", { settledAt: min(35) }, { bound: false });
  add("other-driver", { settledAt: min(35) }, { session: { driver: "opencode", provider: "opencode" } });
  add("gone", { settledAt: min(35), deletedAt: min(35) });
  add("snoozed-lead", { snoozedUntil: "2026-10-28T09:00:00.000Z" });
  subagents.push({ subagent_id: "sa-lead-worker", thread_id: "snoozed-lead", parent_node_id: "n", provider: "claudeAgent", child_thread_id: child("lead-worker"),
    origin: "app_owned", status: "running", updated_at: min(60), payload_json: "{}" });
  return { orchestration_v2_projection_threads: threads, orchestration_v2_projection_runs: runs, orchestration_v2_projection_provider_sessions: sessions,
    orchestration_v2_projection_provider_session_bindings: bindings, orchestration_v2_projection_subagents: subagents,
    orchestration_v2_projection_provider_threads: providerThreads };
}

test("liveSessions: ready and bound Claude sessions only, with live runs, running tasks and last activity", () => {
  const all = liveSessions({}, v2(tables()));
  const byId = Object.fromEntries(all.map((s) => [s.threadId, s]));
  assert.ok(!byId.released && !byId.detached && !byId["other-driver"], "stopped, unbound and other drivers are not live");
  assert.equal(byId["settled-running"].liveRuns, 1);
  assert.equal(byId["settled-queued"].liveRuns, 1);
  assert.equal(byId["settled-held"].liveRuns, 0, "a held queued message does not start on its own");
  assert.equal(byId[child("running")].tasksRunning, 1);
  assert.equal(byId[child("done")].tasksRunning, 0);
  assert.equal(byId[child("done")].child, true);
  assert.equal(byId["settled-recent"].lastActivityAt, min(3), "the newest run end counts");
  assert.equal(byId.open.lastActivityAt, min(30), "the thread's own update counts");
  assert.equal(byId.gone.deleted, true);
  assert.equal(byId["snoozed-lead"].childrenRunning, 1, "a lead's own running worker counts");
  assert.equal(byId.snoozed.childrenRunning, 0);
});

test("reapable on the real SQL: each finished state, never open, busy, recent or deleted threads", () => {
  const picked = reapable(liveSessions({}, v2(tables())), { now: NOW, idleMin: 5 });
  assert.deepEqual(Object.fromEntries(picked.map((s) => [s.threadId, s.state])),
    { settled: "settled", archived: "archived", snoozed: "snoozed", [child("done")]: "task-ended", "settled-held": "settled" });
});

test("reapable: idle minutes against --idle-min; a passed snooze is open; a child with a running task stays", () => {
  const s = [session("a", { settled: true, lastActivityAt: min(4) }), session("b", { settled: true, lastActivityAt: min(5) })];
  assert.deepEqual(reapable(s, { now: NOW, idleMin: 5 }).map((x) => [x.threadId, x.idleMin]), [["b", 5]]);
  assert.deepEqual(reapable(s, { now: NOW, idleMin: 0 }).map((x) => x.threadId), ["a", "b"]);
  assert.deepEqual(reapable([session("w", { snoozedUntil: min(1) })], { now: NOW }), []);
  assert.deepEqual(reapable([session(child("x"), { child: true, tasksRunning: 1 })], { now: NOW }), []);
  assert.deepEqual(reapable([session("q", { settled: true, liveRuns: 1 })], { now: NOW }), []);
});

const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reap-")), "reap-sessions.log");
const none = () => ({ pending: [] }); // no background work anywhere

test("reap: sends provider-session.detach for each finished session and logs one line each", async () => {
  const sent = [], log = tmpLog();
  const r = await reap({ now: () => NOW, query: v2(tables()), send: async (c) => sent.push(c), log, background: none, out: () => {} });
  assert.deepEqual(sent.map((c) => [c.type, c.threadId, c.providerSessionId]).sort(),
    ["settled", "archived", "snoozed", child("done"), "settled-held"].map((id) => ["provider-session.detach", id, `ps-${id}`]).sort());
  assert.ok(sent.every((c) => c.commandId && /^reap-sessions: /.test(c.reason)));
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines.find((l) => l.includes(" snoozed ")), /^2026-10-27T12:00:00.000Z detached snoozed "snoozed" state=snoozed idle=30m$/);
  assert.deepEqual([r.detached.length, r.errors.length], [5, 0]);
});

test("reap --dry-run sends nothing and writes no log", async () => {
  const sent = [], log = tmpLog(), out = [];
  const r = await reap({ dryRun: true, now: () => NOW, query: v2(tables()), send: async (c) => sent.push(c), connect: async () => { throw new Error("no connect on a dry run"); }, log, background: none, out: (l) => out.push(l) });
  assert.deepEqual(sent, []);
  assert.equal(fs.existsSync(log), false);
  assert.equal(r.candidates.length, 5);
  assert.ok(out.every((l) => l.startsWith("would detach ")));
});

test("reap: a refused detach is logged with T3's error and reported, the rest still go", async () => {
  const sent = [], log = tmpLog();
  const send = async (c) => { if (c.threadId === "archived") throw new Error("provider-session.detach: does not belong to thread"); sent.push(c); };
  const r = await reap({ now: () => NOW, query: v2(tables()), send, log, background: none, out: () => {} });
  assert.equal(sent.length, 4);
  assert.deepEqual(r.errors, [{ threadId: "archived", error: "provider-session.detach: does not belong to thread" }]);
  assert.match(fs.readFileSync(log, "utf8"), /error archived "archived" state=archived idle=30m: provider-session.detach: does not belong to thread/);
});

test("reap: a thread that started a run while connecting is left alone (the list is read again before each detach)", async () => {
  const sent = [];
  let reads = 0;
  const busy = session("late", { settled: true });
  const query = (sql) => {
    if (!sql.includes("provider_session_bindings")) throw new Error(`unexpected query ${sql}`);
    reads += 1;
    const row = (s) => ({ provider_session_id: s.providerSessionId, thread_id: s.threadId, driver: "claudeAgent", model: s.model, session_updated_at: s.lastActivityAt, title: s.title,
      thread_updated_at: s.lastActivityAt, deleted_at: null, payload_json: JSON.stringify({ settledAt: min(40) }), live_runs: reads > 1 && s.threadId === "late" ? 1 : 0,
      last_run_at: null, tasks_running: 0 });
    return [row(busy), row(session("calm", { settled: true }))];
  };
  const r = await reap({ now: () => NOW, query, connect: async () => async (c) => sent.push(c), log: tmpLog(), background: none, out: () => {} });
  assert.equal(reads, 3, "the first read, then one before each of the two detaches");
  assert.deepEqual(sent.map((c) => c.threadId), ["calm"]);
  assert.deepEqual(r.detached, ["calm"]);
});

test("reap: a thread that gets busy while an earlier detach is still answering is left alone", async () => {
  const sent = [];
  let secondBusy = false;
  const query = () => ["first", "second"].map((id) => ({ provider_session_id: `ps-${id}`, thread_id: id, driver: "claudeAgent", title: id, thread_updated_at: min(30),
    payload_json: JSON.stringify({ settledAt: min(40) }), live_runs: id === "second" && secondBusy ? 1 : 0, tasks_running: 0, children_running: 0 }));
  // The first detach's reply takes a while; meanwhile a fix round starts on "second".
  const send = async (c) => { sent.push(c.threadId); secondBusy = true; };
  const r = await reap({ now: () => NOW, query, connect: async () => send, log: tmpLog(), background: none, out: () => {} });
  assert.deepEqual(sent, ["first"]);
  assert.deepEqual(r.detached, ["first"]);
  assert.deepEqual(r.errors, []);
});

test("reap: T3 not running is not an error (no server, no processes); any other connect failure is", async () => {
  const s = [session("x", { settled: true })];
  const query = () => s.map((x) => ({ provider_session_id: x.providerSessionId, thread_id: x.threadId, driver: "claudeAgent", title: "x", thread_updated_at: x.lastActivityAt,
    payload_json: JSON.stringify({ settledAt: min(40) }), live_runs: 0, tasks_running: 0 }));
  const down = await reap({ now: () => NOW, query, connect: async () => { throw Object.assign(new Error("T3 not running (x)"), { notRunning: true }); }, log: tmpLog(), out: () => {} });
  assert.deepEqual(down.errors, []);
  const log = tmpLog();
  const changed = await reap({ now: () => NOW, query, connect: async () => { throw new Error("T3 API changed (server 9): websocket refused"); }, log, out: () => {} });
  assert.equal(changed.errors.length, 1);
  assert.match(fs.readFileSync(log, "utf8"), /error connect: T3 API changed/);
});

test("detachSession: T3's provider-session.detach with thread, session and reason", async () => {
  const sent = [];
  await detachSession("t1", "ps-1", "why", async (c) => sent.push(c));
  assert.deepEqual({ ...sent[0], commandId: "x" }, { commandId: "x", type: "provider-session.detach", threadId: "t1", providerSessionId: "ps-1", reason: "why" });
});

test("reap-sessions.mjs: a bad --idle-min fails loudly", () => {
  const bad = (() => { try { execFileSync(process.execPath, [path.join(here, "reap-sessions.mjs"), "--idle-min", "soon", "--dry-run"], { encoding: "utf8", stdio: "pipe" }); return null; } catch (e) { return e; } })();
  assert.ok(bad && bad.status !== 0 && /--idle-min/.test(bad.stderr));
});

// Transcript records in the shapes of a real worker's transcript, trimmed: a Bash run in
// the background, a Monitor, their completion notices (queued, then delivered as a user message),
// a Monitor event (no <status>), a TaskStop, and the notice a resumed session gets for orphans.
const T = (m) => new Date(NOW - m * 60000).toISOString();
const rec = {
  bashUse: (id, m) => ({ type: "assistant", timestamp: T(m), message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${id}`, name: "Bash",
    input: { command: "python3 run_matrix.py > /tmp/s5/full_run.log 2>&1", description: "Rerun the full S5 matrix on the fixed source", run_in_background: true } }] } }),
  bashStarted: (id, m) => ({ type: "user", timestamp: T(m), message: { role: "user", content: [{ tool_use_id: `toolu_${id}`, type: "tool_result",
    content: `Command running in background with ID: ${id}. Output is being written to: /tmp/claude-1000/x/tasks/${id}.output. You will be notified when it completes.` }] },
    toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: id } }),
  monitorUse: (id, m) => ({ type: "assistant", timestamp: T(m), message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${id}`, name: "Monitor",
    input: { command: "until grep -q '^exit=' /tmp/s5/full_run.log; do sleep 15; done", description: "S5 full-matrix rerun finishing", timeout_ms: 1800000 } }] } }),
  monitorStarted: (id, m, extra = {}) => ({ type: "user", timestamp: T(m), message: { role: "user", content: [{ tool_use_id: `toolu_${id}`, type: "tool_result",
    content: `Monitor started (task ${id}, expires in 30m unless the source ends first).` }] }, toolUseResult: { taskId: id, timeoutMs: 1800000, persistent: false, ...extra } }),
  notice: (ids, status, m) => `<task-notification>\n${ids.map((id) => `<task-id>${id}</task-id>\n`).join("")}<output-file>/tmp/claude-1000/x/tasks/${ids[0]}.output</output-file>\n`
    + (status ? `<status>${status}</status>\n<summary>Background command "x" ${status}</summary>\n` : `<summary>Monitor event: "x"</summary>\n<event>11 of 46 done</event>\n`) + "</task-notification>",
  queued: (ids, status, m) => ({ type: "queue-operation", operation: "enqueue", timestamp: T(m), sessionId: "s", content: rec.notice(ids, status, m) }),
  removed: (ids, status, m) => ({ type: "queue-operation", operation: "remove", timestamp: T(m), sessionId: "s", content: rec.notice(ids, status, m) }),
  delivered: (ids, status, m) => ({ type: "user", timestamp: T(m), origin: { kind: "task-notification" }, message: { role: "user", content: rec.notice(ids, status, m) } }),
  taskStop: (id, m) => ({ type: "assistant", timestamp: T(m), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_stop", name: "TaskStop", input: { task_id: id } }] } }),
};
const jsonl = (...rows) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
const s5Pending = () => jsonl(rec.bashUse("bjgdsn47r", 15), rec.bashStarted("bjgdsn47r", 15), "not json {", rec.monitorUse("bjyqpeddl", 12), rec.monitorStarted("bjyqpeddl", 12),
  rec.queued(["bjyqpeddl"], null, 11), rec.delivered(["bjyqpeddl"], null, 11));

test("pendingBackground: a Bash run in the background and a Monitor with no completion notice are pending; Monitor events end nothing", () => {
  assert.deepEqual(pendingBackground(s5Pending(), NOW), [
    { id: "bjgdsn47r", tool: "Bash", what: "Rerun the full S5 matrix on the fixed source", startedAt: T(15) },
    { id: "bjyqpeddl", tool: "Monitor", what: "S5 full-matrix rerun finishing", startedAt: T(12) },
  ]);
});

test("pendingBackground: a delivered completion notice (either delivery shape, any status, several tasks at once), a TaskStop or a passed Monitor timeout ends the task", () => {
  const start = [rec.bashUse("b1", 20), rec.bashStarted("b1", 20)];
  assert.deepEqual(pendingBackground(jsonl(...start, rec.queued(["b1"], "completed", 5), rec.delivered(["b1"], "completed", 5)), NOW), []);
  assert.deepEqual(pendingBackground(jsonl(...start, rec.queued(["b1"], "failed", 5), rec.removed(["b1"], "failed", 1)), NOW), []);
  assert.deepEqual(pendingBackground(jsonl(...start, rec.taskStop("b1", 5)), NOW), []);
  assert.deepEqual(pendingBackground(jsonl(...start, rec.monitorUse("m1", 19), rec.monitorStarted("m1", 19), rec.queued(["b1", "m1", "__orphan_summary__:shell"], "stopped", 1),
    rec.delivered(["b1", "m1", "__orphan_summary__:shell"], "stopped", 1)), NOW), []);
  assert.deepEqual(pendingBackground(jsonl(rec.monitorUse("m1", 31), rec.monitorStarted("m1", 31)), NOW), [], "a 30-min Monitor started 31 min ago has expired");
  assert.equal(pendingBackground(jsonl(rec.monitorUse("m1", 31), rec.monitorStarted("m1", 31, { persistent: true })), NOW).length, 1, "a persistent Monitor has no timeout");
  // A start with no tool_use record in view (e.g. a cut transcript) is still pending, named by its tool.
  assert.deepEqual(pendingBackground(jsonl(rec.bashStarted("b2", 3)), NOW), [{ id: "b2", tool: "Bash", what: "", startedAt: T(3) }]);
});

test("pendingBackground: a completion notice that is only queued still owes a wake (a lead's notice sat queued 10 min, 2026-10-28)", () => {
  const start = [rec.bashUse("ba1ctc12l", 20), rec.bashStarted("ba1ctc12l", 20)];
  assert.deepEqual(pendingBackground(jsonl(...start, rec.queued(["ba1ctc12l"], "completed", 10)), NOW).map((t) => t.id), ["ba1ctc12l"]);
  assert.deepEqual(pendingBackground(jsonl(...start, rec.queued(["ba1ctc12l"], "completed", 10), rec.removed(["ba1ctc12l"], "completed", 1)), NOW), []);
  // A Monitor past its timeout stays pending while its expiry notice sits queued, and ends once it's delivered.
  const mon = [rec.monitorUse("m1", 40), rec.monitorStarted("m1", 40), rec.queued(["m1"], "completed", 10)];
  assert.deepEqual(pendingBackground(jsonl(...mon), NOW).map((t) => t.id), ["m1"]);
  assert.deepEqual(pendingBackground(jsonl(...mon, rec.delivered(["m1"], "completed", 1)), NOW), []);
  // A delivered Monitor event clears its queued entry but ends nothing; an expired Monitor with nothing queued is done.
  const ev = [rec.monitorUse("m2", 40), rec.monitorStarted("m2", 40), rec.queued(["m2"], null, 20), rec.delivered(["m2"], null, 20)];
  assert.deepEqual(pendingBackground(jsonl(...ev), NOW), []);
  assert.deepEqual(pendingBackground(jsonl(...ev), Date.parse(T(15))).map((t) => t.id), ["m2"]);
  // A typed user message that quotes a notice (no task-notification origin) delivers nothing.
  const quoted = { type: "user", timestamp: T(2), message: { role: "user", content: rec.notice(["b9"], "completed", 2) } };
  assert.deepEqual(pendingBackground(jsonl(rec.bashStarted("b9", 5), quoted), NOW).map((t) => t.id), ["b9"]);
});

test("pendingBackground: a relevant line that doesn't parse (also a half-written last line) throws; irrelevant junk is ignored", () => {
  const start = jsonl(rec.bashUse("b1", 20), rec.bashStarted("b1", 20));
  assert.throws(() => pendingBackground(start + JSON.stringify(rec.delivered(["b1"], "completed", 1)).slice(0, 80), NOW), /transcript line 3 doesn't parse/);
  assert.throws(() => pendingBackground(JSON.stringify(rec.bashStarted("b2", 5)).slice(0, -3) + "\n" + start, NOW), /transcript line 1 doesn't parse/);
  assert.throws(() => pendingBackground(start + "not json {\n", NOW), /transcript line 3 doesn't parse/, "the last line is checked whatever it says");
  assert.equal(pendingBackground("not json {\n" + start, NOW).length, 1, "junk that mentions no background work, before the last line");
});

// A Claude config dir's projects/<cwd>/<native id>.jsonl, with the given transcripts.
function projectsDir(transcripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reap-projects-"));
  fs.mkdirSync(path.join(dir, "-home-user-other"));
  fs.mkdirSync(path.join(dir, "-mnt-c-research"));
  for (const [id, text] of Object.entries(transcripts)) fs.writeFileSync(path.join(dir, "-mnt-c-research", `${id}.jsonl`), text);
  return dir;
}

test("sessionBackground: reads <projects>/<any cwd>/<native id>.jsonl; no id or no file is an error, not a throw", () => {
  const dir = projectsDir({ "n-s5": s5Pending() });
  assert.deepEqual(sessionBackground({ nativeId: "n-s5" }, { projectsDir: dir, now: NOW }).pending.map((t) => t.id), ["bjgdsn47r", "bjyqpeddl"]);
  assert.deepEqual(sessionBackground({ nativeId: null }, { projectsDir: dir, now: NOW }), { error: "no Claude session id in T3" });
  assert.deepEqual(sessionBackground({ nativeId: "n-gone" }, { projectsDir: dir, now: NOW }), { error: "no transcript n-gone.jsonl" });
  assert.match(sessionBackground({ nativeId: "n-s5" }, { projectsDir: path.join(dir, "missing"), now: NOW }).error, /ENOENT/);
  fs.appendFileSync(path.join(dir, "-mnt-c-research", "n-s5.jsonl"), JSON.stringify(rec.queued(["bjgdsn47r"], "completed", 1)).slice(0, 90));
  assert.match(sessionBackground({ nativeId: "n-s5" }, { projectsDir: dir, now: NOW }).error, /doesn't parse/);
});

// The S5 case on the real SQL: an ended worker with its rerun still running is kept and logged; one whose
// job finished, and a settled thread whose transcript can't be found, are detached as before.
function backgroundTables() {
  const t = tables();
  const only = [child("done"), "settled", "archived"];
  for (const k of Object.keys(t)) t[k] = t[k].filter((r) => only.includes(r.child_thread_id ?? r.thread_id));
  const pt = (id, nativeId) => ({ provider_thread_id: `pt-${id}`, thread_id: id, provider: "claudeAgent_workers", provider_session_id: `ps-${id}`, status: "idle",
    updated_at: min(30), payload_json: JSON.stringify({ nativeThreadRef: { driver: "claudeAgent", nativeId, strength: "strong" } }) });
  t.orchestration_v2_projection_provider_threads = [pt(child("done"), "n-s5"), pt("settled", "n-s4"), pt("archived", "n-lost")];
  return t;
}
const s4Done = () => jsonl(rec.bashUse("bymoe6v14", 40), rec.bashStarted("bymoe6v14", 40), rec.queued(["bymoe6v14"], "completed", 38), rec.delivered(["bymoe6v14"], "completed", 38));

test("liveSessions: each session's native Claude session id from its provider thread", () => {
  const byId = Object.fromEntries(liveSessions({}, v2(backgroundTables())).map((s) => [s.threadId, s.nativeId]));
  assert.deepEqual(byId, { settled: "n-s4", archived: "n-lost", [child("done")]: "n-s5" });
  assert.equal(liveSessions({}, v2(tables())).find((s) => s.threadId === "open").nativeId, null);
});

test("reap: a session with background work pending is kept and logged; finished work or an unreadable transcript is detached as before", async () => {
  const sent = [], log = tmpLog(), out = [];
  const dir = projectsDir({ "n-s5": s5Pending(), "n-s4": s4Done() });
  const r = await reap({ now: () => NOW, query: v2(backgroundTables()), send: async (c) => sent.push(c.threadId), log, out: (l) => out.push(l),
    background: (s) => sessionBackground(s, { projectsDir: dir, now: NOW }) });
  assert.deepEqual(sent.sort(), ["archived", "settled"]);
  assert.deepEqual(r.kept.map((s) => [s.threadId, s.pending.map((t) => t.id)]), [[child("done"), ["bjgdsn47r", "bjyqpeddl"]]]);
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines.find((l) => l.includes(" kept ")), `2026-10-27T12:00:00.000Z kept ${child("done")} "${child("done")}" state=task-ended idle=30m: background work pending `
    + `(Bash bjgdsn47r "Rerun the full S5 matrix on the fixed source", started ${T(15)}; Monitor bjyqpeddl "S5 full-matrix rerun finishing", started ${T(12)})`);
  assert.match(lines.find((l) => l.includes(" settled ")), /detached settled "settled" state=settled idle=30m$/);
  assert.match(lines.find((l) => l.includes(" archived ")), /detached archived "archived" state=archived idle=30m \(background work not checked: no transcript n-lost.jsonl\)$/);
  assert.ok(out.some((l) => l.startsWith(`kept ${child("done")}`)));
});

test("reap --dry-run shows the kept session and the unchecked one, writes nothing", async () => {
  const sent = [], log = tmpLog(), out = [];
  const dir = projectsDir({ "n-s5": s5Pending(), "n-s4": s4Done() });
  const r = await reap({ dryRun: true, now: () => NOW, query: v2(backgroundTables()), send: async (c) => sent.push(c), log, out: (l) => out.push(l),
    background: (s) => sessionBackground(s, { projectsDir: dir, now: NOW }) });
  assert.deepEqual(sent, []);
  assert.equal(fs.existsSync(log), false);
  assert.deepEqual(r.candidates.map((c) => [c.threadId, c.backgroundNotChecked]).sort(), [["archived", "no transcript n-lost.jsonl"], ["settled", undefined]]);
  assert.equal(r.kept.length, 1);
  assert.ok(out.some((l) => l.startsWith(`would keep ${child("done")}`) && l.includes("background work pending (Bash bjgdsn47r")));
  assert.ok(out.some((l) => l === `would detach archived "archived" state=archived idle=30m (background work not checked: no transcript n-lost.jsonl)`));
});

test("reap: once the job's notice arrives (the worker woke and finished), a later sweep detaches it", async () => {
  const sent = [];
  const dir = projectsDir({ "n-s5": s5Pending() + jsonl(rec.queued(["bjyqpeddl"], "completed", 2), rec.queued(["bjgdsn47r"], "completed", 2),
    rec.removed(["bjyqpeddl"], "completed", 1), rec.removed(["bjgdsn47r"], "completed", 1)), "n-s4": s4Done() });
  const r = await reap({ now: () => NOW, query: v2(backgroundTables()), send: async (c) => sent.push(c.threadId), log: tmpLog(), out: () => {},
    background: (s) => sessionBackground(s, { projectsDir: dir, now: NOW }) });
  assert.deepEqual(r.kept, []);
  assert.deepEqual(sent.sort(), ["archived", "settled", child("done")].sort());
});

test("reap: a session with a live run is never read or kept, just left alone as before", async () => {
  const read = [];
  const r = await reap({ dryRun: true, now: () => NOW, query: v2(tables()), out: () => {}, background: (s) => { read.push(s.threadId); return { pending: [] }; } });
  assert.ok(!read.some((id) => ["settled-running", "settled-queued", "open", child("running"), "settled-recent"].includes(id)));
  assert.deepEqual(r.kept, []);
});

test("reap: the kept line is logged when a session is newly kept or its pending work changes, not every sweep", async () => {
  const log = tmpLog();
  const sweep = (text, at = NOW) => reap({ now: () => at, query: v2(backgroundTables()), send: async () => {}, log, out: () => {},
    background: (s) => sessionBackground(s, { projectsDir: projectsDir({ "n-s5": text, "n-s4": s4Done() }), now: at }) });
  const kept = () => fs.readFileSync(log, "utf8").trim().split("\n").filter((l) => l.split(" ")[1] === "kept");
  await sweep(s5Pending());
  await sweep(s5Pending(), NOW + 5 * 60000);
  assert.equal(kept().length, 1, "same pending work, one line");
  const more = s5Pending() + jsonl(rec.bashUse("bnew", 1), rec.bashStarted("bnew", 1));
  await sweep(more, NOW + 10 * 60000);
  assert.equal(kept().length, 2, "new pending work, a new line");
  assert.match(kept()[1], /bnew/);
  await sweep(more, NOW + 15 * 60000);
  assert.equal(kept().length, 2);
});

// Codex rollout records, shaped as in ~/.codex/sessions (cli 0.164).
const cx = {
  meta: (id) => ({ timestamp: min(30), type: "session_meta", payload: { id, session_id: id, originator: "T3 Code" } }),
  started: (turn) => ({ timestamp: min(30), type: "event_msg", payload: { type: "task_started", turn_id: turn } }),
  complete: (turn) => ({ timestamp: min(1), type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: "done" } }),
  aborted: (turn) => ({ timestamp: min(1), type: "event_msg", payload: { type: "turn_aborted", turn_id: turn, reason: "interrupted" } }),
  exec: (id) => ({ timestamp: min(20), type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: id, name: "exec", input: "await tools.exec_command({cmd:\"pytest\"})" } }),
  execOut: (id) => ({ timestamp: min(19), type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: "Script completed" }] } }),
  call: (id, name, args = "{}") => ({ timestamp: min(20), type: "response_item", payload: { type: "function_call", name, arguments: args, call_id: id } }),
  out: (id, output = "") => ({ timestamp: min(19), type: "response_item", payload: { type: "function_call_output", call_id: id, output } }),
  agent: (kind, callId, agent) => ({ timestamp: min(18), type: "event_msg", payload: { type: "item_completed",
    item: { type: "SubAgentActivity", kind, id: callId, agent_thread_id: agent, agent_path: `/root/${agent}` } } }),
  tokens: () => ({ timestamp: min(1), type: "event_msg", payload: { type: "token_count", info: null } }),
};
// A spawn_agent call, its started activity and its output.
const spawn = (callId, agent) => [cx.call(callId, "spawn_agent", `{"task_name":"${agent}"}`), cx.agent("started", callId, agent), cx.out(callId, `{"task_name":"/root/${agent}"}`)];

test("codexPending: a finished turn owes nothing; an open turn, a tool call without its output, or a running spawned agent is pending", () => {
  const done = jsonl(cx.meta("n"), cx.started("t1"), cx.exec("c1"), cx.execOut("c1"), cx.call("w1", "wait", "{\"ms\":5000}"), cx.out("w1", "ok"), cx.complete("t1"), cx.tokens());
  assert.deepEqual(codexPending(done), []);
  assert.throws(() => codexPending(""), /no task_started/, "an empty rollout is unknown, not finished");
  assert.throws(() => codexPending(jsonl(cx.meta("n"))), /no task_started/, "a metadata-only rollout is unknown, not finished");
  assert.deepEqual(codexPending(jsonl(cx.meta("n"), cx.started("t1"), cx.exec("c1"), cx.execOut("c1"))).map((p) => `${p.tool} ${p.id}`), ["turn t1"]);
  assert.deepEqual(codexPending(jsonl(cx.started("t1"), cx.exec("c1"))).map((p) => `${p.tool} ${p.id}`), ["turn t1", "exec c1"]);
  assert.deepEqual(codexPending(jsonl(cx.started("t1"), cx.call("s1", "sleep"), cx.complete("t1"))).map((p) => `${p.tool} ${p.id}`), ["sleep s1"],
    "a call left without its output counts even after the turn ended");
  const live = jsonl(cx.started("t1"), ...spawn("sp1", "checks"), cx.complete("t1"));
  assert.deepEqual(codexPending(live).map((p) => `${p.tool} ${p.id} ${p.what}`), ["agent checks /root/checks"]);
});

test("codexPending: a spawned agent ends with its completed activity; followup_task runs it again, send_message doesn't", () => {
  const base = [cx.started("t1"), ...spawn("sp1", "a")];
  const finished = [...base, cx.agent("completed", "subagent-completed-1", "a")];
  assert.deepEqual(codexPending(jsonl(...finished, cx.complete("t1"))), []);
  const msg = [...finished, cx.call("m1", "send_message"), cx.agent("interacted", "m1", "a"), cx.out("m1"), cx.complete("t1")];
  assert.deepEqual(codexPending(jsonl(...msg)), [], "a message alone starts no turn");
  const follow = [...finished, cx.call("f1", "followup_task"), cx.agent("interacted", "f1", "a"), cx.out("f1"), cx.complete("t1")];
  assert.deepEqual(codexPending(jsonl(...follow)).map((p) => p.id), ["a"]);
  assert.deepEqual(codexPending(jsonl(...follow, cx.agent("completed", "subagent-completed-2", "a"))), []);
});

test("codexPending: an aborted turn or a new turn ends earlier turns and calls (a spawn cut off by an interrupt, a session resumed after a kill)", () => {
  assert.deepEqual(codexPending(jsonl(cx.started("t1"), cx.call("sp1", "spawn_agent"), cx.aborted("t1"))), []);
  assert.deepEqual(codexPending(jsonl(cx.started("t1"), cx.exec("c1"), cx.started("t2"), cx.complete("t2"))), []);
  assert.deepEqual(codexPending(jsonl(cx.started("t1"), ...spawn("sp1", "a"), cx.aborted("t1"))).map((p) => p.tool), ["agent"], "a spawned agent outlives the turn");
});

test("codexPending: a relevant line that doesn't parse (also a half-written last line) throws; irrelevant junk is ignored", () => {
  const start = jsonl(cx.started("t1"), cx.exec("c1"));
  assert.throws(() => codexPending(start + JSON.stringify(cx.execOut("c1")).slice(0, 70)), /rollout line 3 doesn't parse/);
  assert.throws(() => codexPending(JSON.stringify(cx.complete("t1")).slice(0, -3) + "\n" + start), /rollout line 1 doesn't parse/);
  assert.equal(codexPending("not json {\n" + start).length, 2);
});

// Codex homes' sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, with the given rollouts on the given days.
function codexSessions(rollouts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reap-codex-"));
  for (const [day, id, text] of rollouts) {
    fs.mkdirSync(path.join(dir, day), { recursive: true });
    fs.writeFileSync(path.join(dir, day, `rollout-${day.replaceAll("/", "-")}T07-59-49-${id}.jsonl`), text);
  }
  return dir;
}

test("codexBackground: finds the rollout by native id in any Codex home and day; no id, no rollout or a bad line is an error, not a throw", () => {
  const a = codexSessions([["2026/10/28", "01a1-done", jsonl(cx.started("t1"), cx.complete("t1"))]]);
  const b = codexSessions([["2026/10/30", "01a1-open", jsonl(cx.started("t1"), cx.exec("c1"))], ["2026/10/29", "01a1-other", ""]]);
  fs.writeFileSync(path.join(b, "2026", "stray.txt"), "");
  const dirs = { sessionsDirs: [a, b] };
  assert.deepEqual(codexBackground({ nativeId: "01a1-done" }, dirs), { pending: [] });
  assert.deepEqual(codexBackground({ nativeId: "01a1-open" }, dirs).pending.map((p) => p.tool), ["turn", "exec"]);
  assert.deepEqual(codexBackground({ nativeId: null }, dirs), { error: "no Codex thread id in T3" });
  assert.deepEqual(codexBackground({ nativeId: "01a1-gone" }, dirs), { error: "no rollout *-01a1-gone.jsonl" });
  assert.match(codexBackground({ nativeId: "01a1-done" }, { sessionsDirs: [path.join(a, "missing")] }).error, /ENOENT/);
  fs.appendFileSync(path.join(a, "2026/10/28/rollout-2026-10-28T07-59-49-01a1-done.jsonl"), "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_sta");
  assert.match(codexBackground({ nativeId: "01a1-done" }, dirs).error, /doesn't parse/);
});

test("liveSessions: a shared Codex session gives each thread its own native id, not the session's newest", () => {
  const t = tables();
  const sid = "provider-session:provider-instance:codex:shared";
  t.orchestration_v2_projection_provider_sessions.push({ provider_session_id: sid, thread_id: "cx-a", provider: "codex", status: "ready", model: "gpt-6.1-sol",
    updated_at: min(5), payload_json: "{}", driver: "codex", provider_instance_id: "codex" });
  t.orchestration_v2_projection_provider_session_bindings.push({ provider_session_id: sid, thread_id: "cx-a" });
  for (const [id, native, at] of [["cx-a", "01a1-a", 30], ["cx-b", "01a1-b", 2]]) {
    t.orchestration_v2_projection_provider_threads.push({ provider_thread_id: `pt-${id}`, thread_id: id, provider: "codex", provider_session_id: sid, status: "idle",
      updated_at: min(at), payload_json: JSON.stringify({ nativeThreadRef: { driver: "codex", nativeId: native, strength: "strong" } }) });
  }
  const s = liveSessions({ driver: null }, v2(t)).find((x) => x.threadId === "cx-a");
  assert.equal(s.nativeId, "01a1-a");
});

// A shared Codex session: two threads bound to it, the session row naming the newest.
// cx-done is settled and idle 30 min, cx-open is open, cx-busy is settled but its rollout has an
// open turn. The session itself was updated 1 min ago (another thread ran), which must not make
// cx-done look recent.
function sharedCodex() {
  const t = tables();
  const sid = "provider-session:provider-instance:codex:shared";
  t.orchestration_v2_projection_provider_sessions.push({ provider_session_id: sid, thread_id: "cx-open", provider: "codex", status: "ready", model: "gpt-6.1-sol",
    updated_at: min(1), payload_json: "{}", driver: "codex", provider_instance_id: "codex" });
  const stopped = "provider-session:provider-instance:codex_alt:shared";
  t.orchestration_v2_projection_provider_sessions.push({ provider_session_id: stopped, thread_id: "cx-stopped", provider: "codex", status: "stopped", model: "gpt-6.1-sol",
    updated_at: min(60), payload_json: "{}", driver: "codex", provider_instance_id: "codex_alt" });
  for (const [id, payload, bound, ran] of [["cx-done", { settledAt: min(35) }, sid, 40], ["cx-open", {}, sid, 1], ["cx-busy", { settledAt: min(35) }, sid, 40], ["cx-stopped", { settledAt: min(35) }, stopped, 40]]) {
    t.orchestration_v2_projection_threads.push({ thread_id: id, project_id: "p", title: id, default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default",
      created_at: min(120), updated_at: min(ran), payload_json: JSON.stringify({ id, title: id, ...payload }) });
    t.orchestration_v2_projection_runs.push({ run_id: `${id}:r0`, thread_id: id, ordinal: 1, provider: "codex", status: "completed",
      requested_at: min(ran + 1), completed_at: min(ran), payload_json: JSON.stringify({ startedAt: min(ran + 1) }) });
    t.orchestration_v2_projection_provider_session_bindings.push({ provider_session_id: bound, thread_id: id });
    t.orchestration_v2_projection_provider_threads.push({ provider_thread_id: `pt-${id}`, thread_id: id, provider: "codex", provider_session_id: bound, status: "idle",
      updated_at: min(ran), payload_json: JSON.stringify({ nativeThreadRef: { driver: "codex", nativeId: `n-${id}`, strength: "strong" } }) });
  }
  return t;
}

test("liveSessions: every thread bound to a shared Codex session is listed, its activity its own, not the session's", () => {
  const byId = Object.fromEntries(liveSessions({ driver: "codex" }, v2(sharedCodex())).map((s) => [s.threadId, s]));
  assert.deepEqual(Object.keys(byId).sort(), ["cx-busy", "cx-done", "cx-open"], "a stopped shared session is not live");
  assert.equal(byId["cx-done"].shared, true);
  assert.equal(byId["cx-done"].providerSessionId, "provider-session:provider-instance:codex:shared");
  assert.equal(byId["cx-done"].nativeId, "n-cx-done");
  assert.equal(byId["cx-done"].lastActivityAt, min(40), "the shared session's fresh updated_at doesn't count");
  assert.equal(byId["cx-open"].lastActivityAt, min(1));
  const claude = liveSessions({}, v2(sharedCodex())).find((s) => s.threadId === "settled");
  assert.equal(claude.shared, undefined);
  assert.equal(claude.lastActivityAt, min(30), "a Claude session's own update still counts");
});

test("reap: detaches a finished Codex thread from its shared session, keeps open ones and ones with work pending", async () => {
  const sent = [], out = [];
  const r = await reap({ now: () => NOW, query: v2(sharedCodex()), send: async (c) => sent.push(c), log: tmpLog(), out: (l) => out.push(l),
    background: (s) => (s.threadId === "cx-busy" ? { pending: [{ id: "t1", tool: "turn", what: "", startedAt: min(40) }] } : { pending: [] }) });
  const codex = sent.filter((c) => c.threadId.startsWith("cx-")).map((c) => [c.threadId, c.providerSessionId]);
  assert.deepEqual(codex, [["cx-done", "provider-session:provider-instance:codex:shared"]]);
  assert.deepEqual(r.kept.map((k) => k.threadId), ["cx-busy"]);
  assert.ok(sent.some((c) => c.threadId === "settled"), "Claude sessions are still reaped");
  assert.ok(!sent.some((c) => c.threadId === "other-driver"), "other providers are left to T3");
});

test("reap: the default background check reads a Codex thread's rollout, not a Claude transcript", async () => {
  const sent = [];
  // No Codex home holds n-cx-done's rollout: detached, its line says so (same rule as an unreadable Claude transcript).
  const r = await reap({ dryRun: true, now: () => NOW, query: v2(sharedCodex()), send: async (c) => sent.push(c), out: () => {} });
  const done = r.candidates.find((c) => c.threadId === "cx-done");
  assert.match(done.backgroundNotChecked, /no rollout \*-n-cx-done\.jsonl|ENOENT|no Codex/);
});
