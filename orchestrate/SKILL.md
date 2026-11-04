---
name: orchestrate
description: "Run a list of improvement items to completion through visible, persistent t3-thread workers: group items into stages with disjoint file ownership, write a plan, dispatch workers, review each stage, fix-loop on the same thread, commit on APPROVE, mark items done. Also a template for spinning specialised orchestrators for other recurring lists (bug reports, plan stages). Works in any repo."
---

# Orchestrate

The lead loop for finishing a list of items with delegated workers the user
can watch. Workers are T3 threads from [subagents](../subagents/SKILL.md),
never the harness's built-in Agent/Explore subagents (those vanish with their
context). Model routing, account pools, quota checks, the shape (lead writes
vs workers) and the hard rules live in the subagents skill; queueing, pausing,
waiting and hand-off live in the pacer skill when one is installed. This skill
is only the loop. A project's own rules (`AGENTS.md`, a project copy of a
skill) win over anything here.

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
  Tooling idea = one concrete change to a skill, script or prompt that would
  have saved time in that step; post a real one to the board as an
  `efficiency` hint (message-board skill).
- Questions (§4) and the final report (§11) keep their formats; the final
  report also ends in the block.

## 0. Setup

- `S=~/.agents/skills/subagents/code` (or the project's copy, e.g.
  `.agents/skills/subagents/code`).
- No worker budget: dispatch every ready stage that shares no files with a
  running one. With the pacer installed, the one brake: before each Claude
  Opus worker read `pacer.mjs status`; at or over its `Working N/cap`, start
  one at most.
- Pick a plan slug `<plan>` (e.g. `62-improvements-round`) and a job prefix
  (`p62-`); every JOB, prompt file and index path uses it.

## 1. Intake

Read the source list through its adapter (below). Per item record: id, the
user's exact words, any decision they gave, and the files it touches (a
Gemini Flash helper through `run.sh` can locate them; read `REPO_MAP.md` or the
repo's equivalent first). Skip nothing silently: out of scope, already done or
unclear items go in the plan with that status.

Read the area notes first (`python3 ~/.agents/skills/message-board/scripts/board.py
notes find <area words>`, message-board skill "Notes"): how past rounds
handled the area. Cite the slugs in the plan and paste what matters into
worker prompts.

## 2. Stages

Group items so that every stage owns a **disjoint set of files**, is one
review and one commit's worth (1–5 small items, or one big one), keeps UI and
backend apart when the reviewer differs, and comes after any stage whose
output it needs. Models per stage come from the subagents routing table.
Quick wins first so the user sees movement; risky stages when quota is fresh.

## 3. Plan file

Write `planning/<plan>/plan.md` (fallback `docs/plans/<plan>.md`) from
[templates/plan.md](templates/plan.md): stage table (items, model, status),
the user's decisions, open questions, the commit rule, and a **Resume**
section (stage status, decisions, next step, open risks). Keep the status
column and Resume current: the lead, the user and a woken thread read them.

## 4. Questions, then queue

Only for decisions that are the user's (taste, priority, money or quota,
privacy, hard-to-undo). Research first, then write each as a scoped block
(subagents skill, "Questions for the user"; a project copy may name it
for its owner) and put the same blocks in the
plan. Stages that don't depend on an answer go ahead, with a working guess
recorded for the rest; "go with the guess" makes it the decision.

Once answered, fill Resume. With the pacer skill installed, follow its "Day
protocol" (enqueue or ready, priority and size, over pace, asleep) and "How to
wait". Without it, start building right away, and wait for a known time with
`continuity.mjs nudge`.

## 5. Dispatch

