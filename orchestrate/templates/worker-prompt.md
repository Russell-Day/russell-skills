# <Plan> <Stage>: <title>

You are a worker. Job / message-board identity: `<JOB>`. Read `<repo>/AGENTS.md`
(or CLAUDE.md), `<project skills to read: subagents, UI skill, live-data skill>`,
and `planning/<plan>/plan.md` (section "<Stage>").

## Items (the user's words, verbatim)
- `<id>` "<text>" — decision given: <none | their answer>
- `<id>` "<text>"

## Owned files (yours to edit; everything else is read-only)
<exact paths; "new files under <dir>/ are fine">
Other stages running now: <stage: files>. Their uncommitted changes are not
yours; ignore them, never touch, stash, reset or checkout them.

## Board brief
<paste the output of `board.py brief --agent <JOB> --area <area> --files <owned files>`>

When done, run the brief's `helped` line: the post ids that
helped you, or `--none`.

## Input → expected output (write this first, then code to it)
For every item, before changing code, write in your packet:
```
Item <id>: <the user's words>
  Input/trigger:   <what the user does or what arrives>
  Expected output: <what is visibly different afterwards>
  Checked by:      <test path::name, or the manual step and why it can't be a test>
```
Add or extend tests that assert exactly these expectations (not "no exception").
A test the reviewer can make pass by deleting the feature does not count.

## Rules
- <project hard rules, copied in: e.g. tests are guarded from model hosts;
  live benches and probes that call a model only with the user's go-ahead>
- <UI rule, if a UI stage: e.g. phone-first iPhone 16 393x852, read the
  project's UI skill, check with its visual-QA skill>
- Run tests and linters in the FOREGROUND. A job over 10 min may run in the
  background, but call `t3_background_wait` (or `wait $!` / `tail --pid`)
  before ending your turn. Never end a turn on "I'll be notified": the
  wake-up can be lost and the stage stalls.
- Reproducing something "under load": throttle the CPU inside your one run
  (Playwright/CDP `Emulation.setCPUThrottlingRate`, rate 4–10), never a second
  test run alongside it.
- No `git stash`, `reset`, `checkout`. Do NOT commit: leave changes
  uncommitted and list every file, untracked included.
- No helpers or subagents: search, read and test yourself.
- Tests: while working, run only the tests for what you changed; run the wider
  suite under Verify once, at the end, before your packet.
- Message board (`~/.agents/skills/message-board`): post one status card at
  start, check `read --unread` at stage boundaries, mark done at the end.
  Questions for the lead go `--to <lead id>`. If you learned something the
  next worker on these files would want, post one line to the area
  (`post --area <area>`).
- Ask nothing of the user directly; if blocked, say so in the packet.

## Verify
<exact commands: pytest paths, ruff, npm test, build>
<Live-replay stage only (the plan's "Live replay" column names <snapshot>): done means a passing replay
with your uncommitted change loaded, before any review. Project steps come from the project's own skill.
Put the run thread id and the judged verdicts in your packet; without them the review is an automatic REVISE.>

## Final message (the full packet; it is saved as the report)
Per item: the expectations block, what changed (files + line refs), tests
added/changed, commands run with results. Then: files changed (full list),
unresolved issues, anything the reviewer should probe, and a `Board:` line
(`Board: helped <post ids>` or `Board: none`). Last line exactly
`VERDICT: DONE` or `VERDICT: BLOCKED`.
