#!/usr/bin/env node
// Close the Claude and Codex sessions of finished T3 threads, so their `claude` processes (~250 MB
// each, plus their MCP servers) don't wait out T3's own idle release (30 min, and up to 4 h for a
// worker that left background work behind). A Codex account runs one shared session (one
// `codex app-server`) for all its threads: detaching one thread from it only unloads that thread
// (app-server thread/unsubscribe); the shared process keeps running.
//
//   node reap-sessions.mjs [--idle-min 5] [--dry-run] [--json]
//
// A live session (ready and bound, see liveSessions in t3-api.mjs) is detached when its thread
// is finished: settled, archived, snoozed, or a delegate_task child whose task is no longer
// running. It must also have no live run (preparing, starting, running, waiting, or queued and
// not held), no delegate_task child of its own still running, and nothing in it for --idle-min
// minutes. Open threads keep T3's default. The thread
// keeps its native session, so a later message resumes it with its whole conversation.
// A session whose Claude transcript shows a background Bash command or Monitor still running is
// kept: its completion notice wakes the agent, and only the live `claude` process can deliver it
// (a worker detached 4 min before its acceptance rerun finished slept for 3.5 h); so is
// a Codex thread whose rollout shows an open turn, tool call or spawned agent.
// Each detach, keep (and each failure) is one line in ~/.local/state/agent-stats/reap-sessions.log;
// a failure also makes the exit code nonzero. reap-sessions.timer runs this every 5 minutes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claude, codexAccounts } from "./accounts.mjs";
import { detachSession, liveSessions, t3Connect, t3Query } from "./t3-api.mjs";

const reaped = ["claudeAgent", "codex"];

export const logFile = path.join(os.homedir(), ".local/state/agent-stats/reap-sessions.log");

// Why a session's thread counts as finished ("settled", "archived", "snoozed", "task-ended"),
// or null when it is open. A snooze that has passed means the thread woke: open.
export function finishedState(s, now = Date.now()) {
  if (s.deleted) return null;
  if (s.archivedAt) return "archived";
  if (s.settled) return "settled";
  if (s.snoozedUntil && Date.parse(s.snoozedUntil) > now) return "snoozed";
  if (s.child && s.tasksRunning === 0) return "task-ended";
  return null;
}

// The sessions to detach, each with `state` and `idleMin` (whole minutes since its last activity).
export function reapable(sessions, { now = Date.now(), idleMin = 5 } = {}) {
  return sessions.flatMap((s) => {
    const state = finishedState(s, now);
    if (!state || s.liveRuns > 0 || s.tasksRunning > 0 || s.childrenRunning > 0 || !s.lastActivityAt) return [];
    const idle = Math.floor((now - Date.parse(s.lastActivityAt)) / 60000);
    return idle >= idleMin ? [{ ...s, state, idleMin: idle }] : [];
  });
}

