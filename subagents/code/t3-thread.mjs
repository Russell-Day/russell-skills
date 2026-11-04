#!/usr/bin/env node
// Run one delegated worker as a visible T3 Code thread, wait for its turn to
// finish, save the answer, then settle the thread (kept, not deleted).
//
//   node t3-thread.mjs <model> <prompt-file>
//
// Same labels and env overrides as run.sh (EFFORT, ACCOUNT, JOB, TIMEOUT), plus
// PROJECT_ROOT to pick the T3 project and NO_SETTLE=1. TITLE="<fix>" names the
// thread after its fix ("<fix> · <model>") instead of "[<model>] <job>"; the job
// dir records the thread id, which is how pacer, continuity and prune-workers
// still know it is a worker. PROJECT_ROOT defaults to
// the git root of the current directory; from a linked worktree it falls back to
// the main tree, since T3 projects are registered there.
//
//   node t3-thread.mjs --rename "<title>" [--thread <id>]
//
// renames the thread the caller runs in (found from its Claude Code or Codex
// session, as continuity.mjs does), or --thread.
//
//   node t3-thread.mjs --orchestrator "<title>" <brief-file> [--model opus] [--effort high]
//
// starts a MAIN thread (orchestrator profile) in the caller's T3 project, titled
// exactly <title>, with the brief as its first message (not pinned: T3's Working section shows
// it while it runs); prints its id
// and returns at once. No job dir, no wait, no settle: it is a main thread, not a
// worker (the triage thread starts one per group of items).
//
//   node t3-thread.mjs --compactions [threadId]
//
// prints how many times a thread's context was compacted (default: the thread the
// caller runs in, found as --rename does). After every run the job dir's
// `compactions` file holds the count for its thread, also printed on stderr.
//
// ATTACH=<threadId> re-polls a thread that is already running (say the wrapper
// was killed) instead of starting a new one; pass the same JOB. With CONTINUE=1
// the prompt file is sent as a follow-up turn on that thread, unless the thread
// has been compacted HANDOFF_COMPACTIONS (default 3) times or more: then a new
// thread (same model, effort, JOB and title) takes over, told the old thread's id,
// the job's last report.md and PLAN (if set). It first waits for the old thread's
// running turn to end and saves its reply as report.md; an EFFORT override applies to
// the new thread, and TITLE (else the old thread's title) names it. The old thread is settled
// before the new one starts; its id moves to `thread_ids_prev` and run.log gets
// `handoff <old>→<new> (N compactions)`.
//
// A reviewer (sol61, astra) attached under a JOB other than the one whose job dir records the
// thread (`thread_id`, or a line of `thread_ids_prev`) is a new stage: a fresh reviewer thread
// starts instead, and stderr and run.log say `new stage <oldjob>→<job>: fresh reviewer thread`.
// Rechecks pass the same JOB and continue. Workers continue under any JOB.
//
// A thread the job leaves for another (a limit fallback, a handoff, a Gemini thread while AGY
// is out) is abandoned before its replacement starts, NO_SETTLE or not: its live run is
// interrupted, its queued messages removed, and it is settled, so T3's own auto-resume after
// a reset doesn't revive it next to its replacement. If T3 refuses, nothing new starts: the
// job ends with exit_code 1 and the reason on stderr and in run.log.
//
// Every T3 call goes through t3-api.mjs (T3 0.1.0, orchestration v2): reads from its
// state DB, commands over its internal WebSocket API. After a `t3 update`, run
// `node t3-api.mjs --check`. run.sh is the headless fallback.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claude as claudeAccount, codexAccount as codexAccountByName, codexByInstance, codexDefault, codexFallback } from "./accounts.mjs";
import { agyOutUntil, noticeOnce, recordQuotaError } from "./agy-state.mjs";
import { abandonThread, compactionCount as compactions, createMainThread, createThread, currentThread, getThread, interruptThread, mainModelSelection, orchestratorArgs, projectFor, renameThread, runReplies, sendMessage, settleThread, workerThreadTitle } from "./t3-api.mjs";

