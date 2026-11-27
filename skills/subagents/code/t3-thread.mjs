#!/usr/bin/env node
// Run one delegated worker as a visible T3 Code thread, wait for its turn to
// finish, save the answer, then settle the thread (kept, not deleted).
//
//   node t3-thread.mjs <model> <prompt-file>
//
// Same labels and env overrides as run.sh (EFFORT, ACCOUNT, JOB, TIMEOUT), plus
// PROJECT_ROOT to pick the T3 project and NO_SETTLE=1. TITLE="<fix>" names the
// thread after its fix ("<fix> · <model>") instead of "[<model>] <job>"; the job
// dir records the thread id, which is how prune-workers and other tools
// still know it is a worker. PROJECT_ROOT defaults to
// the git root of the current directory; from a linked worktree it falls back to
// the main tree, since T3 projects are registered there.
//
//   node t3-thread.mjs --rename "<title>" [--thread <id>]
//
// renames the thread the caller runs in (found from its Claude Code or Codex
// session), or --thread.
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
// has been compacted HANDOFF_COMPACTIONS times or more (default 2 for a worker: a fix round on a
// twice-compacted worker often ends before any edit; 3 for a reviewer): then a new
// thread (same model, effort, JOB and title) takes over, told the old thread's id,
// the job's last report.md and PLAN (if set). It first waits for the old thread's
// running turn to end and saves its reply as report.md; an EFFORT override applies to
// the new thread, and TITLE (else the old thread's title) names it. The old thread is settled
// before the new one starts; its id moves to `thread_ids_prev` and run.log gets
// `handoff <old>→<new> (N compactions)`.
//
// A reviewer (terra61, sol62, astra) attached under a JOB other than the one whose job dir records the
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
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claude as claudeAccount, codexAccount as codexAccountByName, codexAccounts, codexByInstance, codexDefault, codexFallback } from "./accounts.mjs";
import { codexLoginRe, loginHint, loginOk as codexLoginOk, markSignedOut, signedOut } from "./codex-login.mjs";
import { agyOutUntil, noticeOnce, recordQuotaError } from "./agy-state.mjs";
import { abandonThread, compactionCount as compactions, createMainThread, createThread, currentThread, getThread, interruptThread, orchModelSelection, orchestratorArgs, projectFor, renameThread, runReplies, sendMessage, settleThread, t3Query, workerThreadTitle } from "./t3-api.mjs";

// The launcher's own nudges (see awaitAnswer), exact text: a hand-off's messages file leaves them out
// (plan 1120 S3). `--nudges` prints them as JSON (the tests read them from here instead of retyping them).
const VERDICT_NUDGE = "Your last turn ended without a verdict. Finish the review now: read the results of anything you started (or run the checks yourself in the foreground), then send the full packet ending in \"VERDICT: APPROVE\" or \"VERDICT: REVISE\". Don't end the turn waiting.";
const workerNudge = (verdict) => "Your last turn ended on waiting, so whatever you were waiting for can't reach your lead. Check it now: read its output, or wait for it inside this turn (t3_background_wait on its task, or run it in the foreground with a fitting timeout), then send your full report"
  + (verdict ? " ending in \"VERDICT: DONE\" or \"VERDICT: BLOCKED\"" : "") + ". Don't end the turn waiting.";
const LAUNCHER_NUDGES = [VERDICT_NUDGE, workerNudge(false), workerNudge(true)];
if (process.argv[2] === "--nudges") { console.log(JSON.stringify(LAUNCHER_NUDGES)); process.exit(0); }

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
    await createMainThread({ threadId, messageId: randomUUID(), projectId: projectFor(projectRoots()), title: a.title, text, modelSelection: orchModelSelection(a.model, a.effort), role: "orchestrator" });
  } catch (e) { console.error(`orchestrator thread ${threadId}: ${e.message}`); process.exit(1); }
  console.log(threadId);
  process.exit(0);
}

const [model, promptSrc] = process.argv.slice(2);
if (!model || !promptSrc) {
  console.error("usage: t3-thread.mjs <sol|sol62|terra61|luna|astra|fable|opus|sonnet|haiku|gemini-flash> <prompt-file>");
  process.exit(2);
}

const home = os.homedir();
const here = path.dirname(new URL(import.meta.url).pathname);
const rootCandidates = projectRoots();

