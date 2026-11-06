#!/usr/bin/env node
// Archive old delegated worker threads so T3's sidebar keeps the orchestrators.
//
//   node prune-workers.mjs [--days 5] [--dry-run] [--delete]
//   node prune-workers.mjs --settle [--min 10] [--dry-run]
//
// --settle settles delegate_task children (and the provider subagent threads under them, and
// t3-thread.mjs worker threads a late helper report re-opened) once
// they have stopped for --min minutes (default 10): no live run, nothing queued, not snoozed by
// a usage limit, and no background work their live session still owes (see backgroundHold).
// T3 never settles them itself, so without this every finished child sat open in
// the sidebar until the 5-day archive (~900 of them at one point). A later fix round
// (t3_thread_send) still runs on a settled child. settle-workers.timer runs it with --min 0
// every minute, so a finished worker leaves T3's Working list within a minute.
//
// A worker thread ("[sol61] job", "[opus] job", or a TITLE fix name whose job dir
// recorded the thread; see isWorker in t3-api.mjs) is pruned once
// it is settled and nothing has happened in it for --days days (default 5). A delegate_task
// child is never settled, so it is pruned once it has stopped for good: no live run, no queued
// message waiting to start, its latest run ended, and nothing since for --days days. Archived
// threads keep their transcript and can be unarchived in T3; --delete removes them
// instead. Job reports stay in the job directories either way. Main threads are never
// touched. prune-workers.timer runs this daily.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { codexBackground, sessionBackground } from "./reap-sessions.mjs";
import { archiveThread, deleteThread, isWorker, listThreads, liveSessions, queuedRuns, settleThread } from "./t3-api.mjs";

const ENDED = ["completed", "failed", "cancelled", "interrupted"];
export const isChild = (t) => String(t.id).startsWith("thread:delegated-task:") || t.lineage?.relationshipToParent === "subagent";

// The worker threads (getThread/listThreads shape) settled before `cutoff` (ISO) with nothing
// since, and the delegate_task children that ended before it; archived ones only with
// `remove`. `worker` is isWorker and `waiting` gives a thread's queued, not held runs (tests
// pass their own).
export const pruneable = (threads, cutoff, { remove = false, worker = isWorker, waiting = (id) => queuedRuns(id, undefined, { held: false }) } = {}) =>
  threads.filter((t) => !t.deletedAt && (remove || !t.archivedAt) && (
    (t.settled && (t.settledAt ?? t.updatedAt) < cutoff && (t.updatedAt ?? t.settledAt) < cutoff && worker(t.id, t.title))
    || (isChild(t) && !t.activeRunId && ENDED.includes(t.status) && (t.latestRunCompletedAt ?? "") < cutoff
      && t.updatedAt < cutoff && waiting(t.id).length === 0)));

// The delegate_task children (and provider subagent threads, which never run a T3 run and sit
// "idle") stopped before `cutoff` (ISO) and not settled, archived or snoozed. Also t3-thread.mjs
// worker threads: the script settles them when their turn ends, but a report from a helper the
// worker started re-opens them after the job is done (seen with a reviewer). None
// while a helper of theirs still runs (its report needs an open thread) or while T3 still owes
// a usage-limit resume (it skips settled threads, and the resume can land after the reset time).
// A limited child T3 never resumes is archived by the 5-day prune. Nor while `held(t)` gives a
// reason (backgroundHold over every live session, read once per sweep; tests pass their own).
export const settleable = (threads, cutoff, { now = Date.now(), worker = isWorker, waiting = (id) => queuedRuns(id, undefined, { held: false }),
  held = holds() } = {}) =>
  threads.filter((t) => (isChild(t) || worker(t.id, t.title))
    && !threads.some((c) => c.lineage?.parentThreadId === t.id && (c.busy || c.activeRunId))
    && !t.usageLimitResetAt
    && !t.settled && !t.archivedAt && !t.deletedAt && !t.activeRunId && !t.busy
    && [...ENDED, "idle"].includes(t.status) && !(t.snoozedUntil && Date.parse(t.snoozedUntil) > now)
    && (t.latestRunCompletedAt ?? t.updatedAt ?? "") < cutoff && (t.updatedAt ?? "") < cutoff && waiting(t.id).length === 0
    && !held(t));

// Why a thread's live provider session still holds it open, or null. The evidence
// reap-sessions keeps a session for: a Claude transcript with background work (a Bash command or
// Monitor) still owing a completion notice, whose notice only the live `claude` process can
// deliver; a Codex rollout with an open turn, a tool call without its output, or a spawned agent
// still running (its completion wakes the parent); and a transcript or rollout that
// can't be found or read, since unknown evidence is never "finished". The other providers leave
// no record of background work this can read, so their live session holds the thread until T3
// itself closes it (its idle release). A thread with no live session has nothing left to deliver
// and settles.
export function backgroundHold(threadId, sessions, background = (s) => (s.driver === "codex" ? codexBackground(s) : sessionBackground(s))) {
  for (const s of sessions.filter((x) => x.threadId === threadId)) {
    if (s.driver !== "claudeAgent" && s.driver !== "codex") return `live ${s.driver} session (no background record to read)`;
    const b = background(s);
    if (b.error) return `background work not checked: ${b.error}`;
    if (b.pending.length) return `background work pending (${b.pending.map((p) => `${p.tool} ${p.id}`).join(", ")})`;
  }
  return null;
}

// held(t) over every provider's live sessions, listed on first use. `out` gets each hold.
function holds(out = () => {}) {
  let sessions = null;
  return (t) => {
    sessions ??= liveSessions({ driver: null });
    const why = backgroundHold(t.id, sessions);
    if (why) out(`kept ${t.id} ${t.title}: ${why}`);
    return !!why;
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const days = Number(option("--days", "5"));
  if (!(days > 0)) throw new Error("--days must be a positive number");
  const dryRun = args.includes("--dry-run");
  if (args.includes("--settle")) {
    const min = Number(option("--min", "10"));
    if (!(min >= 0)) throw new Error("--min must be a number of minutes");
    const children = settleable(listThreads(), new Date(Date.now() - min * 60000).toISOString(), { held: holds(console.log) });
    let settled = 0;
    for (const t of children) {
      if (dryRun) { console.log(`would settle ${t.id} ${t.title}`); continue; }
      try { await settleThread(t.id); settled += 1; } catch (e) { console.error(`${t.id} ${t.title}: ${e.message}`); process.exitCode = 1; }
    }
    if (children.length) console.log(`${dryRun ? "would settle" : "settled"} ${dryRun ? children.length : settled} finished worker thread(s)`);
    return;
  }
  const remove = args.includes("--delete");
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const workers = pruneable(listThreads({ includeArchived: remove }), cutoff, { remove });

  let done = 0;
  for (const t of workers) {
    if (dryRun) { console.log(`would ${remove ? "delete" : "archive"} ${t.id} ${t.title}`); continue; }
    try {
      await (remove ? deleteThread : archiveThread)(t.id);
      done += 1;
    } catch (e) { console.error(`${t.id} ${t.title}: ${e.message}`); process.exitCode = 1; }
  }
  console.log(`${dryRun ? "would prune" : remove ? "deleted" : "archived"} ${dryRun ? workers.length : done} worker thread(s) settled or finished over ${days} day(s) ago`);
}