if (process.argv[2] === "--compactions") {
  const threadId = process.argv[3] ?? currentThread();
  if (!threadId) { console.error("not running in a T3 Claude or Codex thread; pass a thread id"); process.exit(2); }
  console.log(compactions(threadId));
  process.exit(0);
}

if (process.argv[2] === "--rename") {
  const rest = process.argv.slice(3);
  const i = rest.indexOf("--thread");
  const threadId = i < 0 ? currentThread() : rest[i + 1];
  const title = rest.filter((_, j) => i < 0 || (j !== i && j !== i + 1))[0];
  if (!threadId) { console.error("not running in a T3 Claude or Codex thread; pass --thread <id>"); process.exit(2); }
  if (!title) { console.error('usage: t3-thread.mjs --rename "<title>" [--thread <id>]'); process.exit(2); }
  console.log(`renamed ${threadId} to "${await renameThread(threadId, title)}"`);
  process.exit(0);
}

// PROJECT_ROOT, else the git root of the current directory, else its main tree (a linked
// worktree's project is registered under the main tree).
function projectRoots() {
  if (process.env.PROJECT_ROOT) return [process.env.PROJECT_ROOT];
  const git = (...args) => { try { return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } };
  const toplevel = git("rev-parse", "--show-toplevel") ?? process.cwd();
  const commonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  return [toplevel, commonDir ? path.dirname(commonDir) : toplevel];
}

if (process.argv[2] === "--orchestrator") {
  let a;
  try { a = orchestratorArgs(process.argv.slice(3)); } catch (e) { console.error(e.message); process.exit(2); }
  const text = fs.readFileSync(a.briefFile, "utf8");
  const threadId = randomUUID();
  try {
    await createMainThread({ threadId, messageId: randomUUID(), projectId: projectFor(projectRoots()), title: a.title, text, modelSelection: mainModelSelection(a.model, a.effort) });
  } catch (e) { console.error(`orchestrator thread ${threadId}: ${e.message}`); process.exit(1); }
  console.log(threadId);
  process.exit(0);
}

const [model, promptSrc] = process.argv.slice(2);
if (!model || !promptSrc) {
  console.error("usage: t3-thread.mjs <sol|sol61|luna|astra|fable|opus|sonnet|haiku|gemini-flash> <prompt-file>");
  process.exit(2);
}

const home = os.homedir();
const here = path.dirname(new URL(import.meta.url).pathname);
const rootCandidates = projectRoots();

// Accounts come from accounts.local.json. ACCOUNT defaults to its codex.default.
// ACCOUNT=auto: non-reserve accounts first, soonest weekly reset first; reserve
// accounts last (see usage.mjs --pick-codex). `tried` holds accounts that
// already hit a limit this run.
const autoAccount = (process.env.ACCOUNT ?? codexDefault) === "auto";
const tried = [];
function codexAccount(modelId) {
  if (!autoAccount) return process.env.ACCOUNT ?? codexDefault;
  try {
    return execFileSync("node", [path.join(here, "usage.mjs"), "--pick-codex", modelId, "--exclude", tried.join(",")],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    if (tried.length) throw new Error("every Codex account is at its limit");
    return codexFallback;
  }
}
let codexName = null;
const codexInstanceFor = (modelId) => {
  const name = codexName = codexAccount(modelId);
  const instance = codexAccountByName(name)?.t3Instance;
  if (!instance) throw new Error(`unknown ACCOUNT: ${name}`);
  console.error(`codex account: ${name}`);
  return instance;
};

// Label -> T3 provider instance, exact model ID, option list (as the T3 UI sends it).
function selection(label) {
  const effort = process.env.EFFORT;
  const codex = (id, e) => ({
    instanceId: codexInstanceFor(id),
    model: id,
    options: [
      { id: "reasoningEffort", value: effort ?? e },
      { id: "serviceTier", value: "default" },
    ],
  });
  const claude = (id, extra, defaultEffort = "high") => ({
    // Same Claude account as orchestrators, with a 200K auto-compact window.
    instanceId: claudeAccount.t3WorkerInstance,
    model: id,
    options: [{ id: "effort", value: effort ?? defaultEffort }, ...extra, { id: "contextWindow", value: "200k" }],
  });
  switch (label) {
    case "sol": return codex("gpt-6-sol", "medium");
    case "sol61": return codex("gpt-6.1-sol", "medium");
    case "luna": return codex("gpt-6-luna", "xhigh");
    case "astra": return codex("gpt-6-astra", "low"); // EFFORT=medium for final checks
    case "fable": return claude("claude-fable-5-1", []);
    case "opus": return claude("claude-opus-5-5", [{ id: "fastMode", value: false }]);
    case "sonnet": return claude("claude-sonnet-5-5", [], "high");
    case "haiku": return claude("claude-haiku-5-5", [], "high");
    case "gemini-flash": // AGY encodes the level in the slug
      return { instanceId: "antigravity", model: `gemini-3.8-flash-${effort ?? "high"}` };
    default: throw new Error(`unknown model: ${label}`);
  }
}

function parseDuration(s) {
  const m = /^(\d+)([smh]?)$/.exec(s);
  if (!m) throw new Error(`bad TIMEOUT: ${s}`);
  return Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600 }[m[2]] * 1000;
}