// Background work a Claude transcript (one JSONL session log) still owes a completion notice for:
// [{ id, tool, what, startedAt }]. Shapes checked on real workers and a lead that waited
// 10 min on a queued notice:
// - start: the tool's `user` result record has toolUseResult.backgroundTaskId (Bash run in the
//   background) or toolUseResult.taskId + timeoutMs (Monitor; `persistent` when it has no timeout);
// - notice: a <task-notification> naming the task (one notice can name several). It is first queued
//   (`queue-operation` enqueue) and only reaches the agent when delivered: a `user` record with
//   origin.kind "task-notification", or a `queue-operation` remove (the notice rides into the next
//   turn as a queued_command attachment). A queued notice still owes the agent a wake.
// - end: a delivered notice with a <status> (completed, failed, killed, stopped); Monitor events
//   carry no <status> and end nothing. A TaskStop call ends its task_id too, and a Monitor ends
//   when its timeout passes (that leaves no record) unless a notice of its is still queued.
// A line that mentions any of this but doesn't parse throws, and so does a last line that doesn't
// parse (it may be half-written, cut anywhere): the caller can't tell what is pending.
export function pendingBackground(text, now = Date.now()) {
  const uses = new Map(), started = new Map(), ended = new Set(), queued = new Map();
  const ids = (notice) => [...notice.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1]);
  const lines = text.split("\n");
  const last = lines.findLastIndex((l) => l.trim());
  lines.forEach((raw, i) => {
    if (i !== last && !/backgroundTaskId|"timeoutMs"|<task-id>|"TaskStop"|"Monitor"|run_in_background/.test(raw)) return;
    let r;
    try { r = JSON.parse(raw); } catch (e) { throw new Error(`transcript line ${i + 1} doesn't parse (${e.message})`); }
    const content = r.message?.content;
    if (r.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type !== "tool_use") continue;
        uses.set(b.id, b);
        if (b.name === "TaskStop" && b.input?.task_id) ended.add(b.input.task_id);
      }
      return;
    }
    let notice = null, delivered = false;
    if (r.type === "queue-operation" && r.operation === "enqueue" && typeof r.content === "string") {
      for (const id of ids(r.content)) queued.set(id, (queued.get(id) ?? 0) + 1);
      return;
    }
    if (r.type === "queue-operation" && r.operation === "remove") { notice = r.content; delivered = true; }
    else if (r.type === "user") {
      const res = r.toolUseResult;
      const id = res?.backgroundTaskId ?? (res?.taskId && res.timeoutMs !== undefined ? res.taskId : null);
      if (id) {
        const use = uses.get(Array.isArray(content) ? content.find((b) => b.type === "tool_result")?.tool_use_id : null);
        const ms = Date.parse(r.timestamp);
        started.set(id, { id, tool: use?.name ?? (res.backgroundTaskId ? "Bash" : "Monitor"), what: use?.input?.description ?? use?.input?.command?.slice(0, 60) ?? "",
          startedAt: r.timestamp ?? null, expiresAt: res.backgroundTaskId || res.persistent || !res.timeoutMs ? Infinity : ms + res.timeoutMs });
      }
      if (r.origin?.kind === "task-notification") {
        notice = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : null;
        delivered = true;
      }
    }
    if (!delivered || typeof notice !== "string" || !notice.includes("<task-notification>")) return;
    for (const id of ids(notice)) {
      if (queued.get(id)) queued.set(id, queued.get(id) - 1);
      if (notice.includes("<status>")) ended.add(id);
    }
  });
  return [...started.values()].filter((t) => !ended.has(t.id) && (queued.get(t.id) || !(t.expiresAt <= now))).map(({ expiresAt, ...t }) => t);
}

// The pending background work of a live session, from its transcript under the Claude config dir's
// projects/<cwd>/<native id>.jsonl: { pending } or, when it can't be read, { error }.
export function sessionBackground(s, { projectsDir = path.join(claude.configDir, "projects"), now = Date.now() } = {}) {
  try {
    if (!s.nativeId) return { error: "no Claude session id in T3" };
    const file = fs.readdirSync(projectsDir).map((d) => path.join(projectsDir, d, `${s.nativeId}.jsonl`)).find((f) => fs.existsSync(f));
    if (!file) return { error: `no transcript ${s.nativeId}.jsonl` };
    return { pending: pendingBackground(fs.readFileSync(file, "utf8"), now) };
  } catch (e) { return { error: e.message }; }
}

