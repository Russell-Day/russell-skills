---
name: orchestrate
description: "Run a list of improvement items to completion through visible, persistent t3-thread workers: group items into stages with disjoint file ownership, write a plan, dispatch workers, review each stage, fix-loop on the same thread, commit on APPROVE, mark items done. Also a template for spinning specialised orchestrators for other recurring lists (bug reports, plan stages). Works in any repo."
---

# Orchestrate

The lead loop for finishing a list of items in parallel with delegated workers
that the user can watch. Workers are T3 threads from
[subagents](../subagents/SKILL.md) (`t3-thread.mjs`), never the harness's
built-in Agent/Explore subagents: those vanish with their context, so nothing
can be attached to, continued or inspected afterwards.

Model routing, account pools, quota checks and the hard rules live in the
subagents skill. This skill only encodes the loop. A project's own rules
(`AGENTS.md`, a project copy of a skill) win over anything here.

```
intake → stages → plan file → questions (if any) → Resume + enqueue (pacer)
→ mark started → dispatch → wait → review → fix loop → commit → mark done → report
```

## How you post

The user reads only the last line of a turn, so:
- Write nothing between tool calls: no narration, no "now I'll …".
- A turn where nothing finished ends in one progress line, `S<i>/<n> · <state>`
  (`S2/3 · review r1 running`, `S1/2 · worker dispatched`).
- A turn where a task finished (a stage committed, a review verdict, a block,
  the round done) ends in one block, each field short, "none" when empty:
  `Did: … · Result: … · Errors: … · Tooling idea: … · Tests: …`
  Tooling idea = one concrete change to the coding tooling (a skill, script or
  prompt) that would have saved time in that step. Post a real one to the board
  as an `efficiency` hint (message-board skill).
- Questions for the user (§4) and the final report (§11) keep their formats;
  the final report also ends in the block.

## 0. Setup

- `S=~/.agents/skills/subagents/code` (or the project's copy, e.g.
  `.agents/skills/subagents/code`, when the repo has one).
- Nothing to arm: T3 0.1.0 snoozes a thread that hits a usage limit and resumes
  it after the reset (leads and workers alike).
- No worker budget: dispatch every stage that's ready and doesn't share files
  with a running one, with one brake:
  before starting each Claude Opus worker, read
  `node ~/.agents/skills/pacer/scripts/pacer.mjs status`; if its `Working N/cap`
  line is at or over the cap, start one at most and let the rest wait for a
  running one to finish. Haiku, Codex and Gemini helpers don't count. The pacer
  counts working Opus threads (workers included) for its wakes and never pauses
  a worker. `node $S/usage.mjs` shows the raw windows.
- Pick a plan slug `<plan>` (e.g. `62-improvements-round`) and a job prefix
  (`p62-`). Every JOB, prompt file and index path uses it.

## 1. Intake

Read the source list through its adapter (below). For each item record: id,
the user's exact words, any decision they already gave, and the files it touches
(ask a Gemini Flash helper through `run.sh` to locate them; read `REPO_MAP.md`
or the repo's equivalent first). Skip nothing silently: an item that is out of
scope, already done or unclear goes in the plan with that status.

Read the area notes before planning: `python3
~/.agents/skills/message-board/scripts/board.py notes find <area words>` and
open the hits (message-board skill, "Notes"). They say how past rounds handled
the area. Cite the slugs you used in the plan and paste what matters into
worker prompts.

## 2. Stages

Group items into stages so that:
- every stage owns a **disjoint set of files** (concurrent workers edit
  different files; a shared file forces a shared stage or a sequence);
- a stage is one review and one commit's worth (roughly 1–5 small items, or one
  big one);
- UI stages are separate from backend stages when the reviewer differs;
- an item that needs another stage's output comes after it.

Assign a model per stage from the subagents routing table (Opus for
implementation and UI, sol61 medium as the
reviewer; sol61 high only for the final all-commits review). Decide the order: quick wins first so the user sees movement, risky
stages when quota is fresh.

## 3. Plan file

Write `planning/<plan>/plan.md` (or the repo's planning dir; fallback
`docs/plans/<plan>.md`) from [templates/plan.md](templates/plan.md): the stage
table (items, model, status), decisions the user gave, open questions, and the
per-stage commit rule, and a **Resume** section (stage status, decisions, next
step, open risks). Keep the status column and Resume current; they are what the
lead, the user and a thread woken by the pacer read.