let modelSelection = selection(model);
const timeoutMs = parseDuration(process.env.TIMEOUT ?? "45m");
const job = path.join(process.env.AGENT_JOBS_DIR ?? path.join(home, ".local/state/agent-jobs"),
  process.env.JOB ?? `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${model}-t3`);
fs.mkdirSync(job, { recursive: true });
fs.copyFileSync(promptSrc, path.join(job, "prompt.md"));
fs.appendFileSync(path.join(job, "prompt.md"), "\n\n" + fs.readFileSync(path.join(here, "worker-communication.md"), "utf8"));
const prompt = fs.readFileSync(path.join(job, "prompt.md"), "utf8");
const log = (...a) => fs.appendFileSync(path.join(job, "run.log"), `${new Date().toISOString()} ${a.join(" ")}\n`);
// The thread that started this job, so the pacer counts a working worker and its
// parent once. Every run rewrites it with its caller; a run from outside T3 writes nothing.
try { const parent = currentThread(); if (parent) fs.writeFileSync(path.join(job, "parent_thread_id"), `${parent}\n`); }
catch (e) { log("parent thread:", e.message); }

// AGY out (agy-state.mjs): gemini-flash runs on Haiku high instead (EFFORT still
// wins), logged to run.log and limits.log. The first switch per AGY reset posts
// one `limits` notice to the message board; a failed post is only logged.
let label = model;
let fallbackFrom = null;
function toHaiku(until) {
  fallbackFrom = label;
  label = "haiku";
  modelSelection = selection("haiku");
  const line = `fallback gemini-flash -> haiku (AGY out until ${until ?? "unknown"})`;
  log(line);
  fs.appendFileSync(path.join(job, "limits.log"), `${line}\n`);
  console.error(line);
  if (until) { try { log(noticeOnce(until)); } catch (e) { log("board notice failed:", e.message); } }
}
if (model === "gemini-flash") {
  const until = agyOutUntil();
  if (until) toHaiku(until);
}

// The label and Codex account of the selection a thread really runs on: an attached or
// continued thread keeps its own model, whatever label and ACCOUNT the CLI was given.
const labelFor = (id) => ({ "gpt-6-sol": "sol", "gpt-6.1-sol": "sol61", "gpt-6-luna": "luna", "gpt-6-astra": "astra",
  "claude-fable-5-1": "fable", "claude-opus-5-5": "opus", "claude-sonnet-5-5": "sonnet", "claude-haiku-5-5": "haiku" })[id]
  ?? (/^gemini-3\.8-flash-/.test(id) ? "gemini-flash" : null);
const codexAccountOf = (instanceId) => codexByInstance(instanceId)?.name ?? null;
function adopt(sel) {
  modelSelection = sel;
  label = labelFor(sel.model) ?? label;
  codexName = codexAccountOf(sel.instanceId) ?? codexName;
}