Pick the shape first (subagents, "Pick the shape"); stages the lead writes are
reviewed and committed exactly like a worker's. For each worker stage: mark
its items started (adapter), fill [templates/worker-prompt.md](templates/worker-prompt.md)
into `/tmp/<plan>/<stage>.md` (it carries the worker rules: verbatim items and
decisions, owned files and the other stages' WIP, input → expected output,
foreground tests, no stash or commit, no helpers, the packet and `VERDICT:`;
add the project's hard rules), and launch it: T3's `delegate_task` by default
(subagents "Dispatch": clientRequestId `<prefix><stage>-impl-r1`, fix rounds
by `t3_thread_send`). The `t3-thread.mjs` fallback, also the JOB naming
reference:

```bash
# one Bash call each, run_in_background: true (no trailing &), so its exit wakes you;
# then (Claude leads) t3_background_wait with the task ids so T3 shows you as Waiting
JOB=<prefix><stage>-impl EFFORT=<effort> TIMEOUT=90m \
  node $S/t3-thread.mjs <model> /tmp/<plan>/<stage>.md
```

Fill the prompt's `## Board brief` from `python3
~/.agents/skills/message-board/scripts/board.py brief --agent <JOB> --area
<area> --files <owned files>`; the area is the plan's note slug (`board.py
areas`), else the closest one. Each reviewer gets its own brief under its
review JOB.

## 6. Wait

End the turn and let the report wake you: a `delegate_task` child wakes you
on completion; a shell launch runs as a harness background task. No sleep
loops or pollers (pacer skill, "How to wait", for the full rule).

When woken, read the job directory (`~/.local/state/agent-jobs/<JOB>/`, or
the project copy's job root): `exit_code`, then `report.md`. A `CONTINUE` turn
rewrites `exit_code`, so compare its mtime with the launch time (`stat -c
%Y`), never `-nt` against the wrapper log. Exit 0 is not acceptance: read the
report, its `VERDICT:` line, the file list and `git status`. If the wrapper
died, the thread still runs: `ATTACH=<threadId> JOB=<same> node
$S/t3-thread.mjs …` re-polls it. On `TIMEOUT`, `CONTINUE` with "write the
packet from what you have".

**A report that only says it is waiting** on a job ("I'll be notified when it
finishes") is not done. Check the job yourself, then send "continue: your job
finished, finish the stage" (or "wait for your job, then finish") to its
thread (`t3_thread_send`; fallback `ATTACH=… CONTINUE=1`).

A packet without a `Board:` line gets "add your Board: line and run the helped
command" with the next send. While waiting, answer worker questions from
`board.py read --agent <lead id> --unread` with `board.py post --to <JOB>`.

## 7. Review

Reviewers, efforts and the final pair come from the project's subagents
"Review cadence" (default: terra61 high per stage, rechecks on its thread;
finals terra61 high + sol61 medium, blind). A project may run an Opus high
review loop until it APPROVEs before the terra61 review, which stays blind to
the Opus findings (see its Review cadence).
Copy its `review-prompt.md`, fill the slots, and append
[templates/review-addendum.md](templates/review-addendum.md) (the expectations
check). Scope it exactly: base commit, the stage's files including untracked,
the other stages' dirty files to ignore, the worker's claims with line refs,
named adversarial probes, exact test commands.

```bash
# launched like §5 (background task, then t3_background_wait)
JOB=<prefix><stage>-opus-review node $S/t3-thread.mjs opus /tmp/<plan>/<stage>-review.md  # optional Opus loop first
JOB=<prefix><stage>-review node $S/t3-thread.mjs terra61 /tmp/<plan>/<stage>-review.md
# final: both, blind, same prompt, each on its own thread
JOB=<prefix>final-terra node $S/t3-thread.mjs terra61 /tmp/<plan>/final.md
JOB=<prefix>final-sol EFFORT=medium node $S/t3-thread.mjs sol61 /tmp/<plan>/final.md
```

Findings are weighed, not obeyed (§9).

## 8. Input → expected output (testing expectations)

Every item must be checkable. The worker writes, per item, before coding:

```
Item <id>: <the user's words>
  Input/trigger:   <what the user does or what arrives: a tap, a message, a file, a cron tick>
  Expected output: <what is visibly different afterwards: state, response, file, UI>
  Checked by:      <test path::name, or the manual step if it cannot be a test and why>
```

Then adds tests that assert exactly those expectations (not "returns without
error") and lists the block in its packet. The reviewer checks each item has
a block asserted by a named test that fails when the behaviour is removed (it
reverts the line in its scratch copy and reruns). Missing or tautological
expectations are a REVISE, not an Optional.

## 9. Fix loop

On REVISE for a stage the lead wrote, the lead fixes it. For a worker's
stage, write `/tmp/<plan>/<stage>-fix.md` (findings kept with the reviewer's
line refs; dropped ones and why) and send it to the **same worker thread**:

```bash
ATTACH=$(cat ~/.local/state/agent-jobs/<prefix><stage>-impl/thread_id) CONTINUE=1 \
  JOB=<prefix><stage>-impl node $S/t3-thread.mjs <model> /tmp/<plan>/<stage>-fix.md
```

A worker past 3 compactions gets no new round: `CONTINUE=1` (or a project's
`--next-round`) moves it to a fresh thread with the old id, last report, PLAN,
brief and findings. A stage whose first turn compacts 3+ times was too big:
split what's left. Then a targeted recheck on the **same reviewer thread**
with the subagents `recheck-prompt.md` (`ATTACH=<review thread> CONTINUE=1`),
naming only the open finding ids.

**Budget** (adapted from t3dotgg's sol-loop): Codex rounds are the scarcest spend.
- **3 review rounds per stage** (review + rechecks). Up to **5** only while a
  blocker with evidence stays open on security, permissions, auth, data loss
  or state/concurrency. Every recheck sent is a round. An optional Opus
  pre-review loop (a project's Review cadence) has no cap: it runs until it
  APPROVEs or you close it; the cap applies to the terra61 review after it.
- **Device-bound stages** (only a real device or another machine can test the
  build): iterate on the device until its log shows the fix working, then one
  recheck for that build, never one per attempt.
- **Weigh every finding yourself**: check severity against the code, take the
  smallest fix, push back with file:line or test evidence where it's wrong.
  Never agree just to end the loop.
- **No round for small stuff.** Nits-only means stop. Declined nits and
  doc/comment-only fixes get no recheck: verify them yourself and close.
- **If review grew the diff, cut first** (code, tests or guards the intent
  doesn't need) before the next round.
- **At budget end** fix what you agree with. If every open id is disputed with
  evidence, commit and list them in the report; otherwise stop and ask the
  user. Never a 4th round (6th for the security case), and no
  rewrite-plus-fresh-review to get around it.

## 10. Commit

One stage per commit, on APPROVE (or at budget end with every open id
disputed), by the lead (workers never commit). When the tree holds other
stages' or sessions' WIP, commit from a **private index with a HEAD check**,
so a commit from another session in between is not rolled back:

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
`Reviewed-by: terra61 (APPROVE)` (finals: `terra61 + sol61`; at a budget end:
`Reviewed-by: terra61 (REVISE, disputed F2 F5)`, plus `closed.md` `closed:
done <sha> (disputed …)`), and the harness's Co-Authored-By trailer. With a
clean tree a plain `git add <files> && git commit -- <files>` is fine.

To test the private tree first, export it (`git checkout-index -a
--prefix=/tmp/<plan>/verify-<stage>/` with `GIT_INDEX_FILE` still set) and run
the stage tests there with the repo's interpreter by absolute path. Scratch
copies never get a venv copy, symlink, `uv` or `pip`; an agent started in a
copy auto-loads its `.mcp.json`, so repo MCP servers launch with the venv's
python, never `uv run`.

A lead at 3+ compactions hands off through the pacer (pacer skill, "Day
protocol"); without one, make Resume current and start a fresh thread on the
plan file, then stop. Workers and reviewers continued with `CONTINUE=1` (and
`PLAN=<plan.md>`) move to a fresh thread on their own.

## 11. Mark done and report

Mark each item done with the sha (adapter) and update the plan's status
column. On the board: a short card; one `efficiency` hint if the round taught
a real saving; `board.py helped --agent <lead id> --posts <ids>` for posts
that helped; one finding to the area (`post --area <slug>`) the next worker
would want. Update the area note (one per area touched; create with `board.py
notes path <slug> --new --area "<area>" --projects <repo>`): rewrite its
Summary if the approach changed, add a Log line (`- <date> plan <N> <stage> ·
<sha> · <what was done / learned>`), bump `updated:`.

Small things still open (a reviewer's minor note, a rough edge) are fixed now
or filed on the source list through its adapter; never end on "still open,
none fixed" without their ids.

Final report: stage table (items, sha, verdict), live vs needs a restart,
deferred items with reasons, quota used, efficiency hints posted, and the
`Did · Result · Errors · Tooling idea · Tests` block last. If the repo has a
channel post script, post one line there (`<what shipped> · tests
<pass/fail> · errors <none or what>`). Then `node
~/.agents/skills/session-continuity/scripts/continuity.mjs settle`, only when
nothing waits on the user; otherwise leave the thread open.

## Source adapters

An adapter is three things: **read** the list, **mark started**, **mark done**.

**GitHub issues** (the example):
- read: `gh issue list --state open`
- start: `gh issue comment <n> --body "plan N <stage> · <model> · implementing"`
- done: `gh issue close <n> --comment "plan N <stage> · <sha>"`

**Plain markdown checklist** (the fallback): `TODO.md` or
`planning/<plan>/items.md`, one item per line.
- read: lines matching `- [ ] <id?> <text>`; unnumbered items get ids (`i1`,
  `i2`, …) in the plan file.
- start: `- [~] <text> · <stage> · <model>`; done: `- [x] <text> · <stage> ·
  <sha>`. The checklist edit goes into the stage's commit.

**Other sources** (a project tracker, a bug channel, a plan's stage table):
write the three commands in a specialised orchestrator (next section); the
loop does not change.

## Make a new orchestration skill

For a recurring list with its own rules, make a short specialised
orchestrator rather than re-deriving the loop:

1. Copy [templates/orchestrator-SKILL.md](templates/orchestrator-SKILL.md) to
   `<repo>/.agents/skills/<name>-orchestrator/SKILL.md` (project) or
   `~/russell-skills/<name>/SKILL.md` (general; then run `install.sh` and add a
   README row).
2. Fill the slots: **source adapter**, **stage rules**, **worker rules**
   (project hard rules, skills to read, test commands), **reviewers** (extra
   probes), **done criteria** (restart, deploy, the user's check), **commit
   recipe**.
3. Keep it to one screen: only what differs from this skill, linking here for
   the loop; never copy the loop or the routing table.
4. Project skills are found through `.agents/skills/<name>`; add a
   `.claude/skills/<name> -> ../../.agents/skills/<name>` symlink for Claude Code.
5. Link it in one line from the project's `AGENTS.md`, and from the subagents
   skill if the name isn't obvious.
6. Dry-run it on one small stage before trusting it with a fan-out.
