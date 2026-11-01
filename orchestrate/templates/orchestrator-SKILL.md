---
name: <name>-orchestrator
description: "Run <which list> to completion through visible t3-thread workers: <one line on what differs: source, stage rules, reviewer>. Specialisation of the orchestrate skill."
---

# <Name> orchestrator

Runs the loop in [orchestrate](<relative or ~ path to orchestrate/SKILL.md>)
(intake → stages → plan → dispatch → review → fix loop → commit → mark done)
over **<the list>**. Model routing comes from the subagents skill
(<path to the subagents copy this repo uses>). Only the differences are here.

## Source adapter
- **read:** `<command or file + line format>`
- **start:** `<command or edit>` with note `<format, e.g. "plan N S1 · opus · implementing">`
- **done:** `<command or edit>` with note `<format, e.g. "plan N S1 · <sha>">`
- **item fields that matter:** <id, text, the user's reply/decision, labels, …>

## Stage rules
- <what may share a stage / what must be separate, e.g. UI vs backend>
- <size: items per stage, one commit each>
- <order: quick wins first, …>
- <concurrency: ≤2 Opus workers unless `usage.mjs` shows a fresh window>

## Worker rules (go into every worker prompt, on top of the template)
- <project hard rule 1, copied verbatim from AGENTS.md>
- <skills to read: e.g. UI skill, live-data skill>
- <test / lint commands>
- <job directory: ~/.local/state/<…>-jobs/<JOB>/>

## Reviewers
- <model + effort per stage type, e.g. sol61 medium; sol61 high for the final all-commits review>
- <extra adversarial probes specific to this list>
- expectations check: the orchestrate review-addendum applies to every stage

## Commit recipe
- <plain commit | private index with HEAD check (orchestrate §10)>
- message format: `<type>(<plan> <stage>): <what the user gets>` + trailers
- <branch; push or not>

## Done criteria
- <what "done" means for an item: committed | live after restart | the user's check>
- <what to say in the final report: stage table, live vs restart, deferred, quota>
