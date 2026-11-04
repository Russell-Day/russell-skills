---
name: subagents
description: "Choose models and account pools for delegated planning, UI/UX, implementation, codebase exploration, and review using the author's cost and capability preferences, and dispatch workers as T3 threads or headless runs. Works in any repo."
---

# Subagents

Use this guide when delegating work. Keep small tasks local when delegation adds
more overhead than value. These are the author's preferences, not vendor benchmarks.
Explicit task-specific model choices override this guide, and so do a project's
own rules (`AGENTS.md`, `CLAUDE.md`, a project-level copy of this skill).

The scripts live in `~/.agents/skills/subagents/code` (source:
`~/russell-skills`, github.com/Russell-Day/russell-skills). They work from any
repo: workers run in the caller's git root, and job directories go to
`~/.local/state/agent-jobs/<JOB>/` (override with `AGENT_JOBS_DIR`).

## Pick the shape

The plan's size (the pacer's `--size`) sets the shape: a
worker spends ~50k tokens just getting up to speed, and leads were ~30% of
Opus use while making almost no edits.

- **`s` (1–2 stages): one thread, always.** The thread that owns it writes
  the code itself; no workers.
- **`m` (3–5 stages): the lead's choice.** In-order stages: one thread, plan
  doc kept current, a commit after each. Stages in disjoint files: parallel
  Opus workers.
- **`l` (6+ stages): orchestrator.** The lead plans, dispatches workers for
  every stage and reviews.

Code the lead writes gets the same sol61 review as a worker's; on REVISE the
lead fixes its own stages, and a worker's stage goes back to that worker.

## Accounts and capacity

Workers draw on three pools: **AGY** (Gemini), **Claude** and **Codex**. Each
has a 5-hour session window, a weekly window, or both, and a pool can span
several accounts.

**Read `accounts.local.md` for this machine's accounts and capacity** before
choosing a pool or starting a fan-out. It sits at the root of this skills repo
(`~/russell-skills/accounts.local.md`, the parent of this skill's directory).
The scripts read account names, config homes and T3 profiles from
`accounts.local.json` there, or from `accounts.example.json` if it's missing.

**Cost means capacity.** A model's cost is the share of its pool a typical run
uses up, not its API price. Quota burn tracks API list price, so list prices
convert to shares of the pools. Burn order:
1. **AGY**, for anything Gemini can do.
2. **Claude**, for exploring, implementing and critique.
3. **Codex**, for reviews.

Check live windows and reset times with `code/usage.mjs` (`--json` for raw
output) before choosing a pool or starting a fan-out.

**Default account:** with `ACCOUNT` unset, `run.sh` and `t3-thread.mjs` run
Codex on the account named by `codex.default`. **Auto-pick** is opt-in: with
`ACCOUNT=auto` they choose the Codex account themselves
(`usage.mjs --pick-codex <model-id>`):
1. Non-reserve accounts come first. Among them, the one whose weekly limit
   resets soonest goes first. Accounts that lack the model, or have a window at
   90% or more, are skipped.
2. Reserve accounts (`"reserve": true`) come last, while under 95%.

**When a run hits a limit:**
- **Codex (auto mode)** retries on the next account, up to three. A pinned
  `ACCOUNT` fails instead.
- **Fable** falls back to Opus.
- **AGY (gemini-flash)** reruns the same prompt on Haiku high.
- **Opus** fails, because it has only one pool. Wait for the reset or pick
  another model.

**When a pool is out.** Both launchers read the cached AGY state
(`~/.local/state/agent-stats/agy_state.json`, written by the hourly usage probe
and by any AGY quota error). While a Gemini window is at 100%, `gemini-flash`
runs on Haiku high automatically (`EFFORT` still wins); missing or stale state
(over 2 h) tries Gemini first. The switch is logged in the job's `run.log` and
`limits.log`, and the first one per reset posts a `limits` notice to the
message board. Fable at its limit goes to Opus the same way. To see what is out
and until when, run `code/usage.mjs`. Every attempt is a
line in the job's `attempts.jsonl` (model, account, effort, exit, fallback,
thread or Claude session id).