## 4. Questions

Only for decisions that are the user's (taste, priority, money or quota, privacy,
hard-to-undo). Research first, then write each one as a scoped block, exactly
as in the subagents skill under "Questions for the user". Put the same blocks in
the plan file. Don't block stages that don't depend on the answer: dispatch
those, ask in the same message, and record a working guess for the rest. If they
answer "go with the guess", that guess becomes the decision.

**Then queue, don't fan out at once.** Once they have answered, fill Resume. With
a pacer installed (a separate skill, not in this repo), run
`pacer.mjs enqueue --plan planning/<plan>/plan.md --priority <p> --size <s>`
(it snoozes this thread and wakes it with "Pacer: your turn" when the Claude
window has room) and end the turn. Without one, start building right away; the
rest of this paragraph is about the pacer. No closing marker is needed: the pacer treats a thread as waiting on
the user only while a question of its is recorded open in the user's ask
tracker, never from a message's wording. `--priority` (`low`, `med`,
`high`, `highest`) is the highest priority among the plan's items: the user's
`@high`-style tags set it; untagged, use `med` or your judgement with a
one-line reason in the plan. `--size` comes from the stage count: 1–2 stages
`s`, 3–5 `m`, 6+ `l` (long plans are preferred at night). Start right away only when
`pacer.mjs status` shows room (working < cap and usage under pace) and
no "ON HOLD" line (the user's hold: always enqueue; only they run `go`); then
run `pacer.mjs ready --plan planning/<plan>/plan.md` instead of enqueue, so the
pacer stops counting the thread as triaging (only ready threads get pause
asks; triaging ones never do). The
pacer paces every main Claude thread, queued or not, so any lead can get
"Pacer: over pace": finish the stage you're in (let a running Claude worker
finish, start no new one); once it's done, if the next step is a sol61
review or recheck, dispatch that before you pause (Codex is a separate limit; its report waits for you). Update
Resume (note the running review), run `pacer.mjs pause --plan planning/<plan>/plan.md`, and stop. If
the stage ends with questions for the user, don't pause: just stop, so the
thread stays awake in their list.

**While the user is asleep.** Before ending a turn on a question, run
`node ~/.agents/skills/pacer/scripts/pacer.mjs sleep`. Its fresh output is
what counts, not an older wake message: if it prints `asleep`, don't end the turn on a question while another
stage can move: write the question into the plan's Questions section, carry on
with the stages it doesn't block, and end with it only when nothing else can
move. They get every thread's open questions in one list when they wake.

## 5. Dispatch

Before each Claude Opus worker, check the pacer's `Working N/cap` line (Setup):
at or over the cap, start one at most. For each stage, mark its items started (adapter), fill
[templates/worker-prompt.md](templates/worker-prompt.md) into
`/tmp/<plan>/<stage>.md`, and launch it. In a T3 session the default is T3's
`delegate_task` (subagents skill, "Dispatch": clientRequestId
`<prefix><stage>-impl-r1`, fix rounds by `t3_thread_send` to the child; its
completion wakes you). sol61 reviews run on `t3-thread.mjs`, which compacts a
REVISE reviewer at once so each recheck continues that thread (subagents skill
"Review cadence"). The `t3-thread.mjs`
form below is the fallback and the reference for the JOB naming:

```bash
JOB=<prefix><stage>-impl EFFORT=<effort> TIMEOUT=90m \
  setsid nohup node $S/t3-thread.mjs <model> /tmp/<plan>/<stage>.md \
  > /tmp/<plan>/<stage>.log 2>&1 < /dev/null &
```

Rules the prompt must carry (the template has them):
- the item ids and the user's exact words, plus every decision they gave;
- **owned files** (exact paths; others read-only) and the other stages' names
  so the worker knows whose WIP to ignore;