// One line per attempt in attempts.jsonl, so a reused job dir keeps its history.
function recordAttempt(start, rc, threadId) {
  const effort = modelSelection.options?.find((o) => o.id === "effort" || o.id === "reasoningEffort")?.value
    ?? /-(minimal|low|medium|high|xhigh|max)$/.exec(modelSelection.model)?.[1] ?? null;
  fs.appendFileSync(path.join(job, "attempts.jsonl"), JSON.stringify({
    start, end: new Date().toISOString(), model_label: label, model_id: modelSelection.model, harness: "t3",
    account: codexAccountOf(modelSelection.instanceId) ?? modelSelection.instanceId, effort, exit: rc, fallback_from: fallbackFrom,
    thread_id: threadId ?? null, session_id: null, cwd: project?.[1] ?? null,
  }) + "\n");
}

// The T3 project (id and workspace root) of the first root candidate T3 knows.
const project = (() => {
  for (const root of rootCandidates) { try { return [projectFor([root]), root]; } catch { /* next */ } }
  return [projectFor(rootCandidates), rootCandidates[0]]; // throws "no T3 project for …"
})();

const now = () => new Date().toISOString();
const limitRe = /usage limit|hit your (usage )?limit|usage_limit_reached|rate.?limit (reached|exceeded)|quota (exceeded|exhausted)|RESOURCE_EXHAUSTED|Individual quota reached/i;
// The job's own thread is settled at the end unless NO_SETTLE (a failure there is only logged:
// the job's result stands).
const settle = (threadId) => process.env.NO_SETTLE ? null : settleThread(threadId).catch((e) => log("settle", e.message));
// A thread the job leaves for a replacement is always stopped and settled first; when that
// fails the job ends here (exit_code 1), before anything replaces it.
async function abandon(threadId, why) {
  try {
    await abandonThread(threadId, { reason: why });
    log("abandoned", threadId, `(${why})`);
  } catch (e) {
    const line = `could not settle ${threadId} (${why}): ${e.message}; nothing replaces it`;
    log(line);
    console.error(line);
    fs.writeFileSync(path.join(job, "exit_code"), "1\n");
    console.log(job);
    process.exit(1);
  }
}

// `thread_id` holds the latest thread; `threads` every one this job opened (retries included).
function recordThread(threadId) {
  fs.writeFileSync(path.join(job, "thread_id"), threadId);
  const file = path.join(job, "threads");
  const known = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\s+/) : [];
  if (!known.includes(threadId)) fs.appendFileSync(file, `${threadId}\n`);
}

// The latest run's assistant replies -> report.md and transcript.md.
// keep=true leaves the files alone when the run has no reply.
function saveReport(thread, keep = false) {
  const replies = thread?.latestRunId ? runReplies(thread.id, thread.latestRunId) : [];
  if (keep && !replies.length) return;
  fs.writeFileSync(path.join(job, "transcript.md"), replies.join("\n\n---\n\n"));
  fs.writeFileSync(path.join(job, "report.md"), replies.at(-1) ?? (thread?.lastError ?? ""));
}

// Poll a thread (getThread, a DB read) until its run ends or the deadline passes. After a
// message (`sent`), wait for a run newer than `priorRunId`: a new message can take a moment to
// become a run. A re-poll of an idle thread with no run returns at once.
async function waitTurn(threadId, { priorRunId = null, sent = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let thread;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    try { thread = getThread(threadId); } catch (err) { log("poll", err.message); continue; }
    if (!thread) throw new Error(`thread ${threadId} is not in T3`);
    const ours = thread.latestRunId && (!sent || thread.latestRunId !== priorRunId);
    if (ours && !thread.busy) { log("run", thread.status); return { thread, rc: thread.status === "completed" ? 0 : 1 }; }
    if (!ours && !thread.busy && thread.lastError) { log("session error", thread.lastError); return { thread, rc: 1 }; }
    if (!sent && !thread.latestRunId && !thread.busy) return { thread, rc: 0 };
    if (Date.now() > deadline) return { thread, timedOut: true };
  }
}

// Set once per run when a long thread hands off; retries and fallbacks reuse it.
let handoff = null;