A retry starts the prompt over, and an editing worker's partial changes stay in
the tree, so check the diff. Limit hits are logged in the job directory.

## Model preferences

Scores are 0–10, higher is better, except **Cost**, where higher means scarcer.
"–" means not tested.

| Label | Exact ID (harness) | Default reasoning | Orchestrator | Taste | Code | Review | Explore | Cost |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `sol61` | `gpt-6.1-sol` (Codex) | med; **high for review** | 5 | 5 | 7 | 9 | 8 | 5 |
| `astra` | `gpt-6-astra` (Codex) | low (med for final checks) | 8 | 7 | 8 | 9 | 8 | 7 |
| `fable` | `claude-fable-5-1` (Claude) | med | 10 | 8 | 8 | 8 | – | 5 |
| `opus` | `claude-opus-5-5` (Claude) | med–high | 7 | 9 | 9 | 8 | – | 3 |
| `haiku` | `claude-haiku-5-5` (Claude) | high | 2 | – | 4 | – | 7 | 1 |
| `sonnet` | `claude-sonnet-5-5` (Claude) | not routed (Haiku does its helper and explorer work) | 3 | 6 | 6 | 3 | 8 | 2 |
| `gemini-flash` | `gemini-3.8-flash-{low,medium,high}` (AGY) | high | 0 | 3 | 3 | 2 | 4 | 1 |

- **Orchestrator:** long-term planning, and tracking goals across stages.
- **Taste:** UI/UX judgment.
- **Code:** functional correctness and thoroughness of implementation.
- **Review:** finding consequential defects.
- **Explore:** finding the real cause of a bug or live problem, including by
  reading live data rather than only code.
- **Cost:** the share of the user's capacity a run uses (see above).

On Codex, route only to Astra and sol61. The `sol` and `luna` labels still work
in the scripts, but nothing routes to them. Don't silently swap model versions;
`run.sh` refuses a model an account lacks rather than substituting. `med` means
`medium`. The scores come from the author's own model bake-off.

## Routing

| Work | Preferred route |
|---|---|
| Search, file inventories, call-path tracing, long reads (leads only; workers and reviewers do it themselves) | Gemini Flash; Haiku only as `run.sh`'s automatic step-up when Flash times out |
| Exploration: bug hunts, "why is X broken", live-data investigation, audits | **Several Gemini Flash (high)** started by the lead; see below |
| Implementation and integration | **Backend-only, test-only and devtools/script stages: sol61 (high) on the default Codex account** while its weekly window is under 60%; everything else, and those past 60%: **Opus (high)**. Never Gemini or Haiku |
| UI/UX and demanding implementation | **Opus (high)**; Fable sometimes, as a second eye; Astra only for 3D modeling |
| Long-term planning and goal management | Fable; Astra as an alternative |
| Plan critique | Opus (high) for depth; sol61 (med) for value |
| Second opinion on a plan or approach | Cross-family; see below |
| Stage review and rechecks | **sol61 (high)**, one reviewer |
| Final check before a milestone | sol61 (high), plus Astra (medium) when quota allows |

**Implementation on Codex.** When Claude's 5 h window is the bottleneck and
Codex has room left in its week, stages with no UI go to sol61 (high) workers:
`EFFORT=high t3-thread.mjs sol61` (`ACCOUNT` unset runs the `codex.default`
account), or `delegate_task` on that account's T3 instance. Only the default
account: never one `accounts.local.md` reserves for something else, and only
while the default's weekly window is under 60% (`usage.mjs`), since the user
uses Codex outside coding too; past that, Opus. UI/UX, hard stages and the
lead's own `s` work stay on Opus. The sol61 review stays as is. Antigravity's
Claude models (Opus/Sonnet 4.6) are not used.