// Work a Codex rollout (one JSONL session log) still owes before its session is done:
// [{ id, tool, what, startedAt }]. Shapes checked on sol61 reviews and leads in ~/.codex/sessions
// (2026-10-28..30, cli 0.164):
// - turn: event_msg task_started, ended by event_msg task_complete (same turn_id) or turn_aborted.
//   A session runs one turn at a time, so a new task_started or a turn_aborted also ends every
//   earlier turn and tool call (a session killed mid-turn and resumed, or a spawn_agent call cut
//   off by an interrupt, 2026-10-27);
// - tool call: response_item custom_tool_call (exec) or function_call (wait, sleep, spawn_agent,
//   send_message, wait_agent, ...) with a call_id, answered by custom_tool_call_output or
//   function_call_output with that call_id ("aborted before dispatch" is an answer too);
// - spawned agent: event_msg item_completed with item SubAgentActivity per agent_thread_id: kind
//   "started" (spawn_agent) runs it; "interacted" from followup_task runs it again, from send_message
//   it doesn't (a message waits for its next turn); "completed" ends its turn. Its completion wakes
//   the parent, so a running one keeps the session.
// A line that mentions any of this but doesn't parse throws, and so does a last line that doesn't
// parse or a rollout with no task_started at all (empty or metadata only): the caller can't tell
// what is pending.
export function codexPending(text) {
  const turns = new Map(), calls = new Map(), names = new Map(), agents = new Map();
  let started = false;
  const lines = text.split("\n");
  const last = lines.findLastIndex((l) => l.trim());
  lines.forEach((raw, i) => {
    if (i !== last && !/"task_started"|"task_complete"|"turn_aborted"|"call_id"|SubAgentActivity/.test(raw)) return;
    let r;
    try { r = JSON.parse(raw); } catch (e) { throw new Error(`rollout line ${i + 1} doesn't parse (${e.message})`); }
    const p = r.payload ?? {};
    if (p.type === "task_started" || p.type === "turn_aborted") { turns.clear(); calls.clear(); }
    if (p.type === "task_started") started = true;
    if (p.type === "task_started") turns.set(p.turn_id, { id: p.turn_id, tool: "turn", what: "", startedAt: r.timestamp ?? null });
    else if (p.type === "task_complete") turns.delete(p.turn_id);
    else if ((p.type === "custom_tool_call" || p.type === "function_call") && p.call_id) {
      names.set(p.call_id, p.name);
      calls.set(p.call_id, { id: p.call_id, tool: p.name ?? p.type, what: String(p.input ?? p.arguments ?? "").slice(0, 60), startedAt: r.timestamp ?? null });
    } else if (p.type === "custom_tool_call_output" || p.type === "function_call_output") calls.delete(p.call_id);
    else if (p.item?.type === "SubAgentActivity") {
      const a = p.item;
      if (a.kind === "completed") agents.delete(a.agent_thread_id);
      else if (a.kind === "started" || (a.kind === "interacted" && names.get(a.id) === "followup_task")) {
        agents.set(a.agent_thread_id, { id: a.agent_thread_id, tool: "agent", what: a.agent_path ?? "", startedAt: r.timestamp ?? null });
      }
    }
  });
  if (!started) throw new Error("rollout has no task_started yet");
  return [...turns.values(), ...calls.values(), ...agents.values()];
}

// The Codex session directories: each account's home/sessions, once each (homes can share one
// through a symlink).
export const codexSessionsDirs = () => [...new Set(codexAccounts.map((a) => path.join(a.home, "sessions")).filter((d) => fs.existsSync(d)).map((d) => fs.realpathSync(d)))];

// The pending work of a live Codex session, from its rollout <sessions>/YYYY/MM/DD/rollout-<time>-<native id>.jsonl
// in any Codex home: { pending } or, when it can't be found or read, { error }.
export function codexBackground(s, { sessionsDirs = codexSessionsDirs() } = {}) {
  try {
    if (!s.nativeId) return { error: "no Codex thread id in T3" };
    const suffix = `-${s.nativeId}.jsonl`;
    for (const root of sessionsDirs) {
      const days = [];
      for (const y of fs.readdirSync(root)) for (const m of safeDir(path.join(root, y))) for (const d of safeDir(path.join(root, y, m))) days.push(path.join(root, y, m, d));
      for (const day of days.sort().reverse()) {
        const name = safeDir(day).find((f) => f.startsWith("rollout-") && f.endsWith(suffix));
        if (name) return { pending: codexPending(fs.readFileSync(path.join(day, name), "utf8")) };
      }
    }
    return { error: `no rollout *${suffix}` };
  } catch (e) { return { error: e.message }; }
}
const safeDir = (d) => { try { return fs.readdirSync(d); } catch (e) { if (e.code === "ENOTDIR") return []; throw e; } };

const pendingText = (pending) => pending.map((t) => `${t.tool} ${t.id}${t.what ? ` "${t.what}"` : ""}, started ${t.startedAt}`).join("; ");
const line = (s) => `${s.threadId} "${s.title ?? ""}" state=${s.state} idle=${s.idleMin}m`;