// Reviewer threads stay with their stage: the job that recorded a thread (its
// `thread_id` or a `thread_ids_prev` line). This job's own record wins (a recheck); else the
// first other job found, or null when no job dir knows the thread.
const REVIEWERS = ["sol61", "astra"];
const recorded = (dir, threadId) => ["thread_id", "thread_ids_prev"].some((f) => {
  try { return fs.readFileSync(path.join(dir, f), "utf8").split(/\s+/).includes(threadId); } catch { return false; }
});
function stageOwner(threadId) {
  if (recorded(job, threadId)) return path.basename(job);
  const root = path.dirname(job);
  for (const name of fs.readdirSync(root)) if (name !== path.basename(job) && recorded(path.join(root, name), threadId)) return name;
  return null;
}

// One thread: create it, start the turn, poll the read model until the turn ends.
async function runThread(attempt) {
  let attach = attempt === 1 ? process.env.ATTACH : undefined;
  let snap;
  if (attach && process.env.CONTINUE) {
    snap = getThread(attach);
    if (!snap) throw new Error(`ATTACH ${attach} is not a T3 thread`);
    // A reviewer thread another JOB recorded belongs to that stage: a new stage gets a fresh
    // reviewer (same JOB = a recheck, which continues). Workers continue under any JOB.
    const owner = REVIEWERS.includes(labelFor(snap.modelSelection?.model) ?? model) ? stageOwner(attach) : null;
    if (owner && owner !== path.basename(job)) {
      const line = `new stage ${owner}→${path.basename(job)}: fresh reviewer thread`;
      log(line, `(not continuing ${attach})`);
      console.error(line);
      attach = undefined;
      snap = undefined;
    }
  }
  if (attach && process.env.CONTINUE) {
    // A Gemini thread can't continue while AGY is out (its own model would win over
    // the fallback): a fresh Haiku thread takes the same job.
    const until = snap.modelSelection?.instanceId === "antigravity" ? agyOutUntil() : null;
    const n = compactions(attach);
    if (until) {
      log("continue: AGY is out; a fresh thread takes the job instead of", attach);
      await abandon(attach, "AGY is out");
      if (label === "gemini-flash") toHaiku(until);
      attach = undefined;
      snap = undefined;
    } else if (n >= Number(process.env.HANDOFF_COMPACTIONS ?? 3)) {
      // A long thread hands off: a new thread on the same model and effort takes the job,
      // once the old thread's turn has ended and its reply is saved as the last report.
      if (snap.busy) {
        console.error(`handoff: waiting for ${attach}'s running turn to end`);
        const done = await waitTurn(attach);
        if (done.timedOut) {
          // A lead polling exit_code must see this run end; the old report stays.
          fs.writeFileSync(path.join(job, "exit_code"), "124\n");
          throw new Error(`handoff: ${attach} still running after TIMEOUT; nothing started`);
        }
        snap = done.thread;
      }
      saveReport(snap, true);
      await abandon(attach, "handoff");
      const title = !process.env.TITLE && snap.title ? snap.title : null;
      handoff = { from: attach, n, title,
        text: `You take over from thread ${attach}; its last report is ${path.join(job, "report.md")}.${process.env.PLAN ? `\nPLAN: ${process.env.PLAN}` : ""}\n\n${prompt}` };
      if (snap.modelSelection && !process.env.EFFORT) adopt(snap.modelSelection);
      if (modelSelection.instanceId === claudeAccount.t3Instance) modelSelection = { ...modelSelection, instanceId: claudeAccount.t3WorkerInstance };
      attach = undefined;
      snap = undefined;
    }
  }
  const threadId = attach ?? randomUUID();
  const title = (attempt === 1 && handoff?.title) || workerThreadTitle({ model: label, job: path.basename(job), title: process.env.TITLE, attempt });
  let priorRunId = null;
  let sent = false;
  if (snap) {
    priorRunId = snap.latestRunId;
    // Keep the thread's own model and effort unless EFFORT overrides it.
    if (snap.modelSelection && !process.env.EFFORT) modelSelection = snap.modelSelection;
    // Older workers used the orchestrator profile; move them on continuation
    // while retaining their exact model and options. T3 preserves the resume cursor.
    if (modelSelection.instanceId === claudeAccount.t3Instance) {
      modelSelection = { ...modelSelection, instanceId: claudeAccount.t3WorkerInstance };
    }
    adopt(modelSelection);
    await sendMessage(threadId, prompt, { mode: "queue", modelSelection, label: `subagent ${path.basename(job)}` });
    sent = true;
    log("continued", threadId);
  } else if (attach) {
    // Re-poll: attempts.jsonl records the thread's own model and account.
    const s = getThread(threadId);
    if (!s) throw new Error(`ATTACH ${threadId} is not a T3 thread`);
    if (s.modelSelection) adopt(s.modelSelection);
    log("attached", threadId);
  } else {
    // Recorded before the thread exists, so nothing ever sees it as a main thread.
    recordThread(threadId);
    if (handoff && attempt === 1) fs.appendFileSync(path.join(job, "thread_ids_prev"), `${handoff.from}\n`);
    await createThread({ threadId, projectId: project[0], title, modelSelection });
    await sendMessage(threadId, handoff?.text ?? prompt, { mode: "start", modelSelection, label: `subagent ${path.basename(job)}` });
    sent = true;
    log("created", threadId, JSON.stringify(modelSelection));
    if (handoff && attempt === 1) {
      const line = `handoff ${handoff.from}→${threadId} (${handoff.n} compactions)`;
      log(line);
      console.error(line);
    }
  }
  recordThread(threadId);
  console.error(`thread ${threadId} "${title}" — watch it in T3`);

  let { thread, rc = 0, timedOut } = await waitTurn(threadId, { priorRunId, sent });
  if (timedOut) {
    log("timeout; interrupting");
    await interruptThread(threadId, "timeout").catch((e) => log("interrupt", e.message));
    rc = 124;
    try { thread = getThread(threadId) ?? thread; } catch { /* keep the last read */ }
  }
  return { threadId, thread, rc };
}