Sonnet isn't routed: a bake-off had Haiku match it on searches, tracing, test triage and bug hunts at about a
tenth of the cost; implementation stays on Opus. Don't use Haiku as a code
reviewer either. It traces what it reads well, but misses
the edge cases a review exists to catch.

**Exploration.** For a bug hunt or investigation whose answer matters:
- **Fan out several Gemini Flash (high) explorers**, each with its own `JOB`
  and a different angle: a subsystem, a hypothesis, the logs, the tests.
  Gemini is nearly free; Haiku counts against the scarce Claude limit, so it
  isn't sent explorers.
- **Tell every explorer to read live data** read-only (logs, databases, data dirs),
  not only the code.

Then reconcile the answers:
- **Where they agree,** it's likely right. Still spot-check the line refs.
- **Where only one claims something,** verify it first. Gemini overstates
  confidence and writes tautological tests.

## Cheap helpers

**Only leads start helpers**: triage, planning and
investigations. **Workers and reviewers start no helpers or subagents**: they
search, read and test themselves (Haiku helpers were most of Haiku's use, on
the scarce Claude limit). Workers run only the tests for what they changed
while working and the wider suite once at the end.

- **Helpers are Gemini Flash** (free, but 4–14 min a job). Haiku only as
  `run.sh`'s automatic step-up when a Flash job times out. No Luna: it draws
  on the Codex pool.
- **Use helpers for** a lead's research: searches and caller tracing, long
  files, logs or docs returned as excerpts, inventories and web research.
- **Dispatch helpers headless** through `run.sh`, not `t3-thread.mjs`. Give each
  a unique `JOB`, and run independent ones in parallel.
- **Ask for paths, line refs and evidence,** and spot-check consequential claims.
- **Helpers stay read-only** unless given disjoint file ownership.
- **Workers start no helpers or subagents.** Put this rule in every worker
  prompt; the templates carry it.

```bash
S=~/.agents/skills/subagents/code
JOB=<lead>-find-callers $S/run.sh gemini-flash /tmp/<lead>-callers.md
JOB=<lead>-inventory    $S/run.sh gemini-flash /tmp/<lead>-inventory.md
```

## Review cadence

- **One reviewer per stage: sol61 at high.** It covers stage reviews, rechecks
  and the reviews during iteration.
- **A multi-model fan-out only when the user asks for one,** and then once, over
  the final range.