- the **input → expected output** rule (section 8);
- message-board identity = JOB; project hard rules copied in (model calls, live data,
  whatever the repo's `AGENTS.md` says);
- tests run in the **FOREGROUND**; a job over 10 min may run in the background,
  but the worker calls `t3_background_wait` before ending its turn, never
  ending on "I'll be notified" (the wake-up can be lost);
- no `git stash`, `reset`, `checkout`, no commit: leave changes uncommitted
  and list every file, untracked included;
- no helpers or subagents: the worker searches, reads and tests itself; while working it runs only the tests for what it changed, the wider suite once at the end;
- a full packet in the final message ending in `VERDICT: DONE` or `VERDICT: BLOCKED`.

Before filling the prompt, run `python3 ~/.agents/skills/message-board/scripts/board.py
brief --agent <JOB> --area <area> --files <owned files, comma list>` and paste its
output into the prompt's `## Board brief`. The area is the plan's area note slug
(`board.py areas` lists them), else the closest one (`--area` is required).
Each reviewer gets its own brief, run under the review JOB with the same area
and files, so its tokens and marks count separately (subagents `review-prompt.md`).

Launch every ready stage whose files don't overlap a running one.

The plan's size sets the shape (subagents skill, "Pick the shape"): `s` (1–2
stages) the lead writes itself, no workers; `m` (3–5) the lead picks, in-order
stages itself and disjoint ones to workers; `l` (6+) workers only. Stages the
lead writes are reviewed and committed exactly like a worker's.

## 6. Wait

Poll the job directory for `exit_code`
(`~/.local/state/agent-jobs/<JOB>/`, or the project copy's job root):

```bash
J=~/.local/state/agent-jobs/<JOB>
until [ -f $J/exit_code ]; do sleep 60; done; cat $J/exit_code; tail -40 $J/report.md
```

For a `CONTINUE` turn the same `exit_code` file is rewritten, so compare its
mtime with the launch time in epoch seconds (`stat -c %Y`), never `-nt` against
the wrapper log. Exit 0 is not acceptance: read `report.md`, the `VERDICT:`
line, the file list and `git status`. If the wrapper died (lead restarted), the
thread is still running: `ATTACH=<threadId> JOB=<same> node $S/t3-thread.mjs …`
re-polls it (`thread_id` is in the job dir). On `TIMEOUT`, `CONTINUE` with
"write the packet from what you have".

**A report without a packet that says it is waiting** on a job or Monitor
("I'll be notified when it finishes") is not done, even though its task ended.
Check the job's output yourself, then send the worker "continue: your job
finished, finish the stage", or "continue: wait for your job, then finish the
stage" if it still runs (`t3_thread_send` to its thread; fallback
`ATTACH=… CONTINUE=1`). No timers or pollers.

Read the packet's `Board:` line (`helped <post ids>` or `none`); a packet
without one gets "add your Board: line and run the helped command" with the
next send.

While waiting, check the message board inbox (`board.py read --agent <lead id> --unread`)
for worker questions; answer by `board.py post --to <JOB>`.

## 7. Review