// One sweep. `query` reads T3's DB, `send` sends a command, `connect` (when given) runs once
// before the first detach and may return a `send` (one socket for the whole sweep). The list is
// read again right before each detach (a detach can take seconds to answer), so a thread that got
// a message meanwhile, or whose session changed, is left alone. `background(s)` reads a session's
// pending background work (sessionBackground for Claude, codexBackground for Codex): pending work
// keeps the session, and a session whose transcript or rollout can't be read is detached as
// before, its line saying so. Other providers' sessions are left to T3.
export async function reap({ idleMin = 5, dryRun = false, now = () => Date.now(), query = t3Query, send, connect, log = logFile, out = console.log,
  background = (s) => (s.driver === "codex" ? codexBackground(s) : sessionBackground(s, { now: now() })) } = {}) {
  const pick = () => reapable(liveSessions({ driver: null }, query).filter((s) => reaped.includes(s.driver)), { now: now(), idleMin });
  const write = (text) => { if (dryRun) return; fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, `${new Date(now()).toISOString()} ${text}\n`); };
  const kept = [], unchecked = new Map();
  const candidates = pick().filter((s) => {
    const b = background(s);
    if (b.error) { unchecked.set(s.threadId, b.error); return true; }
    if (!b.pending.length) return true;
    kept.push({ ...s, pending: b.pending });
    return false;
  });
  const note = (s) => (unchecked.has(s.threadId) ? ` (background work not checked: ${unchecked.get(s.threadId)})` : "");
  const result = { dryRun, idleMin,
    candidates: candidates.map((s) => ({ threadId: s.threadId, title: s.title, state: s.state, idleMin: s.idleMin, ...(unchecked.has(s.threadId) ? { backgroundNotChecked: unchecked.get(s.threadId) } : {}) })),
    kept: kept.map((s) => ({ threadId: s.threadId, title: s.title, state: s.state, idleMin: s.idleMin, pending: s.pending })), detached: [], errors: [] };
  // The log gets a kept line when a session is newly kept or its pending work changed, not every sweep.
  const lastLine = new Map();
  if (kept.length && !dryRun) {
    try { for (const l of fs.readFileSync(log, "utf8").split("\n")) { const [, , threadId] = l.split(" "); if (threadId) lastLine.set(threadId, l); } }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  for (const s of kept) {
    const pending = `background work pending (${pendingText(s.pending)})`;
    const text = `${line(s)}: ${pending}`;
    const prev = lastLine.get(s.threadId);
    if (!(prev?.split(" ")[1] === "kept" && prev.endsWith(`: ${pending}`))) write(`kept ${text}`);
    out(`${dryRun ? "would keep" : "kept"} ${text}`);
  }
  if (dryRun || !candidates.length) {
    for (const s of candidates) out(`would detach ${line(s)}${note(s)}`);
    return result;
  }
  if (connect) {
    try { send = (await connect()) ?? send; }
    catch (e) {
      // No server, no processes: the rows are left over until T3 starts and settles them.
      if (e.notRunning) { out(`${e.message}; nothing to detach`); return result; }
      write(`error connect: ${e.message}`);
      result.errors.push({ threadId: null, error: e.message });
      return result;
    }
  }
  for (const c of candidates) {
    const s = pick().find((x) => x.threadId === c.threadId && x.providerSessionId === c.providerSessionId);
    if (!s) { out(`skipped ${line(c)}: busy or changed since the first read`); continue; }
    try {
      await detachSession(s.threadId, s.providerSessionId, `reap-sessions: ${s.state}, idle ${s.idleMin} min`, send);
      write(`detached ${line(s)}${note(s)}`);
      out(`detached ${line(s)}${note(s)}`);
      result.detached.push(s.threadId);
    } catch (e) {
      write(`error ${line(s)}: ${e.message}`);
      out(`error ${line(s)}: ${e.message}`);
      result.errors.push({ threadId: s.threadId, error: e.message });
    }
  }
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const idleMin = Number(option("--idle-min", "5"));
  if (!(idleMin >= 0)) throw new Error("--idle-min must be a number of minutes");
  const json = args.includes("--json");
  let conn = null;
  const connect = async () => { conn = await t3Connect("reap sessions"); return (c) => conn.request("orchestration.dispatchCommand", c); };
  try {
    const r = await reap({ idleMin, dryRun: args.includes("--dry-run"), connect, out: json ? () => {} : console.log });
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(r.dryRun ? `would detach ${r.candidates.length} session(s), keep ${r.kept.length}`
      : `detached ${r.detached.length} session(s), kept ${r.kept.length}, ${r.errors.length} error(s)`);
    if (r.errors.length) process.exitCode = 1;
  } finally { conn?.close(); }
}
