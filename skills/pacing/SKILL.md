---
name: pacing
description: Spend a usage window evenly instead of burning it in the first two hours and stalling until the reset. Before starting heavy delegated work (Claude Opus workers, a fan-out), check whether the 5-hour or weekly window is ahead of an even-spend line, then start, start one, or queue the rest for later. Use when starting workers, planning a fan-out, or when asked whether there's room to run more.
license: MIT
compatibility: Needs the subagents skill and T3 Code running (usage comes from its usage.mjs). Node 22+.
---

# Pacing

Several parallel Opus workers empty a 5-hour Claude window in two to three
hours, and then everything waits for the reset. Pacing keeps usage near a
straight line from 0% at the window's start to 100% just before it resets, so
work keeps moving all day and the overflow runs later.

Read `local.md` next to this file first if it exists: your own caps, margins
and queue tool.

## Check

```bash
node ~/.agents/skills/pacing/scripts/pace.mjs                  # Claude 5-hour window
node ~/.agents/skills/pacing/scripts/pace.mjs --window weekly  # the weekly window
```

It prints used %, the pace line and one of three states. `--json` for scripts,
`--cached` to skip the refresh, `--margin N` to reach 100% N minutes before the
reset (default 10), `--instance` for another T3 provider instance.

## Rules

- **Check before each heavy start**: every Claude Opus worker or fan-out, not
  every helper. Cheap helpers (Haiku, Gemini, Codex on its own pool) don't
  count against the Claude window.
- **Under or on pace**: start what's ready. Unused window is lost at the reset,
  so under pace near the end is a reason to start more, not less.
- **Over pace**: start at most one more heavy worker. Write the rest into the
  plan's queue (the Resume section of the plan file) with what each needs, and
  start them when the check says on pace again or after the reset.
- **Check the weekly window too** before a big fan-out. Over the weekly line,
  prefer a model on another pool for the parts that don't need Opus.
- **Never stop running work to save usage.** Pacing decides what starts, not
  what stops; a worker mid-step finishes its step.
- **Waiting**: don't poll. End the turn with the queue written down; resume when
  a report wakes you or after the reset. T3 can resume a thread that hit a
  limit on its own (its auto-resume setting).
- **Cap**: without a number in `local.md`, run at most 4 working Opus threads
  at once, the lead included.