One reviewer per stage (sol61 medium; high only for the final review over
all the orchestrator's commits). Copy the subagents
`review-prompt.md`, fill the slots, and append
[templates/review-addendum.md](templates/review-addendum.md) (the expectations
check). Scope it exactly: base commit, the stage's files including untracked
ones, the other stages' dirty files to ignore, the worker's claims with line
refs, named adversarial probes, exact test commands.

```bash
JOB=<prefix><stage>-review EFFORT=medium setsid nohup node $S/t3-thread.mjs sol61 /tmp/<plan>/<stage>-review.md > /tmp/<plan>/<stage>-review.log 2>&1 < /dev/null &
```

Reviewer findings are weighed, not obeyed: drop the ones that fail the
proportion rule, send the rest to the worker.

## 8. Input → expected output (testing expectations)

Every item must be checkable. The worker writes, per item, before coding:

```
Item <id>: <the user's words>
  Input/trigger:   <what the user does or what arrives: a tap, a message, a file, a cron tick>
  Expected output: <what is visibly different afterwards: state, response, file, UI>
  Checked by:      <test path::name, or the manual step if it cannot be a test and why>
```

Then adds or extends tests that assert exactly those expectations (not
"function returns without error"), and lists the block in its packet. The
reviewer checks that every item has a block, that each block's expectation is
actually asserted by a named test, and that the test fails if the behaviour is
removed (it reverts the line itself in its scratch copy and reruns). Missing or
tautological expectations are a REVISE, not an Optional.

## 9. Fix loop

On REVISE for a stage the lead wrote itself, the lead fixes it. For a
worker's stage: write `/tmp/<plan>/<stage>-fix.md` (the findings kept, with the
reviewer's line refs; the ones dropped and why) and send it to the **same
worker thread**:

```bash
ATTACH=$(cat ~/.local/state/agent-jobs/<prefix><stage>-impl/thread_id) CONTINUE=1 \
  JOB=<prefix><stage>-impl setsid nohup node $S/t3-thread.mjs <model> /tmp/<plan>/<stage>-fix.md > … &
```

Then a targeted recheck on the **same reviewer thread** with the subagents
`recheck-prompt.md` (`ATTACH=<review thread> CONTINUE=1`), naming only the open
finding ids.

**Budget** (adapted from t3dotgg's sol-loop): Codex rounds are the
scarcest spend.
- **3 review rounds per stage** (review + rechecks). Up to **5** only while a
  blocker with evidence stays open on security, permissions, auth, data loss
  or state/concurrency. Every recheck sent is a round, whatever prompted it.
- **Device-bound stages** (a build only a real device or another machine can
  test): the reviewer is not the test harness. Iterate builds on the device
  until its log shows the fix working, then send one recheck for that build,
  never one per attempt.
- **Weigh every finding yourself.** Check its severity against the code, take
  the smallest fix, and push back with file:line or test evidence where it's
  wrong. Pushback is good; never agree just to end the loop.
- **No round for small stuff.** Nits-only means stop. Declined nits and
  doc/comment-only fixes get no recheck: verify them yourself and close.
- **If review grew the diff, cut first** (code, tests or guards the intent
  doesn't need) before the next round.
- **At budget end** fix what you agree with. If every open id is disputed with
  evidence, commit and list them in the report; otherwise stop and ask
  the user. Never a 4th round (6th for the security case), and no
  rewrite-plus-fresh-review to get around it.

## 10. Commit

One stage per commit, on APPROVE (or at budget end with every open id
disputed, §9), by the lead (workers never commit). When the
tree also holds other stages' or other sessions' WIP, commit from a **private
index with a HEAD check**, so a commit from another session in between is not
rolled back:

```bash
base=$(git rev-parse HEAD)
export GIT_INDEX_FILE=/tmp/<plan>/idx-<stage>-$$      # fresh path per commit
git read-tree "$base"
git add -- <stage files, untracked included>
tree=$(git write-tree)
[ "$(git rev-parse HEAD)" = "$base" ] || { echo "HEAD moved, redo"; exit 1; }
new=$(git commit-tree "$tree" -p "$base" -F /tmp/<plan>/<stage>-msg.txt)
git update-ref refs/heads/<branch> "$new" "$base"      # fails if HEAD moved
unset GIT_INDEX_FILE; rm -f /tmp/<plan>/idx-<stage>-*
git show --stat HEAD      # only the stage's files
```

Message: `feat(<plan> <stage>): <what the user gets>`, body with the item ids,
`Reviewed-by: sol61 (APPROVE)` (at a §9 budget end: `Reviewed-by: sol61
(REVISE, disputed F2 F5)`, plus `closed.md` `closed: done <sha> (disputed …)`),
and the harness's Co-Authored-By trailer. With
a clean tree a plain `git add <files> && git commit` is fine.

To test the private tree first, export it (`git checkout-index -a
--prefix=/tmp/<plan>/verify-<stage>/` with `GIT_INDEX_FILE` still set) and run
the stage tests there with the repo's interpreter by absolute path
(`<repo>/.venv/bin/python -m pytest …`). Never symlink or copy the venv into a
scratch copy or run `uv`/`pip` there: with `pyproject.toml` but no `uv.lock`,
uv rebuilds the shared venv on latest versions. It needn't be typed: an
agent started with the copy as cwd loads the copy's `.mcp.json`, and any MCP
server launched with `uv run` does it, so launch repo MCP servers with the
venv's python instead.

**Hand off when the lead runs long.** Workers and reviewers continued with
`CONTINUE=1` move to a fresh thread on their own after 3 compactions (set
`PLAN=<plan.md>` on those runs so the new thread gets it). Leads hand off
automatically: at 3+ compactions the pacer hands a queued lead to a
fresh thread instead of waking it, or sends an awake one "Pacer: hand off
now". On that turn, finish or write down the current step, make the plan's
Resume current, run `node ~/.agents/skills/pacer/scripts/pacer.mjs handoff
--plan <plan.md>` and stop once it prints the new thread; the pacer moves the
lead's entries and settles the old thread. Never hand off by hand with
`t3-thread.mjs --orchestrator` (pacer skill, "Lead hand-off").

## 11. Mark done and report

Mark each item done with the sha (adapter), update the plan's status column,
and post a short card on the message board. Post one `efficiency` hint to the
board if the round taught a real saving (message-board skill). Mark the board
posts that helped you this round (`board.py helped --agent <lead id> --posts
<ids>`), and post one finding to the area (`post --area <slug>`) when the round
taught something the next worker on those files would want. The final
report lists every efficiency hint posted this round (How you post), so they
lead to a change. Update the
area notes: one per area touched, created with `python3
~/.agents/skills/message-board/scripts/board.py notes path <slug> --new --area "<area>" --projects <repo>` if missing. Rewrite its Summary if
the approach changed, add a Log line (`- <date> plan <N> <stage> · <sha> ·
<what was done / learned>`) and bump `updated:`. Small things still open at the end
(a reviewer's minor note, a rough edge found while building) are fixed now
or filed on the source list through its adapter, so the next round picks
them up; never end on "still open, none fixed" without their ids. At the
end, write the final report: a stage table (items, sha, reviewer verdict), what is live vs needs a
restart, deferred items with reasons, the quota used, the efficiency hints
posted, and the `Did · Result · Errors · Tooling idea · Tests` block last. If the
repo has a channel post script, post one short line there too: what
shipped, tests pass/fail, errors (`<what shipped> · tests <pass/fail> ·
errors <none or what>`). Then settle:
`node ~/.agents/skills/session-continuity/scripts/continuity.mjs settle`, but
only when nothing waits on the user. With open questions, decisions or steps
for them, leave the thread open instead so it stays in their list
(`settle` also refuses while a question of the thread is recorded open in
the user's ask tracker).

## Source adapters

An adapter is three things: **read** the list, **mark started**, **mark done**.

**GitHub issues** (the example):
- read: `gh issue list --state open`
- start: `gh issue comment <n> --body "plan N <stage> · <model> · implementing"`
- done: `gh issue close <n> --comment "plan N <stage> · <sha>"`
- extra rules: the project's own (model calls, UI skills, commit recipe) go in
  its specialised orchestrator.

**Plain markdown checklist** (the fallback for any repo): a file like
`TODO.md` or `planning/<plan>/items.md` with one item per line.
- read: lines matching `- [ ] <id?> <text>`; give unnumbered items ids
  (`i1`, `i2`, …) in the plan file.
- start: change the line to `- [~] <text> · <stage> · <model>`.
- done: change it to `- [x] <text> · <stage> · <sha>`.
- the checklist edit goes into the stage's commit.

**Other sources** (a project's own tracker, a bug-reports channel, a plan's stage table):
write the three commands or edits in the specialised orchestrator (next
section); the loop does not change.

## Make a new orchestration skill

For a recurring list with its own rules (a bug-reports channel, a plan's stage
table, a release checklist), make a short specialised orchestrator rather than
re-deriving the loop each time:

1. Copy [templates/orchestrator-SKILL.md](templates/orchestrator-SKILL.md) to
   `<repo>/.agents/skills/<name>-orchestrator/SKILL.md` (project-specific) or
   `~/russell-skills/<name>/SKILL.md` (general; then run `install.sh` and add a
   README row).
2. Fill the slots: **source adapter** (read / start / done), **stage rules**
   (what may share a stage, what must not, size), **worker rules** (project hard
   rules, skills to read, test commands), **reviewers** (model, effort, extra
   probes), **done criteria** (what "live" means: restart, deploy, the user's
   check), **commit recipe** (plain or private index, trailer, branch).
3. Keep it to one screen. It says what differs from this skill and links here
   for the loop; it never copies the loop or the subagents routing table.
4. Make it visible to every harness: project skills are found through
   `.agents/skills/<name>`; add a `.claude/skills/<name> -> ../../.agents/skills/<name>`
   symlink for Claude Code.
5. Link it in one line from the project's `AGENTS.md` where that list is
   described, and add a one-line pointer in the subagents skill if it isn't
   obvious from the name.
6. Dry-run it on one small stage before trusting it with a fan-out.