- **Final checks before a milestone** add Astra medium when quota allows.
- **A recheck** is a new `delegate_task` round carrying the prior findings and
  the fix report (on the `t3-thread.mjs` fallback: `CONTINUE` on the
  reviewer's own thread).
- **Scope every review exactly.** Give the base commit and the stage's files,
  untracked ones included, and name the unrelated dirty WIP to ignore. One
  review per stage, not per worker or commit.
- **Every stage review ends at APPROVE or a close note.** If a review stops at
  REVISE for good (stage dropped, moved, or its findings filed), write
  `closed.md` in the review's job dir, first line
  `closed: <done|moot|filed chk_…> <sha or reason>`. The weekly stats count it
  as closed; a review with neither stays open.
- **Fill in [review-prompt.md](code/review-prompt.md)** for every stage review;
  it carries the boundary, the probes, the proportion rule and the report format.

Default: `delegate_task` with `clientRequestId: "plan<N>-<stage>-review-r1"` and
target `codex` / `gpt-6.1-sol` / `{reasoningEffort: "high"}` (Dispatch, below).
Fallback:

```bash
JOB=stage-x-review EFFORT=high $S/t3-thread.mjs sol61 /tmp/stage-x.md
JOB=stage-x-final  EFFORT=medium $S/t3-thread.mjs astra /tmp/final.md
```

## Second opinions

For a substantial plan or implementation choice with real tradeoffs, get **one**
independent second opinion before committing to it. Use a different model
family from the lead:

| Lead | Adviser |
|---|---|
| Claude (Opus, Fable) | sol61, `EFFORT=high` |
| Codex (Astra, sol61) | Opus, `EFFORT=medium`; Fable when the user asks |

- **What to send:** the objective, the constraints, the paths, the proposed
  approach and its alternatives, and the open decisions.
- **What to ask for:** challenges to the assumptions, failure modes,
  simplifications and a recommendation. The full opinion goes in the final
  message.
- **Boundary:** read-only, with helpers only.
- **It's advisory, not a gate.** If quota forces a different adviser, report
  the model that actually answered.

## Questions for the user

The user runs several threads at once. A bare question ("phone location opt-in or
saved home?") forces them to rebuild the context himself. **Scope every question
before asking it:**

1. **Research first.** Answer what you can yourself. Send Gemini Flash
   explorers for inventories, git or code checks and web research, several
   in parallel when the questions are independent. Ask only
   for decisions that are really theirs: taste, priorities, money or quota, privacy,
   and anything hard to undo.
2. **Write each question as a self-contained block:**
   - **Question:** one line, in plain words.
   - **Context:** what this is, where it came from, and why it needs deciding now.
     Assume they have forgotten the thread. Explain ids, file names and jargon, or
     leave them out.
   - **What I found:** the evidence and how you got it ("Gemini checked 29 items
     against git", "Haiku web search, sources: …"), including numbers from live
     data.
   - **Recommendation:** your pick and why.
   - **Pros / cons** of the recommendation.
   - **Other options:** each with a one-line tradeoff.
3. **Make it easy to answer.** Number the questions, recommendation first, so
   "1 yes, 2 yes, 3 option B" is a full reply. Keep the decision list in the plan
   file updated with the same blocks.

To run a whole list of items through this (stages, workers, reviews, commits,
marking items done), use the [orchestrate](../orchestrate/SKILL.md) skill.

## Dispatch

Both launchers append [worker communication](code/worker-communication.md):
Caveman full for every worker, reviewer, explorer, and helper, across all model
families (Claude, Codex, Gemini, and future routes), with complete technical
substance and required verdicts. Orchestrators keep their normal style.
Code, commits, PRs, and user-facing content stay in normal language.

Claude orchestrators use the T3 profile `claude.t3Instance` from
`accounts.local.json`, with a **300K auto-compact window**. Workers use
`claude.t3WorkerInstance` with **200K**; both share one Claude config dir and
quota. `t3-thread.mjs` selects the worker profile for new and continued workers. `run.sh` sets
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` for headless Claude workers.
The model picker's `200k` option alone does not set the compaction window
on Claude models with native 1M context. Compaction starts before the configured
window fills, reserving room for the response.

Give each worker:
- a concrete deliverable;
- the relevant paths and exact scope;
- whether it may edit;
- how to verify its work;
- where to put the output.

Concurrent editing workers need disjoint file ownership or isolated worktrees.

**Usage limits continue on their own.** T3 0.1.0 snoozes a thread whose run
hits a usage limit and resumes it after the reset (settings
`autoResumeLimitedThreads` + `snoozeLimitedThreads`), leads and workers alike.
Nothing to arm; `continuity.mjs nudge --in 30m` still sends one "continue" at
a set time.

**Default: T3's `delegate_task`** (MCP tool, `mcp__t3-code__delegate_task`).
The child shows under the lead in the user's sidebar and its completion wakes
the lead, so end the turn instead of polling. Per job:
- `target`: `{providerInstanceId, model, options}` from
  `orchestrator_capabilities`. Workers: `claude.t3WorkerInstance` /
  `claude-opus-5-5` / `{effort: "medium"}` (`"high"` only for UI/UX or a hard stage); non-UI stages (Routing): `codex` / `gpt-6.1-sol` / `{reasoningEffort: "high"}`; sol61: `codex` / `gpt-6.1-sol` /
  `{reasoningEffort: "high"}`; Haiku: the Haiku profile in `accounts.local.md`.
  Instance ids are this machine's: `claude.*` and `codex.accounts[].t3Instance`
  in `accounts.local.json` (`codex` is the default account's).
- `clientRequestId`: `plan<N>-<stage>-<impl|review|fix>-r<round>`, stable
  across retries of that round. Stats tools can read the job name and review
  group from it.
- `title`: what the user gets, in their words (as `TITLE` below).
- `task`: the full prompt (the worker or review template filled in). The child
  sees nothing of the lead's conversation. `delegate_task` doesn't append
  [worker communication](code/worker-communication.md); paste it at the end.
  Reviews end with a `VERDICT: APPROVE|REVISE` line (the stats read it).
- **Fix rounds** go to the worker's own thread:
  `t3_thread_send(threadId=<childThreadId>, message=<findings>)`. It keeps the
  worker's context and returns a new `taskId`.
- **Rechecks** are a new `delegate_task` (next `-r<N>`) carrying the brief, the
  prior findings and the worker's fix report.
- Read results with `task_status(taskId)`; record task ids, rounds and
  commits in the plan doc. Close an abandoned review group with
  `<job root>/<clientRequestId>/closed.md` (same format as below; the job root
  is `~/.local/state/agent-jobs`, or the project's from `jobRoots` in
  `accounts.local.json`).
- Finished children are settled within a minute of stopping (`prune-workers.mjs
  --settle --min 0`, run by `settle-workers.timer` every minute) and archived
  after 5 days. One with background work pending, a live or queued run, a
  running child, a usage-limit resume or a future snooze stays. A fix round to a
  settled child still runs and re-opens it. The lead does no worker cleanup.
- Don't settle a lead while a child runs: a settled lead can miss the
  report. `continuity.mjs settle` refuses then. After a pacer hand-off, a
  report that went to the old, settled lead is relayed to the new one by the
  pacer.

**Fallback: a visible T3 thread** through `code/t3-thread.mjs`, when
`delegate_task` is unavailable (no T3 MCP in the session, a headless lead) or
for features it lacks (ACCOUNT pools and auto fallback across accounts,
`--orchestrator`, handoff at 3 compactions). The user can watch and steer it from the sidebar too. It takes the same labels and env
as `run.sh`: `EFFORT`, `ACCOUNT`, `JOB`, `TIMEOUT`, `NO_SETTLE`. It opens a
`[<model>] <job>` thread, waits for the turn to finish, and writes
`~/.local/state/agent-jobs/<job>/{report.md,transcript.md,thread_id,exit_code}`.
Then it settles the thread.
`TITLE="<fix>"` titles the thread after its fix (`[<model>] <fix>`, so workers stand apart from orchestrator threads): what the user gets, in their words, no plan or stage numbers (a leading "Plan 7 S1:" is dropped; `JOB` keeps the stage); the job dir still marks it a worker for pacer, continuity and prune.
`node $S/t3-thread.mjs --rename "<title>"` renames the thread you run in (a lead retitling itself to the fixes it ships).
`node $S/t3-thread.mjs --orchestrator "<title>" <brief-file> [--model opus] [--effort medium]` starts a MAIN thread (orchestrator profile, not pinned: snoozed while it waits in the pacer's planning line, exact title, the brief as its first message) in this T3 project and prints its id at once; the pacer treats it as triaging until it runs `ready`. Triage threads use it to start one orchestrator per group of items.

**Old worker threads are archived.** `prune-workers.timer` runs
`code/prune-workers.mjs` daily at 04:30: every worker thread (`[<model>] <job>`, or a `TITLE` one its job dir recorded) settled
more than 5 days ago, with no activity since, is archived, so the sidebar keeps the
orchestrators. Archived threads keep their transcripts (unarchive in T3), and job
reports stay in the job directory. `--dry-run` lists them, `--days N` changes the
age, and `--delete` deletes instead. Main threads are never touched.
`--settle [--min N]` settles finished delegate_task children (and the
provider subagent threads under them) once they've been stopped for N min,
and `[<model>] <job>` worker threads that a late report from their own helper
re-opened after the job ended (once no helper of theirs still runs). T3
never settles them itself. `settle-workers.timer` runs it with `--min 0` every
minute, so a finished worker leaves Working at once. It keeps a
worker whose Claude transcript shows background work with no completion notice
yet (`kept … background work pending` in the journal), the same check the
reaper makes, and a Codex worker whose rollout shows an open turn, tool call
or spawned agent; other providers' live sessions are kept until T3
releases them. Install: `cp ~/.agents/skills/subagents/systemd/settle-workers.{service,timer} ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now settle-workers.timer`.

**Finished threads' Claude and Codex sessions are closed.** T3 keeps a thread's `claude`
process (~250 MB plus its MCP servers) for 30 min after its last activity, and
up to 4 h when a finished worker left background work. `reap-sessions.timer`
runs `code/reap-sessions.mjs` every 5 min: a live Claude session whose thread
is settled, archived, snoozed, or a `thread:delegated-task:…` child whose task
ended, with no live or queued run and 5 min without activity, gets T3's
`provider-session.detach`. The process exits; the thread keeps its native
session, so its next message resumes it (`claude --resume`) with its whole
conversation. Open threads keep T3's 30 min. A session whose Claude transcript
shows a background Bash command or Monitor with no completion notice yet is
kept (`kept … background work pending` in the log), since only its live process
can deliver that notice and wake the agent. Codex threads are reaped the same
way: a Codex account runs one shared session (one `codex app-server`)
for all its threads, so each finished thread is detached from it on its own
(T3 unloads just that thread; the shared process stays), judged by its own
activity, and kept while its rollout shows an open turn, tool call or spawned
agent. Each detach, keep or failure is a line
in `~/.local/state/agent-stats/reap-sessions.log`, and a failure fails the
unit. `--dry-run` lists, `--json` prints the result, `--idle-min N` changes the
wait. Install: `cp ~/.agents/skills/subagents/systemd/reap-sessions.{service,timer} ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now reap-sessions.timer`.

```bash
S=~/.agents/skills/subagents/code
cp $S/review-prompt.md /tmp/stage-x.md    # fill in the <...> slots
JOB=stage-y-impl setsid nohup node $S/t3-thread.mjs opus /tmp/stage-y.md > /tmp/stage-y.log 2>&1 < /dev/null &
```

**Running threads:**
- **Launch detached** (`setsid nohup … &`). The wrapper dies when the lead's
  session ends, but the thread keeps running. `ATTACH=<threadId>` with the same
  `JOB` re-polls it.
- **For fix loops, use `ATTACH=<threadId> CONTINUE=1`.** It sends the prompt
  file as a new turn on the same thread, keeping the thread's model and effort
  unless `EFFORT` is set. Use it for review → fix → recheck instead of fresh
  threads.
- **Long threads hand off on their own.** On `CONTINUE=1`, a thread already
  compacted 3 or more times (`HANDOFF_COMPACTIONS=N` to change) gets no new turn:
  `t3-thread.mjs` waits for any running turn there to end (fails, starting
  nothing, if it outlasts `TIMEOUT`), saves its reply as `report.md`, then starts
  a fresh thread (same model, effort, `JOB` and title; `EFFORT` or `TITLE` set on
  the run win) told the old thread's id, that `report.md` and `PLAN` (set
  `PLAN=<plan.md>` on fix and recheck runs), settles the old one, and prints
  `handoff <old>→<new> (N compactions)` (also in `run.log`). `thread_id` then
  holds the new id and `thread_ids_prev` the old ones, so the next `CONTINUE`
  works as before. Every run writes the count to the job's `compactions`;
  `node $S/t3-thread.mjs --compactions [threadId]` prints it (default: your own thread).
- **Leads hand off too, automatically.** The pacer does it for any thread with
  a pacer plan entry at 3+ compactions (never the user's own threads): a queued
  lead is handed off instead of woken; an awake one gets one "Pacer: hand off
  now" turn per compaction level. On it: make Resume current, run `node
  ~/.agents/skills/pacer/scripts/pacer.mjs handoff --plan <plan.md>` and stop.
  Never hand off by hand with `t3-thread.mjs --orchestrator` (pacer skill,
  "Lead hand-off").
- **`TIMEOUT` defaults to 45 min.** Raise it (`TIMEOUT=90m`) for long work. On a
  timeout, `CONTINUE` and ask for the report from what the worker has.
- **To wait for a job,** poll for `exit_code`. For a `CONTINUE` run, compare its
  mtime with the launch time in epoch seconds, never with `-nt` against the
  wrapper log: both are written in the same second.
- **Workers run jobs up to 10 min in the foreground** (A/B runs, benches,
  suites). A longer job may run in the background, but the worker calls
  `t3_background_wait` (or blocks with `wait $!` / `tail --pid`) before ending
  its turn, never ending on "I'll be notified". The job itself survives the
  turn; the wake-up doesn't always. Put this in the prompt.
- **A report that only says it is waiting on a job is not done.** No packet and
  no `VERDICT:` line means: check the job's output yourself, then
  `t3_thread_send` the worker "continue: your job finished, finish the stage"
  (still running: "continue: wait for your job, then finish the stage";
  fallback `ATTACH=… CONTINUE=1`). Never sit on it.
- **Parallel workers use the message board** (`~/.agents/skills/message-board`),
  with their job names as identities.

**Fallback: `code/run.sh`.** It's headless, takes the same labels, and writes
the same job directory. Use it if T3 is down or a `t3 update` breaks the
internal RPC. Use native harness subagents only when neither script works.

```bash
JOB=stage-x-review EFFORT=high $S/run.sh sol61 /tmp/stage-x.md
$S/parallel-review.sh /tmp/stage-a.md /tmp/stage-b.md   # disjoint stages at once
```

Templates: [review-prompt.md](code/review-prompt.md) and
[recheck-prompt.md](code/recheck-prompt.md).

**Hard rules** (each one came from something breaking):
- **Copy the project's hard rules into every worker prompt.** Workers don't
  reliably read `AGENTS.md`. Example: never call a local model server from a second
  process, because chat and embeddings from two processes freeze the
  computer; live benches only with the user's go-ahead and the backend paused.
- **Full permissions.** Run Codex with `--yolo`, and Claude and AGY with
  `--dangerously-skip-permissions`. Put the review-only boundary in the prompt.
- **The prompt comes from a file.** Codex needs `</dev/null`; `run.sh` does both.
- **Ask for the full packet in the final message.** Move any packet a worker
  left in the repo into the job directory.
- **Exit 0 is not acceptance.** Read `report.md`, the `VERDICT:` line, the diff
  and the checks.
- **Name the adversarial probes up front.** Lifecycle races and edge cases are
  what happy-path tests miss.
- **Rechecks are targeted:** the prior packet, what's closed, and the changed
  files.
- **AGY file tools ignore `cwd`.** `run.sh` passes `--add-dir "$CWD"`.
- **Nobody runs `git stash`, `reset` or `checkout` in the main tree.**
- **Four Opus workers empty a Claude 5-hour session in about three hours** (once all four died at once, the lead too). T3 resumes limited threads after the reset, but the work stalls until then: before each Claude Opus worker read `node ~/.agents/skills/pacer/scripts/pacer.mjs status`; working < cap: start it; at or over the cap: start one at most.
- **T3 threads need a T3 project.** `t3-thread.mjs` matches the git root (or,
  from a linked worktree, the main tree) against T3's projects. If none matches,
  run `t3 project add <dir>` or set `PROJECT_ROOT`.
- **Reviewer findings are weighed, not obeyed.** Reviewers never edit; the lead
  fixes stages it wrote itself, and a worker's stage goes back to that worker. Commit only on APPROVE, one stage per commit.
