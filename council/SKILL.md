---
name: council
description: Run a council, a scored multi-model review by Opus, Fable and Sol 6.1 at high effort, looping until every member scores at least 9/10, then record the rounds and scores in the commit or PR. Use only when the user asks for a council (e.g. "council", "council this", "run the council on the plan"); it never replaces the normal review cadence.
---

# Council

A council is three reviewers from two providers who score the same work out of
10, round after round, until each one gives it at least **9/10**. Round 1 seats
everyone at once so nobody anchors on anyone else. After that the cheapest
member goes first and the expensive pair only sees work that already cleared
it, which saves tokens.

Run it only when asked. Ordinary stage reviews and finals keep following the
[subagents](../subagents/SKILL.md) skill's "Review cadence".

## Members

| Member | Model id | `t3-thread.mjs` label | Effort |
|---|---|---|---|
| Opus | `claude-opus-5-5` | `opus` | high |
| Fable | `claude-fable-5-1` | `fable` | high |
| Sol 6.1 | `gpt-6.1-sol` | `sol61` | high (pass `EFFORT=high`; its default is medium) |

If the user names other members, use those instead and keep the same loop,
cheapest first. Effort is high for every member.

## Before round 1

Bring the work up to date first: apply the fixes you already know about,
answer open review comments, and run the checks. Members should score what you
would ship, not a draft with known holes. (Skip fixes to code the user plans to
throw away.)

## The member brief

Use the repo's review prompt if it has one (the subagents skill's
`code/review-prompt.md`, or a project copy), filled in as usual. Then add:

> You are one member of a review council. Work read-only: don't edit, commit or
> post anything. Give your findings, most serious first, each with the file and
> line and what goes wrong. Judge the work against what was asked, not against
> features you would add. Finish with exactly these two lines:
> `SCORE: N/10`
> `Short of 10 because: <one line>`

These two lines take the place of the template's `VERDICT:` line: drop that
line from the filled review and recheck prompts, since APPROVE/REVISE means
nothing in a council.

For a plan, design or screenshots ("council on the plan"), swap the code
review prompt for a plain brief: what the work is for, where it lives, and the
same addendum.

Round 1 is blind: no member sees another's findings. Rechecks get the filled
recheck prompt (`code/recheck-prompt.md`) listing what you changed for that
member's findings, plus the addendum again.

## Dispatch

Members run through the subagents skill's `t3-thread.mjs`, one thread each.
The script blocks until the member's turn ends, so start each one as its own
background task and wait for all of them:

```bash
S=~/.agents/skills/subagents/code   # or the repo's own subagents copy
EFFORT=high JOB=<topic>-council-opus  node $S/t3-thread.mjs opus  /tmp/<topic>-council.md
EFFORT=high JOB=<topic>-council-fable node $S/t3-thread.mjs fable /tmp/<topic>-council.md
EFFORT=high JOB=<topic>-council-sol61 node $S/t3-thread.mjs sol61 /tmp/<topic>-council.md
```

The reply lands in `<jobs dir>/<JOB>/report.md` (jobs dir: `$AGENT_JOBS_DIR`,
default `~/.local/state/agent-jobs`). A recheck continues the member's own
thread: the same line with `ATTACH=$(cat <jobs dir>/<JOB>/thread_id)
CONTINUE=1` and the recheck prompt.

A lead that delegates with T3's `delegate_task` instead starts one task per
member with high effort in `target.options`. Each recheck there is a new task,
so its brief carries the earlier findings and what changed.

## The loop

1. **Round 1: all three in parallel**, blind. Merge the findings, decide which
   to take, and fix them.
2. **Opus alone.** Recheck Opus, fix, and repeat until it scores 9 or higher.
3. **Fable and Sol 6.1 together.** Recheck both in parallel, fix, and repeat
   until both score 9 or higher. If a fix is big (a new design, not a patch),
   send it past Opus once more before the pair sees it.
4. **Done** when every available member's latest score is 9 or higher. There
   is no round cap.

A member already at 9 or higher sits out the following rounds, whatever the
step, unless the work it scored has changed in a way that matters.

Each pass of whichever members ran is one round. Findings are weighed, not
obeyed: you decide what's in scope. A member that asks for a new feature or a
broader rewrite gets a "noted, out of scope" in its next recheck, not the
feature. Keeping the scope tight is the lead's job.

## A member that can't run

When a member hits a usage limit or its pool is out, carry on with the
others and write `unavailable (<why>)` in its cells for the rest of the
council. Never swap in another model and never wait for the reset. After
every member run (rechecks too), check that the last line of the job's
`attempts.jsonl` names that member's `model_id`:
- `t3-thread.mjs` quietly moves a limited Fable job to Opus (`model_id` is
  `claude-opus-5-5`). That review is not Fable's: drop its score and mark
  Fable unavailable.
- A limited Sol 6.1 run on the default account ends with a non-zero `exit`
  in `attempts.jsonl`; `report.md` then holds the limit error or a partial
  reply with no `SCORE:`. (With `ACCOUNT=auto` the script first
  tries the next Codex account, still Sol 6.1, which is fine.)

## Recording the rounds

Put this section in the commit body, in the PR description if there is a PR
(edit the description, never a comment), and in your final reply.

```markdown
## Council
Rounds: 4 · passed at 9/10 each
| Member | R1 | R2 | R3 | R4 | Final |
|---|---|---|---|---|---|
| Opus 5.5 (high) | 7 | 9 | — | — | 9 |
| Fable 5.1 (high) | 6 | — | 8 | 9 | 9 |
| Sol 6.1 (high) | 7 | — | 9 | — | 9 |
| Average | 6.7 | — | — | — | 9.0 |
```

- `—` means the member didn't run that round. Final is its latest score.
- The Average row always gives R1 and Final. Middle rounds get an average only
  when all three ran.
- A reply with no `SCORE:` line is `no score`. Never guess one. Averages use
  only the scores that exist.
- An `unavailable` member is left out of the averages, and the header says so:
  `Rounds: 3 · passed at 9/10 (Fable unavailable: weekly limit)`.
- Add a trailer line to the commit: `Council: 4 rounds, 6.7 → 9.0`.

Then give the user a short summary: the score path, the findings you took, the
ones you turned down and why, and anything still open.