// Limit go-around: Codex opens a new thread on the next account (auto mode only),
// Fable falls back to Opus (separate weekly bucket), an AGY quota error reruns
// the prompt on Haiku high. The limited thread is abandoned (settled) before the retry starts
// the prompt over.
let result;
for (let attempt = 1; attempt <= 3; attempt++) {
  const start = now();
  try { result = await runThread(attempt); } catch (e) { recordAttempt(start, null); throw e; }
  const { thread, rc, threadId } = result;
  recordAttempt(start, rc, threadId);
  const lastReply = thread?.latestRunId ? runReplies(threadId, thread.latestRunId).at(-1) ?? "" : "";
  const errorText = `${thread?.lastError ?? ""}\n${lastReply}`;
  if (rc === 0 || !(thread?.lastErrorClass === "usage_limit" || limitRe.test(errorText))) break;
  const isCodex = !!codexByInstance(modelSelection.instanceId);
  const who = isCodex ? codexName : modelSelection.model;
  log("limit reached on", who);
  console.error(`limit reached on ${who} (attempt ${attempt})`);
  if (isCodex && autoAccount) {
    tried.push(codexName);
    try { modelSelection = selection(model); } catch (e) { console.error(e.message); break; }
  } else if (modelSelection.model === "claude-fable-5-1") {
    fallbackFrom = label;
    label = "opus";
    modelSelection = selection("opus");
    console.error("falling back to claude-opus-5-5");
  } else if (modelSelection.instanceId === "antigravity") {
    // AGY quota: record the reset so the next jobs skip Gemini, then rerun on Haiku now.
    let until = null;
    try { until = recordQuotaError(errorText); } catch (e) { log("agy state:", e.message); }
    toHaiku(until);
  } else break;
  // Without a fallback the limited thread is the job's result, settled as usual below.
  if (attempt === 3) break;
  saveReport(thread);
  await abandon(threadId, "usage limit");
}

const { thread, rc, threadId } = result;
saveReport(thread);
await settle(threadId);
try {
  const n = compactions(threadId);
  fs.writeFileSync(path.join(job, "compactions"), `${n}\n`);
  console.error(`compactions: ${n}`);
} catch (e) { log("compactions", e.message); }

fs.writeFileSync(path.join(job, "exit_code"), `${rc}\n`);
console.log(job);
process.exit(rc);