// Accounts come from accounts.local.json. ACCOUNT defaults to its codex.default.
// ACCOUNT=auto: non-reserve accounts first, soonest weekly reset first; reserve
// accounts last (see usage.mjs --pick-codex). `tried` holds accounts that
// already hit a limit this run.
// An account whose login expired is marked in codex-login.mjs: usage.mjs skips it in auto mode, a
// pinned ACCOUNT fails with the login hint, and the mark clears on the next login or a good run.
const autoAccount = (process.env.ACCOUNT ?? codexDefault) === "auto";
const tried = [];
const codexHome = (name) => codexAccountByName(name)?.home ?? "";
const signedOutMark = (name) => { try { return signedOut(name); } catch { return null; } };
function codexAccount(modelId) {
  if (!autoAccount) {
    const name = process.env.ACCOUNT ?? codexDefault;
    if (signedOutMark(name)) throw new Error(loginHint(name, codexHome(name)));
    return name;
  }
  try {
    return execFileSync("node", [path.join(here, "usage.mjs"), "--pick-codex", modelId, "--exclude", tried.join(",")],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    if (tried.length) throw new Error("every Codex account is at its limit or signed out");
    // No answer (no usage data, or no account has room): the fallback account, even when it is marked
    // signed out; its attempt fails at once and the go-around ends the launch.
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
    case "sol62": case "sol61": return codex("gpt-6.2-sol", "high"); // finals, alone
    case "terra61": return codex("gpt-6.1-terra", "high"); // every stage review; finals are sol62 alone
    case "luna": return codex("gpt-6-luna", "xhigh");
    case "astra": return codex("gpt-6-astra", "low"); // EFFORT=medium for final checks
    case "fable": return claude("claude-fable-5-2", [], "medium"); // medium by default; EFFORT= overrides
    case "opus": return claude("claude-opus-5-5", [{ id: "fastMode", value: false }]);
    case "sonnet": return claude("claude-sonnet-5-5", [], "high");
    case "haiku": return claude("claude-haiku-5-5", [], "high");
    case "gemini-flash": // AGY encodes the level in the slug
      return { instanceId: "antigravity", model: `gemini-3.8-flash-${effort ?? "high"}` };
    default: throw new Error(`unknown model: ${label}`);
  }
}

// A bare number is minutes (TIMEOUT=180 once meant 180 s and cut a worker off at 3 min); 90s / 90m / 2h as written.
function parseDuration(s) {
  const m = /^(\d+)([smh]?)$/.exec(s.trim());
  if (!m) throw new Error(`bad TIMEOUT: ${s} (use 90m, 2h or 30s)`);
  return Number(m[1]) * { "": 60, s: 1, m: 60, h: 3600 }[m[2]] * 1000;
}

// A pick that can't start (a pinned account signed out) says why and stops, with no stack trace.
let modelSelection;
try { modelSelection = selection(model); } catch (e) { console.error(e.message); process.exit(1); }
const timeoutMs = parseDuration(process.env.TIMEOUT ?? "45m");
const JOBS_ROOT = path.resolve(process.env.AGENT_JOBS_DIR ?? path.join(home, ".local/state/agent-jobs"));
// Plan 1154 (chk_7008c508015f4050): every T3 call opens its own connect, and the connect budget
// (`t3 auth session issue` start-up, the ticket, the socket) is T3_API_TIMEOUT_MS, 30 s by default
// so the timers don't pile up. Under load (load avg 32) the token CLI alone took over 30 s twice and
// a review launch failed; 120 s worked at once. A worker or reviewer launch waits minutes for its
// turn anyway, so it raises the budget for itself and the scripts it starts (usage.mjs). Only here:
// the modes above (--orchestrator, --attach, --rename) run under callers' deadlines and the pacer's
// planning lock, which are sized for 30 s connects (plan 1154 S1 review F1). A caller's positive value wins.
if (!(Number(process.env.T3_API_TIMEOUT_MS) > 0)) process.env.T3_API_TIMEOUT_MS = "120000";
const job = path.join(JOBS_ROOT,
  process.env.JOB ?? `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${model}-t3`);
{ const bad = jobDirProblem(job); if (bad) { console.error(`job dir ${JSON.stringify(job)} ${bad}: hand-offs read its files only there (pick a JOB that is one plain name)`); process.exit(2); } }
fs.mkdirSync(job, { recursive: true });
fs.copyFileSync(promptSrc, path.join(job, "prompt.md"));
fs.appendFileSync(path.join(job, "prompt.md"), "\n\n" + fs.readFileSync(path.join(here, "worker-communication.md"), "utf8"));
const prompt = fs.readFileSync(path.join(job, "prompt.md"), "utf8");
const log = (...a) => fs.appendFileSync(path.join(job, "run.log"), `${new Date().toISOString()} ${a.join(" ")}\n`);
log(`timeout ${timeoutMs / 60000} min (TIMEOUT=${process.env.TIMEOUT ?? "unset"})`);
// Review budget (orchestrate §9): every launch of a review job that sends a turn is a round,
// counted in the job dir's `rounds`. A review job is one by its brief ("REVIEW ONLY." /
// "RECHECK ONLY."), its JOB name (`-review`, `-recheck`, `-final`) or an earlier counted round,
// so a free-form recheck on the same JOB counts too. Past REVIEW_ROUNDS (default 3; 5 for an
// evidenced security / data-loss / concurrency blocker) nothing is sent and the run exits 3.
// Opus pre-reviews loop until APPROVE: counted, never capped. A re-poll (ATTACH without
// CONTINUE) sends nothing, so it is gated only before a limit fallback's send.
const REVIEW_JOB_RE = /(^|-)(review|recheck|final)(?=-|\d|$)/i;
const isReview = /^\s*(REVIEW|RECHECK) ONLY\./.test(prompt) || REVIEW_JOB_RE.test(path.basename(job))
  || fs.existsSync(path.join(job, "rounds")) || fs.existsSync(path.join(job, "rounds_failed"));
const capped = model !== "opus";
const maxRounds = Number(process.env.REVIEW_ROUNDS ?? 3);
if (isReview && !Number.isFinite(maxRounds)) { console.error(`REVIEW_ROUNDS=${process.env.REVIEW_ROUNDS} is not a number`); process.exit(2); }
let roundCounted = false;
// The round this launch counted and `rounds` as it was before (null: no file), for a provider-error rollback.
let countedRound = 0, roundsBefore = null;
const nextRound = () => { try { return (Number.parseInt(fs.readFileSync(path.join(job, "rounds"), "utf8"), 10) || 0) + 1; } catch { return 1; } };
const failedTurns = () => { try { return fs.readFileSync(path.join(job, "rounds_failed"), "utf8").split("\n").filter((l) => l.trim()).length; } catch { return 0; } };
const PROVIDER_FAILS_MAX = 3;
// A plan's final review rounds share one count: every `<key>-final…` JOB in the
// jobs dir (`<key>-final-sol`, `<key>-final2`, …) adds its `rounds`, so a fresh final JOB doesn't
// restart the budget. A final run that ends with no verdict and no findings isn't a round (its
// round goes back, a `rounds_empty` line instead; these and provider errors stop at PROVIDER_FAILS_MAX).
const FINAL_JOB_RE = /^(.+?)-final(?=-|\d|$)/i;
const finalKey = FINAL_JOB_RE.exec(path.basename(job))?.[1]?.toLowerCase() ?? null;
function otherFinalRounds() {
  if (!finalKey) return 0;
  let names = [];
  try { names = fs.readdirSync(path.dirname(job)); } catch { return 0; }
  return names.filter((n) => n !== path.basename(job) && FINAL_JOB_RE.exec(n)?.[1]?.toLowerCase() === finalKey)
    .reduce((sum, n) => { try { return sum + (Number.parseInt(fs.readFileSync(path.join(path.dirname(job), n, "rounds"), "utf8"), 10) || 0); } catch { return sum; } }, 0);
}
const emptyTurns = () => { try { return fs.readFileSync(path.join(job, "rounds_empty"), "utf8").split("\n").filter((l) => l.trim()).length; } catch { return 0; } };
function budgetGate() {
  if (!isReview || roundCounted) return;
  // Provider-error turns aren't rounds (plan 1120 S3b), so a refusal loop could send forever: 3 stop it, on any model.
  const empty = emptyTurns(), failed = failedTurns() + empty;
  if (failed >= PROVIDER_FAILS_MAX) {
    const line = `${failed} provider-error${empty ? " or empty final" : ""} turns on ${path.basename(job)}: start a fresh review (new JOB) or another model, or write closed.md`;
    log(line);
    console.error(line);
    fs.writeFileSync(path.join(job, "exit_code"), "3\n");
    process.exit(3);
  }
  if (!capped) return;
  const round = nextRound() + otherFinalRounds();
  if (round <= maxRounds) return;
  const line = finalKey ? `final review budget: round ${round} > ${maxRounds} for ${finalKey} (its -final JOBs share one count); nothing sent. In this order: a blocker past the gate goes to the user: stop and ask the user, never file it away. Then fix accepted small findings in files the plan touches; park the remaining optional findings and nits; file the remaining defects as follow-up items. REVIEW_ROUNDS=5 only for an evidenced security, data-loss or concurrency blocker.`
    : `review budget: round ${round} > ${maxRounds} for ${path.basename(job)}; nothing sent. Fix what you agree with, then commit with every open id disputed (with evidence), stop and ask the user, or write closed.md (orchestrate §9). REVIEW_ROUNDS=5 only for an evidenced security, data-loss or concurrency blocker.`;
  log(line);
  console.error(line);
  fs.writeFileSync(path.join(job, "exit_code"), "3\n");
  process.exit(3);
}
function budgetCount() {
  if (!isReview || roundCounted) return;
  const round = nextRound();
  const file = path.join(job, "rounds");
  roundsBefore = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  fs.writeFileSync(file, `${round}\n`);
  roundCounted = true;
  countedRound = round;
  log(`review round ${round}/${capped ? maxRounds : "uncapped"}${finalKey ? ` (${finalKey} finals: ${round + otherFinalRounds()})` : ""}`);
}
if (!(process.env.ATTACH && !process.env.CONTINUE)) budgetGate();
// The thread that started this job, so a tool counting working threads counts a
// worker and its parent once. Every run rewrites it with its caller; a run from outside T3 writes nothing.
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
const labelFor = (id) => ({ "gpt-6-sol": "sol", "gpt-6.2-sol": "sol62", "gpt-6.1-sol": "sol62", "gpt-6.1-terra": "terra61", "gpt-6-luna": "luna", "gpt-6-astra": "astra",
  "claude-fable-5-2": "fable", "claude-fable-5-1": "fable", "claude-opus-5-5": "opus", "claude-sonnet-5-5": "sonnet", "claude-haiku-5-5": "haiku" })[id]
  ?? (/^gemini-3\.8-flash-/.test(id) ? "gemini-flash" : null);
const codexAccountOf = (instanceId) => codexByInstance(instanceId)?.name ?? null;
// A retired model id a continued or handed-off thread still carries, and the id it moves to.
const RETIRED = { "claude-fable-5-1": "claude-fable-5-2", "gpt-6.1-sol": "gpt-6.2-sol" };
const current = (sel) => RETIRED[sel?.model] ? { ...sel, model: RETIRED[sel.model] } : sel;
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
// A worker hand-off without the old thread's lead messages would start a successor with only the new
// round: the task and every pending fix lost (plan 1120 S3 r1 F2). When they can't be read, or there
// are none, the job ends here (exit_code 1, as a refused settle), before anything is saved or settled.
// Returns them with `state`, how the old thread's latest turn ended (read in the same go).
function handoffMessagesOrStop(threadId, snap) {
  let msgs = null, why;
  try {
    // The job's own manifest takes the new records after the old thread is settled: it must be readable
    // and writable now (final r3 F4).
    launcherFiles(job);
    fs.accessSync(fs.existsSync(path.join(job, MANIFEST)) ? path.join(job, MANIFEST) : job, fs.constants.W_OK);
    msgs = handoffMessages(threadId, { root: path.dirname(job), names: [path.basename(job)], thread: threadId });
    if (msgs) msgs.state = turnState(snap, threadId, msgs.entries);
  }
  catch (e) { why = `couldn't read them (${e.message})`; }
  if (!why && !msgs) why = "it has none";
  else if (!why && !msgs.task) why = "its first message is empty";
  if (!why) return msgs;
  const line = `handoff: lead messages of ${threadId}: ${why}; nothing settled or started. Run the same command again, or start a fresh worker with its original task and this round`;
  log(line);
  console.error(line);
  fs.writeFileSync(path.join(job, "exit_code"), "1\n");
  console.log(job);
  process.exit(1);
}
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

// Plan 1154: a create that fails must not leave the job dir naming a thread T3 never made (prune and
// settle would chase it, and a CONTINUE would send to it). The record is still written before the
// create (so nothing sees the new thread as a main thread); these keep what it was, and put it back
// when T3 has no such thread after the failure. A thread that does exist (the create landed, its reply
// was slow) or a check that fails keeps the record.
const JOB_RECORD = ["thread_id", "threads", "thread_ids_prev"];
const readRecord = () => Object.fromEntries(JOB_RECORD.map((f) => {
  try { return [f, fs.readFileSync(path.join(job, f))]; } catch { return [f, null]; }
}));
// `mine` is the record right after this launch wrote it: when it has changed since (another launch
// of the same JOB recorded its own thread meanwhile), the record is that launch's and stays.
const sameRecord = (a, b) => JOB_RECORD.every((f) => (a[f] === null ? b[f] === null : b[f] !== null && a[f].equals(b[f])));
function undoRecordIfNoThread(threadId, before, mine, err) {
  const why = String(err?.message ?? err).split("\n")[0];
  let exists;
  try { exists = Boolean(getThread(threadId)); }
  catch (e) { log(`create failed; couldn't check whether ${threadId} exists (${String(e?.message ?? e)}), job dir kept: ${why}`); return; }
  if (exists) { log(`create failed but ${threadId} exists; job dir kept: ${why}`); return; }
  if (!sameRecord(mine, readRecord())) { log(`create failed; ${threadId} never existed, but another launch changed the job dir since, so it is kept: ${why}`); return; }
  for (const [f, buf] of Object.entries(before)) {
    const file = path.join(job, f);
    if (buf === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, buf);
  }
  log(`create failed; ${threadId} never existed, job dir restored: ${why}`);
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
// A worker that wrote report.md itself (its mtime or text changed since this script last saw it)
// keeps it, through every later save of this launch (a limit retry, a fallback): the replies stay in
// transcript.md only.
const readOr = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };
let reportSeen = readOr(path.join(job, "report.md")), reportMtime = mtimeOf(path.join(job, "report.md")), workerReport = false;
function saveReport(thread, keep = false) {
  const replies = thread?.latestRunId ? runReplies(thread.id, thread.latestRunId) : [];
  if (keep && !replies.length) return;
  fs.writeFileSync(path.join(job, "transcript.md"), replies.join("\n\n---\n\n"));
  const file = path.join(job, "report.md");
  const old = readOr(file);
  if (old.trim() && (workerReport || old !== reportSeen || mtimeOf(file) !== reportMtime)) {
    reportSeen = old; reportMtime = mtimeOf(file);
    if (!workerReport) log("report.md written by the worker this run: kept; its replies are in transcript.md");
    workerReport = true;
    return;
  }
  reportSeen = replies.at(-1) ?? (thread?.lastError ?? "");
  fs.writeFileSync(file, reportSeen);
  reportMtime = mtimeOf(file);
}

// Poll a thread (getThread, a DB read) until its run ends or the deadline passes. After a
// message (`sent`), wait for a run newer than `priorRunId`: a new message can take a moment to
// become a run. A re-poll of an idle thread with no run returns at once.
async function waitTurn(threadId, { priorRunId = null, sent = false, startWithinMs = 0 } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let thread;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    try { thread = getThread(threadId); } catch (err) { log("poll", err.message); continue; }
    if (!thread) throw new Error(`thread ${threadId} is not in T3`);
    const ours = thread.latestRunId && (!sent || thread.latestRunId !== priorRunId);
    if (ours && !thread.busy) { log("run", thread.status); return { thread, rc: thread.status === "completed" ? 0 : 1 }; }
    if (!ours && startWithinMs && Date.now() - started > startWithinMs) return { thread, noStart: true };
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
const REVIEWERS = ["sol62", "sol61", "terra61", "astra"];

// A worker's successor gets the task the stage started with once: its owned files, rules and
// Verify commands. A successor's own first message carries it between these markers, so a later
// hand-off takes it out again instead of nesting the first takeover. LAST ROUND blocks are only in
// briefs from the launcher before plan 1120 S3 (kept as they are in the messages file).
const TASK_OPEN = "<<<ORIGINAL TASK", TASK_CLOSE = "ORIGINAL TASK>>>";
const wrapTask = (text) => `${TASK_OPEN}\n${text.trim()}\n${TASK_CLOSE}`;
// The outermost task blocks in text from offset `from` (a line start) on, matched with nesting
// (plan 1120 S3 r2): only whole lines equal to a marker count, and a block ends where the depth
// returns to 0, so a task that quotes an earlier brief (its blocks and EARLIER line too) stays whole.
// Each block is { open, close, end }: where its open line starts, where its close line starts and the
// offset just after the close line. null when the markers don't balance: a close with no open, or an
// open never closed.
function taskBlocks(text, from = 0) {
  const blocks = [];
  let depth = 0, open = -1;
  for (let at = from; ; ) {
    const nl = text.indexOf("\n", at), end = nl < 0 ? text.length : nl, line = text.slice(at, end);
    if (line === TASK_OPEN && depth++ === 0) open = at;
    else if (line === TASK_CLOSE) {
      if (depth === 0) return null;
      if (--depth === 0) blocks.push({ open, close: at, end });
    }
    if (nl < 0) break;
    at = nl + 1;
  }
  return depth ? null : blocks;
}
const blockTask = (text, b) => text.slice(b.open + TASK_OPEN.length + 1, Math.max(b.open + TASK_OPEN.length + 1, b.close - 1));
// The job chain a hand-off reads (plan 1120 S3 final F1): a lead message names a file the launcher
// wrote (an EARLIER messages file) only in a job dir of this chain, right under
// `root`: a dir in `names` (the CONTINUE job) or one whose `thread_id` /
// `thread_ids_prev` records the thread being read. Any other path stays literal: the launcher never
// reads it into a successor's brief.
function recordsThread(dir, threadId) {
  return ["thread_id", "thread_ids_prev"].some((f) => {
    try { return fs.readFileSync(path.join(dir, f), "utf8").split(/\s+/).includes(threadId); } catch { return false; }
  });
}
// `p` names a file in a job dir of this chain: absolute and normalized, a name `nameRe` matches, its
// dir right under the chain root and in the chain (any dir name the launcher may write to: final r3
// F4). Nothing is read.
function inChain(p, chain, nameRe) {
  if (!chain || !path.isAbsolute(p) || path.normalize(p) !== p || !nameRe.test(path.basename(p))) return false;
  const dir = path.dirname(p), name = path.basename(dir);
  return path.dirname(dir) === path.resolve(chain.root) && (chain.names.includes(name) || recordsThread(dir, chain.thread));
}
// Launcher files (plan 1120 final r2 F1/F4): every hand-off messages file the launcher writes is
// recorded in its job dir's launcher-files.jsonl with the whole file's sha256, its brief's head sha
// (`head`) and every recorded file it depends on (`deps`, the chain's earlier messages files). A
// hand-off trusts a file a lead message names only when its dir's manifest lists it: an unlisted file
// is literal text (never read, never a stop); a listed one that is missing or no longer the file
// written stops the hand-off, and so does any file it depends on. Files of a job written before the
// manifest are never read or checked (generatedBrief still knows such a brief by its head file or the
// frozen layout, and passes its EARLIER line on as text).
const MANIFEST = "launcher-files.jsonl";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
// name → its latest record; null when the dir has no manifest. A manifest that is there but can't be
// read throws (final r3 F4): it never falls back to the old-job rules.
function launcherFiles(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, MANIFEST), "utf8"); }
  catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw new Error(`${path.join(dir, MANIFEST)} can't be read (${e.message})`); }
  const files = new Map();
  for (const line of raw.split("\n")) { try { const r = JSON.parse(line); if (r?.name) files.set(r.name, r); } catch { /* blank or torn line */ } }
  return files;
}
// Written whole, then recorded: a crash between leaves it unlisted (literal), never a false stop.
// A job dir is one plain name right under the absolute jobs root, because that is the only place a
// hand-off looks for recorded files (inChain), and briefs name them by path ending at whitespace
// (final r4/r5 F4). Any other dir would hold files no hand-off could read back or check, so the CLI
// refuses it up front and writeLauncherFile refuses to record into it. null = fine.
function jobDirProblem(dir) {
  if (/\s/.test(dir)) return "contains whitespace";
  if (!path.isAbsolute(dir)) return "isn't an absolute path";
  if (path.dirname(dir) !== JOBS_ROOT || path.normalize(dir) !== dir) return `isn't a single name right under ${JOBS_ROOT}`;
  return null;
}
function writeLauncherFile(file, text, extra = {}) {
  const bad = jobDirProblem(path.dirname(file));
  if (bad) throw new Error(`${file}: its job dir ${bad}, so no hand-off could read it back`);
  writeAtomic(file, text);
  fs.appendFileSync(path.join(path.dirname(file), MANIFEST), `${JSON.stringify({ name: path.basename(file), sha256: sha256(text), at: new Date().toISOString(), ...extra })}\n`);
}
// The next free hand-off number in `dir`: at least `n`, past every handoff-<k>-* there or recorded
// (final r2 F4: a deleted file's name is never reused, so no chain points at itself).
function nextHandoff(dir, n) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* not made yet */ }
  const ks = [...names, ...(launcherFiles(dir)?.keys() ?? [])].map((x) => /^handoff-(\d+)-/.exec(x)?.[1]).filter(Boolean).map(Number);
  return Math.max(n, ...ks.map((k) => k + 1));
}
// A listed launcher file read and checked whole, then every file it depends on in turn. Each one
// read goes into `chain.deps`. Throws when one is missing, not a regular file in its job dir under
// the chain root, unreadable, changed, or a dependency is no longer recorded.
function checkRecorded(p, rec, chain, seen = new Set()) {
  seen.add(p);
  const dir = path.dirname(p), name = path.basename(dir);
  let there = false;
  try { there = path.dirname(dir) === path.resolve(chain.root) && fs.realpathSync(dir) === path.join(fs.realpathSync(chain.root), name) && fs.lstatSync(p).isFile(); } catch { /* missing */ }
  if (!there) throw new Error(`${p} is missing or not a regular file in its job dir`);
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch (e) { throw new Error(`${p} can't be read (${e.message})`); }
  if (sha256(text) !== rec.sha256) throw new Error(`${p} changed since the launcher wrote it`);
  chain.deps?.add(p);
  for (const d of rec.deps ?? []) {
    if (seen.has(d)) continue;
    const r = launcherFiles(path.dirname(d))?.get(path.basename(d));
    if (!r) throw new Error(`${d}, which ${p} depends on, is no longer recorded`);
    checkRecorded(d, r, chain, seen);
  }
  return { file: p, text, rec };
}
// A worker hand-off records its brief's head (the takeover line through its EARLIER line) with the
// messages file it names, as a sha256 (final F2): a later hand-off counts a lead message as that brief
// only when it is exactly that text. Before the manifest the sha was a file beside it (headFile).
const MESSAGES_FILE_RE = /^handoff-\d+-messages\.md$/;
const headFile = (msgFile) => msgFile.replace(/-messages\.md$/, "-head.sha256");
const headSha = sha256;
// Briefs from before the head was recorded (plan 1120 S3 up to final F2): the launcher's whole layout,
// every sentence of it, with nothing outside its slots (thread id, report path, PLAN path, the
// turn-state and PENDING sentences); the task and what follows the EARLIER line stay whole.
const STATE_SRC = String.raw` Its last turn (?:completed with \`VERDICT: DONE\`\.|(?:ended without \`VERDICT: DONE\`|did not finish \([\w-]+\))(?:: its work is not finished \(its report may be from an earlier round; one ending \`HANDOFF:\` lists what is left\)\.|, but that turn answered no lead message: every lead message's turn ended \`VERDICT: DONE\`\.))`;
const PENDING_SRC = String.raw`Every message its lead sent it is in \S+, oldest first(?:: all are done \((?:its last turn|its last lead message's turn) ended \`VERDICT: DONE\`\), so don't redo them\.|, each headed with how its turn ended\. Do every message marked PENDING there, in order \(messages? \d+(?:, \d+)* of \d+: those after its last \`VERDICT: DONE\` turn\); compare the diff with each first and keep what is already done\.)`;
const EDITS_SRC = String.raw`Its edits are uncommitted in the tree: read \`git status\` and \`git diff\` for its files first and keep what it finished\.`;
const LAYOUT_RES = [
  new RegExp(String.raw`^You take over from thread \S+; its last report is \S+\.(?: Earlier rounds of \S+: report\.r\d+\.md(?:, report\.r\d+\.md)* beside it \(report\.md is the latest round; read them together, a fix round's reply may not repeat the first packet\)\.)?(?:\nPLAN: \S+)?\n\n${EDITS_SRC}${STATE_SRC}\n\n${PENDING_SRC} Then do this round\.\n\nIts original task, for owned files, rules and Verify commands:\n\n$`),
];
// Briefs from before S3 (the task between the markers, no EARLIER line: plan 1088 final F2 up to
// plan 1120 S3): their task is taken out only from that launcher's whole layout, sentence by sentence.
const PRE_STATE_SRC = String.raw` (?:Its last turn completed with \`VERDICT: DONE\`: don't redo the stage or that round; do the round at the end\.|If that report ends with \`HANDOFF:\`, (?:is empty or names work still open, finish that first; otherwise don't redo the stage: do the round below|it stopped mid-task: finish what it lists as left)\.|Its last turn (?:ended without \`VERDICT: DONE\`|did not finish \([\w-]+\)): its work is not finished \(its report may be from an earlier round; one ending \`HANDOFF:\` lists what is left\)\. Compare the diff with the original task and its last round, finish what is missing, then do the round at the end, if any\.)`;
const PRE_LAYOUT_RES = [
  new RegExp(String.raw`^You take over from thread \S+; its last report is \S+\.(?: Earlier rounds of \S+: report\.r\d+\.md(?:, report\.r\d+\.md)* beside it \(report\.md is the latest round; read them together, a fix round's reply may not repeat the first packet\)\.)?(?:\nPLAN: \S+)?\n\n${EDITS_SRC}${PRE_STATE_SRC}\n\nIts original task, for owned files, rules and Verify commands:\n\n$`),
];
// A hand-off brief this launcher wrote (plan 1120 S3 r1 F1, r2, final F1/F2): the message opens with
// the takeover line (only T3's delegate_task line "Act as the … sub-agent for this task." may come
// before it) and, from there through an `EARLIER LEAD MESSAGES: <file>` line right after a task
// block's close, is exactly the head recorded with that file in this chain's manifest (inChain).
// With no head recorded: the launcher's layout from before the record (LAYOUT_RES), the EARLIER line
// right after the first outer task block (matched with nesting). Returns that delegate line (kept in
// the entry), the task, the EARLIER file and what follows that line (the round, or the lead's
// findings). Anything else, a takeover note of the lead's own with its instructions included, is the
// lead's text, kept whole. A brief from before S3 (PRE_LAYOUT_RES) gives its task only (earlier null:
// entryText's old format).
const TAKEOVER_RE = /(?:^|\n)[ \t]*You take over from (?:worker )?thread \S+/;
const DELEGATE_LINE_RE = /^Act as the [\w -]+ sub-agent for this task\.$/;
function generatedBrief(text, chain) {
  const t = TAKEOVER_RE.exec(text);
  if (!t) return null;
  const from = t.index + (text[t.index] === "\n" ? 1 : 0), before = text.slice(0, from).trim();
  if (before && !DELEGATE_LINE_RE.test(before)) return null;
  // Every EARLIER line right after a close line may end the head (a task can quote older briefs).
  // It is the brief only once its head matches (final r2 F2): no file is required before that, so a
  // note quoting an old brief never stops a hand-off.
  for (const m of text.slice(from).matchAll(/\nORIGINAL TASK>>>\n\nEARLIER LEAD MESSAGES: (\S+)(?=\n|$)/g)) {
    if (!inChain(m[1], chain, MESSAGES_FILE_RE)) continue;
    const close = from + m.index, end = close + m[0].length, sha = headSha(text.slice(from, end));
    const rec = launcherFiles(path.dirname(m[1]))?.get(path.basename(m[1]));
    let legacy = null, open;
    if (!rec) try { legacy = fs.readFileSync(headFile(m[1]), "utf8").trim(); } catch { /* not recorded */ }
    if (rec || legacy) {
      if ((rec ? rec.head : legacy) !== sha) continue;
      open = text.indexOf(`\n${TASK_OPEN}\n`, from) + 1; // the head's own lines hold no marker
    } else {
      const first = taskBlocks(text, from)?.[0];
      if (!first || first.close !== close + 1 || !LAYOUT_RES.some((re) => re.test(text.slice(from, first.open)))) continue;
      open = first.open;
    }
    if (open <= from || open > close) continue;
    // The launcher's brief: its messages file and every file that one depends on must be intact (F4).
    if (rec) checkRecorded(m[1], rec, chain);
    const body = open + TASK_OPEN.length + 1;
    return { before, task: text.slice(body, Math.max(body, close)), earlier: m[1], after: text.slice(end).replace(/^\s*## This round\s*/, "").trim() };
  }
  const first = taskBlocks(text, from)?.[0];
  if (first && PRE_LAYOUT_RES.some((re) => re.test(text.slice(from, first.open)))) return { before, task: blockTask(text, first), earlier: null, after: null };
  return null;
}
// Finished only when it says so (final F1): a turn completed and its reply ends `VERDICT: DONE` on a
// line of its own ("I cannot give VERDICT: DONE" is not). An older round's report never counts.
const DONE_RE = /(^|\n)[ \t]*VERDICT:[ \t]*DONE[ \t]*$/;
// The old thread's latest turn; the messages file says per message what is left (every worker hand-off
// has one since plan 1120 S3 r1 F2).
// `entries`: the messages file's (handoffMessages); when none is pending, a last turn without
// `VERDICT: DONE` was a later wake, not unfinished work (final F5).
function turnState(snap, threadId, entries) {
  const reply = snap.status === "completed" && snap.latestRunId ? (runReplies(threadId, snap.latestRunId).at(-1) ?? "").trim() : "";
  if (DONE_RE.test(reply)) return " Its last turn completed with `VERDICT: DONE`.";
  const ended = snap.status === "completed" ? "ended without `VERDICT: DONE`" : `did not finish (${snap.status})`;
  if (entries?.length && !entries.some((e) => e.pending)) return ` Its last turn ${ended}, but that turn answered no lead message: every lead message's turn ended \`VERDICT: DONE\`.`;
  return ` Its last turn ${ended}: its work is not finished`
    + " (its report may be from an earlier round; one ending `HANDOFF:` lists what is left).";
}
// The lead's messages on a thread, oldest first: user turns minus background-task notifications,
// T3's limit resumes and the launcher's own nudges (LAUNCHER_NUDGES, exact text). Each keeps its run.
function leadMessages(threadId) {
  return t3Query("select message_id, run_id, created_at, payload_json from orchestration_v2_projection_messages where thread_id = ? and role = 'user' order by created_at, message_id", [threadId])
    .map((m) => ({ ...JSON.parse(m.payload_json), id: m.message_id, runId: m.run_id, at: m.created_at }))
    .filter((m) => !m.notification && !m.id.startsWith("limit-resume:") && !LAUNCHER_NUDGES.includes((m.text ?? "").trim()));
}

// Hand-off messages file (plan 1120 S3): every lead message of the old thread, in order, each headed
// with the turn (run) that answered it and how that turn ended. A message's turn is the last run from
// its own up to the next lead message's (nudge and notification runs included), past turns that
// completed without a reply. PENDING: every message after the last turn that ended `VERDICT: DONE`.
// The successor's brief inlines the original task once and points at the file with an
// `EARLIER LEAD MESSAGES: <file>` line, so a later hand-off lists that brief as a pointer to the
// earlier file instead of nesting it.
const EARLIER = "EARLIER LEAD MESSAGES: ";
const IN_BRIEF = "inlined in the hand-off brief between the ORIGINAL TASK markers";
function handoffEntries(threadId) {
  const asks = leadMessages(threadId);
  const runs = t3Query("select run_id, ordinal, status, requested_at from orchestration_v2_projection_runs where thread_id = ? order by ordinal", [threadId]);
  const ordOf = (m) => runs.find((r) => r.run_id === m.runId)?.ordinal ?? runs.find((r) => m.at && r.requested_at >= m.at)?.ordinal ?? Infinity;
  const ords = asks.map(ordOf);
  return asks.map((m, i) => {
    const from = ords[i], to = Math.min(Infinity, ...ords.slice(i + 1).filter((o) => o > from));
    // The latest run with a reply (or not completed), else the latest; and the latest that completed
    // with `VERDICT: DONE`. A message is done once a turn answering it ended so (final F5): a later
    // wake (a background-task notification, no lead message) doesn't reopen it; how that wake ended is
    // kept in the heading.
    let run = null, reply = "", doneRun = null, latest = null;
    for (const r of runs.filter((x) => x.ordinal >= from && x.ordinal < to).reverse()) {
      latest ??= r;
      const replies = runReplies(threadId, r.run_id), last = (replies.at(-1) ?? "").trim();
      if (!run && (r.status !== "completed" || replies.length)) { run = r; reply = last; }
      if (r.status === "completed" && DONE_RE.test(last)) { doneRun = r; break; }
    }
    run ??= latest;
    const ended = !run ? "not started" : run.status !== "completed" ? `did not finish (${run.status})`
      : DONE_RE.test(reply) ? "completed with VERDICT: DONE" : "completed without VERDICT: DONE";
    if (!doneRun) return { text: m.text ?? "", turn: run?.ordinal ?? null, outcome: ended, done: false };
    const outcome = run === doneRun ? ended : `completed with VERDICT: DONE (then turn ${run.ordinal}: ${ended})`;
    return { text: m.text ?? "", turn: doneRun.ordinal, outcome, done: true };
  });
}
function entryText(text, task, first, chain) {
  const full = text, t = text.trim();
  if (task && t === task) return first ? `(the original task: ${IN_BRIEF})` : `(the lead resent the original brief: ${IN_BRIEF})`;
  const brief = generatedBrief(full, chain);
  if (brief?.earlier) {
    const { before, after } = brief;
    return `${before ? `${before}\n\n` : ""}(a hand-off brief) Earlier lead messages: ${brief.earlier}. Its PENDING messages were handed on with this brief: they are still pending unless this message's turn ended \`VERDICT: DONE\`.`
      + (after ? `\n\nGiven with it:\n\n${after === task ? `(the original brief again: ${IN_BRIEF})` : after}` : "");
  }
  // A brief from before S3 (its LAST ROUND block kept): only an outer task block (matched with nesting,
  // r2) that holds this task is taken out; a message quoting another block keeps it, and unbalanced
  // markers keep the whole text.
  const b = task ? (taskBlocks(full) ?? []).find((x) => blockTask(full, x).trim() === task) : null;
  if (b) return `${full.slice(0, b.open)}(the original task: ${IN_BRIEF})${full.slice(b.end)}`.trim();
  return t;
}
// null when the thread has no lead message. `chain`: the job chain whose files its messages may name
// (checkRecorded); a missing or changed one throws. `deps`: every recorded file it read (the new
// messages file depends on them).
function handoffMessages(threadId, chain) {
  const entries = handoffEntries(threadId);
  if (!entries.length) return null;
  chain.deps = new Set();
  const task = (generatedBrief(entries[0].text, chain)?.task ?? entries[0].text).trim();
  const lastDone = entries.findLastIndex((e) => e.done);
  entries.forEach((e, i) => { e.n = i + 1; e.pending = i > lastDone; });
  const body = `# Lead messages to thread ${threadId}\n\n`
    + "Every message its lead sent it, oldest first (T3 notifications, limit resumes and the launcher's own nudges left out), each headed with the turn that answered it and how that turn ended. "
    + "PENDING marks every message after the last turn that ended `VERDICT: DONE` (all of them when none did): do those, in order.\n\n"
    + entries.map((e, i) => `## Message ${e.n} · turn ${e.turn ?? "none"} · ${e.outcome} · ${e.pending ? "PENDING" : "done"}\n\n${entryText(e.text, task, i === 0, chain)}\n`).join("\n");
  return { task, entries, body, deps: [...chain.deps] };
}
function pendingLine(entries, file) {
  const pending = entries.filter((e) => e.pending).map((e) => e.n);
  if (!pending.length) return `Every message its lead sent it is in ${file}, oldest first: all are done (its last lead message's turn ended \`VERDICT: DONE\`), so don't redo them.`;
  return `Every message its lead sent it is in ${file}, oldest first, each headed with how its turn ended. Do every message marked PENDING there, in order (${pending.length === 1 ? "message" : "messages"} ${pending.join(", ")} of ${entries.length}: those after its last \`VERDICT: DONE\` turn); compare the diff with each first and keep what is already done.`;
}
// Written whole or not at all: a reader never sees half a file.
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const recorded = recordsThread;
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
    // A reviewer keeps its role whatever HANDOFF_COMPACTIONS says.
    const reviewer = isReview || REVIEWERS.includes(labelFor(snap.modelSelection?.model) ?? model);
    if (until) {
      log("continue: AGY is out; a fresh thread takes the job instead of", attach);
      await abandon(attach, "AGY is out");
      if (label === "gemini-flash") toHaiku(until);
      attach = undefined;
      snap = undefined;
    } else if (n >= Number(process.env.HANDOFF_COMPACTIONS ?? (reviewer ? 3 : 2))) {
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
      // A worker's successor gets every lead message of the old thread in a file, each with how its
      // turn ended, and the stage's original task once (plan 1120 S3); then this round. Read before
      // anything changes: without them nothing is saved, settled or started (r1 F2).
      let msgs = null, state = "", msgFile = null;
      if (!reviewer) {
        msgs = handoffMessagesOrStop(attach, snap);
        state = msgs.state;
        msgFile = path.join(job, `handoff-${nextHandoff(job, n)}-messages.md`);
      }
      saveReport(snap, true);
      const task = msgs?.task ?? "";
      // The lead sent the original brief again: it is inlined once, above (final F2: no second copy).
      const round = task && prompt.trim() === task
        ? "The lead sent the original brief again (above, between the ORIGINAL TASK markers): finish it, after the PENDING messages."
        : prompt;
      await abandon(attach, "handoff");
      const title = !process.env.TITLE && snap.title ? snap.title : null;
      const opening = `You take over from thread ${attach}; its last report is ${path.join(job, "report.md")}.${process.env.PLAN ? `\nPLAN: ${process.env.PLAN}` : ""}\n\n`
        + (task || state ? `Its edits are uncommitted in the tree: read \`git status\` and \`git diff\` for its files first and keep what it finished.${state}\n\n` : "")
        + (msgs ? `${pendingLine(msgs.entries, msgFile)} Then do this round.\n\n` : "")
        + (task ? `Its original task, for owned files, rules and Verify commands:\n\n${wrapTask(task)}\n\n` : "");
      // Only now: the file describes a thread that has handed off (a refused settle starts nothing and
      // writes nothing). The head, through the EARLIER line, is recorded with it (final F2).
      const head = msgs ? `${opening}${EARLIER}${msgFile}` : null;
      if (head) writeLauncherFile(msgFile, msgs.body, { head: headSha(head), deps: msgs.deps });
      handoff = { from: attach, n, title, text: head ? `${head}\n\n## This round\n\n${round}` : `${opening}${prompt}` };
      if (snap.modelSelection && !process.env.EFFORT) adopt(current(snap.modelSelection));
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
    if (snap.modelSelection && !process.env.EFFORT) modelSelection = current(snap.modelSelection);
    // Older workers used the orchestrator profile; move them on continuation
    // while retaining their exact model and options. T3 preserves the resume cursor.
    if (modelSelection.instanceId === claudeAccount.t3Instance) {
      modelSelection = { ...modelSelection, instanceId: claudeAccount.t3WorkerInstance };
    }
    adopt(modelSelection);
    budgetGate();
    await sendMessage(threadId, prompt, { mode: "queue", modelSelection, label: `subagent ${path.basename(job)}` });
    sent = true;
    budgetCount();
    log("continued", threadId);
  } else if (attach) {
    // Re-poll: attempts.jsonl records the thread's own model and account.
    const s = getThread(threadId);
    if (!s) throw new Error(`ATTACH ${threadId} is not a T3 thread`);
    if (s.modelSelection) adopt(s.modelSelection);
    log("attached", threadId);
  } else {
    // Recorded before the thread exists, so nothing ever sees it as a main thread.
    budgetGate();
    const before = readRecord();
    recordThread(threadId);
    if (handoff && attempt === 1) fs.appendFileSync(path.join(job, "thread_ids_prev"), `${handoff.from}\n`);
    const mine = readRecord();
    try { await createThread({ threadId, projectId: project[0], title, modelSelection }); }
    catch (err) { undoRecordIfNoThread(threadId, before, mine, err); throw err; }
    await sendMessage(threadId, handoff?.text ?? prompt, { mode: "start", modelSelection, label: `subagent ${path.basename(job)}` });
    sent = true;
    budgetCount();
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
  if (!timedOut && rc === 0 && !answered(threadId, thread)) ({ thread, rc = 0, timedOut } = await awaitAnswer(threadId, thread));
  if (timedOut) {
    log("timeout; interrupting");
    await interruptThread(threadId, "timeout").catch((e) => log("interrupt", e.message));
    rc = 124;
    try { thread = getThread(threadId) ?? thread; } catch { /* keep the last read */ }
  }
  return { threadId, thread, rc, priorRunId };
}

// A reply that isn't the answer: a review or worker brief asks for a `VERDICT:` line and the turn
// ended without one, or (any brief) the turn's last paragraph only says the thread waits on its own
// pending work ("I'm waiting for the backend to come back", "When the replays finish, I'll count…").
// Settling the thread then loses the background job's wake-up turn (a reviewer woken by its helper
// approved after the job had saved its no-verdict turn; workers ended on "tests in the background"
// and the settle killed the run). Wait VERDICT_WAIT_MIN (default 15) min for the thread's next turn,
// which is what a thread woken by its own job does; if none starts, ask once to finish (review
// wording for a review, worker wording otherwise). Up to 4 extra turns, then the last reply is the
// report, said on stderr and in run.log.
const VERDICT_RE = /^VERDICT:\s*(APPROVE|REVISE|DONE|BLOCKED)\b/m;
// VERDICT_NUDGE and workerNudge: at the top (LAUNCHER_NUDGES).
// A sentence that says the thread itself waits on its own pending work; one that waits on a person or
// a decision ("waiting for your review", "still waiting on a separate GO") is a finished report.
// "Running in (the) background" counts for the thread's own work (tests, a job, a run, its helpers,
// explorers, reviewers or delegates), not a service it reports on ("the queue is still running in the
// background"). The subject sits in a lookbehind, so the text checked by notOurs() starts at "running"
// ("the reviewer is still running in the background" is the thread's own helper, not a wait on a review).
const WAITING_RE = /\b(?:(?:I'm|I am|now|still|currently) (?:waiting|awaiting)|I'll wait|(?<=\b(?:tests?|suites?|checks?|jobs?|runs?|builds?|replays?|bench(?:es)?|pytest|playwright|tasks?|helpers?|workers?|(?:sub)?agents?|explorers?|reviewers?|delegates?|children|(?:child )?threads?|it|they)(?: (?:is|are|still|now))* )running in (?:the )?background|I'll (?:report|reply|follow up|post|send|write|summari[sz]e|update|finish|continue)\b[^.\n]{0,60}?\b(?:when|once|after|as soon as)\b|wait(?:ing)? for (?:the )?background|(?:when|once|after) [^.\n]{1,80}? (?:finish(?:es)?|complete[sd]?|(?:is|are) done|comes? back|lands?)\b[^.\n]{0,40}\bI'll)\b|(?:^|[;,:–—]\s*)(?:waiting|awaiting)\b(?!\s*,)/i;
// People a report may wait on: the reader, the lead, the user, and the user's first name (from
// OWNER_NAME, else git's user.name), so "awaiting <name>'s decision" is a finished report.
let notOursRe;
function notOurs(text) {
  if (!notOursRe) {
    let owner = process.env.OWNER_NAME;
    if (owner === undefined) try { owner = execFileSync("git", ["config", "user.name"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/[\s_-]+/)[0]; } catch { owner = ""; }
    const name = owner ? `|${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : "";
    notOursRe = new RegExp(`\\b(?:you|your|the user${name}|the lead|review(?:er)?|approval|go-ahead|decision|sign-off|confirmation)\\b|\\b(?:a|your|his|her|their|the|separate${name ? `|${name.slice(1)}'s` : ""}) go\\b`, "i");
  }
  return notOursRe.test(text);
}
// A brief that asks for a verdict line names its values; "the VERDICT: label" in a task is not one.
const asksVerdict = /VERDICT:\s*(?:APPROVE|REVISE|DONE|BLOCKED)\b/.test(prompt);
const reviewsVerdict = () => isReview || /VERDICT:\s*(APPROVE|REVISE)\b/.test(prompt);
const lastReplyOf = (threadId, t) => (t?.latestRunId ? runReplies(threadId, t.latestRunId).at(-1) ?? "" : "").trim();
const waitingOnly = (text) => !VERDICT_RE.test(text)
  // Quoted and code spans are product text the report talks about ("a \"hold still waiting\" note"), not its own state.
  && (text.split(/\n\s*\n/).at(-1) ?? "").replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, "…").split(/(?<=[.!?])\s+/).some((x) => {
    const m = WAITING_RE.exec(x.trim());
    // What it waits on: from the waiting words to the sentence end, minus an aside ("(the user is busy)").
    return m && !notOurs(x.trim().slice(m.index).replace(/^[;,:–—\s]+/, "").split(/[(;]/)[0]);
  });
function answered(threadId, t) {
  const text = lastReplyOf(threadId, t);
  return asksVerdict ? VERDICT_RE.test(text) : !waitingOnly(text);
}
const waitNudge = () => reviewsVerdict() ? VERDICT_NUDGE : workerNudge(asksVerdict);
async function awaitAnswer(threadId, thread) {
  const waitMs = Number(process.env.VERDICT_WAIT_MIN ?? 15) * 60000;
  const why = (t) => waitingOnly(lastReplyOf(threadId, t)) ? "waiting reply" : "no verdict";
  let nudged = false;
  for (let turn = 0; turn < 4 && !answered(threadId, thread); turn++) {
    log(why(thread), "in", thread.latestRunId, nudged ? "after the nudge" : "", `; waiting ${waitMs / 60000} min for the thread's next turn`);
    let r = await waitTurn(threadId, { priorRunId: thread.latestRunId, sent: true, startWithinMs: waitMs });
    if (r.noStart) {
      if (nudged) break;
      nudged = true;
      const nudge = waitNudge();
      log(nudge === VERDICT_NUDGE ? "asking for the verdict" : "asking the worker to finish", threadId);
      console.error(nudge === VERDICT_NUDGE ? "reviewer ended a turn without a verdict: asked it to finish" : `ended a turn on ${why(thread)}: asked it to finish`);
      await sendMessage(threadId, nudge, { mode: "queue", modelSelection, label: `finish ${path.basename(job)}` });
      r = await waitTurn(threadId, { priorRunId: thread.latestRunId, sent: true });
    }
    if (r.timedOut || r.rc) return r;
    thread = r.thread;
  }
  if (!answered(threadId, thread)) {
    log(`${why(thread)}; report.md is the thread's last reply`);
    console.error(asksVerdict && why(thread) === "no verdict" ? "no VERDICT line in the reviewer's last reply" : "the thread's last reply still only says it is waiting");
  }
  return { thread, rc: 0 };
}

// Limit go-around: a Claude worker on the main account moves to its overflow account
// (claude.overflow) with the same model; Codex opens a new thread on the next account (auto mode only),
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
  const isCodex = !!codexByInstance(modelSelection.instanceId);
  // A good run ends a sign-out mark; a dead login (the provider's own error, never the reply)
  // marks the account and goes around like a limit (auto mode), or stops with the login hint.
  // Only a turn this launch ran marks or clears: a re-poll (ATTACH without CONTINUE) reads an old turn.
  const ranTurn = !(attempt === 1 && process.env.ATTACH && !process.env.CONTINUE);
  if (rc === 0 && isCodex && codexName && ranTurn) { try { if (codexLoginOk(codexName)) log(`codex account ${codexName} ran: sign-out mark cleared`); } catch {} }
  const loggedOut = rc !== 0 && isCodex && !!codexName && codexLoginRe.test(thread?.lastError ?? "");
  if (rc === 0 || !(loggedOut || thread?.lastErrorClass === "usage_limit" || limitRe.test(errorText))) break;
  const who = isCodex ? codexName : modelSelection.model;
  if (loggedOut) {
    const line = `codex account ${codexName} signed out (${thread.lastError.split("\n")[0].trim().slice(0, 200)}); ${autoAccount ? "trying the next account" : "ACCOUNT is pinned"}`;
    console.error(line); log(line); fs.appendFileSync(path.join(job, "limits.log"), `${line}\n`);
    let said = `codex account ${codexName}: an earlier turn, not marked`;
    if (ranTurn) try { said = markSignedOut(codexName, codexHome(codexName), thread.lastError); } catch (e) { said = `codex account ${codexName}: sign-out mark failed: ${e.message}`; }
    console.error(said); log(said);
    if (!autoAccount) {
      const hint = loginHint(codexName, codexHome(codexName));
      console.error(hint); log(hint); fs.appendFileSync(path.join(job, "limits.log"), `${hint}\n`);
      break;
    }
  } else {
    log("limit reached on", who);
    console.error(`limit reached on ${who} (attempt ${attempt})`);
  }
  const overflowTo = claudeAccount.overflow[modelSelection.instanceId];
  if (overflowTo) {
    // The main Claude account's limit: the same model reruns on the overflow account, before any
    // model fallback (its windows are its own).
    const line = `Claude overflow: ${modelSelection.instanceId} -> ${overflowTo}`;
    console.error(line); log(line); fs.appendFileSync(path.join(job, "limits.log"), `${line}\n`);
    modelSelection = { ...modelSelection, instanceId: overflowTo };
  } else if (isCodex && autoAccount) {
    tried.push(codexName);
    try { modelSelection = selection(model); } catch (e) { console.error(e.message); break; }
  } else if (modelSelection.model?.startsWith("claude-fable-")) {
    // Fable and Opus share the Claude 5-hour session: on that limit Opus would fail the same way.
    // Only Fable's own weekly bucket falls to Opus.
    if (/5-hour|five_hour/i.test(errorText)) {
      const line = "Claude 5-hour limit: Opus shares it, so no Opus fallback; rerun this job after the reset";
      console.error(line); log(line); fs.appendFileSync(path.join(job, "limits.log"), `${line}\n`);
      break;
    }
    // A thread on an overflow instance (moved, re-polled or started there) keeps that account.
    const onOverflow = Object.values(claudeAccount.overflow).includes(modelSelection.instanceId);
    fallbackFrom = label;
    label = "opus";
    modelSelection = selection("opus");
    const to = onOverflow && claudeAccount.overflow[modelSelection.instanceId];
    if (to) modelSelection = { ...modelSelection, instanceId: to };
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
  await abandon(threadId, loggedOut ? "signed out" : "usage limit");
}

// A provider-error turn isn't a review round (plan 1120 S3b: a recheck killed by a "cybersecurity
// risk" flag counted as rounds 2 and 3). The round counted at the send goes back when the launch ends
// failed (rc ≠ 0, a lastError, not a usage limit: the go-around above handles those) and no turn of
// this launch replied: any assistant reply in a run after the one the launch started from (a turn that
// replied and then failed still counts). rounds_failed gets a line first, then `rounds` goes back, so
// a crash in between over-counts rather than under-counts.
function repliedSince(threadId, priorRunId) {
  const runs = t3Query("select run_id from orchestration_v2_projection_runs where thread_id = ? order by ordinal", [threadId]).map((r) => r.run_id);
  const from = priorRunId ? runs.indexOf(priorRunId) + 1 : 0;
  return runs.slice(from).some((id) => runReplies(threadId, id).length > 0);
}
function uncountProviderError({ thread, rc, threadId, priorRunId }) {
  if (!roundCounted || rc === 0 || !thread?.lastError) return;
  if (thread.lastErrorClass === "usage_limit" || limitRe.test(thread.lastError)) return;
  // Only this launch's failure: a timeout (the launcher interrupted it) or a new run that ended
  // without failing (interrupted, cancelled) is no provider error, whatever older session error
  // T3 still reports as lastError (it outlives the turn that failed).
  if (rc === 124) return;
  if (thread.latestRunId && thread.latestRunId !== priorRunId && thread.status !== "failed") return;
  let replied = true;
  try { replied = repliedSince(threadId, priorRunId); } catch (e) { log("rounds: reading replies", e.message); }
  if (replied) return;
  const line = `round ${countedRound} not counted: provider error: ${thread.lastError.replace(/\s+/g, " ").trim().slice(0, 160)}`;
  fs.appendFileSync(path.join(job, "rounds_failed"), `${new Date().toISOString()} ${threadId} ${line}\n`);
  const file = path.join(job, "rounds");
  if (roundsBefore === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, roundsBefore);
  roundCounted = false;
  log(line);
  console.error(line);
}
uncountProviderError(result);
// A final run that ends with no verdict and no findings (`F1 [blocker|should|nit]`) reviewed
// nothing: its round goes back (see FINAL_JOB_RE). One with findings and no verdict counts.
const FINDING_RE = /\bF\d+\s*\[?(blocker|should|nit)\b/i;
function uncountEmptyFinal({ thread, threadId }) {
  if (!roundCounted || !finalKey) return;
  let text = "";
  try { text = lastReplyOf(threadId, thread); } catch (e) { log("rounds: reading the final reply", e.message); return; }
  if (VERDICT_RE.test(text) || FINDING_RE.test(text)) return;
  const line = `round ${countedRound} not counted: the final run ended with no verdict and no findings`;
  fs.appendFileSync(path.join(job, "rounds_empty"), `${new Date().toISOString()} ${threadId} ${line}\n`);
  const file = path.join(job, "rounds");
  if (roundsBefore === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, roundsBefore);
  roundCounted = false;
  log(line);
  console.error(line);
}
uncountEmptyFinal(result);

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
