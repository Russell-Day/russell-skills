---
name: setup
description: Set up russell-skills for the person you're working with. Check what's installed, ask which skills they want to keep, then (with their permission) read their T3 Code accounts, plans and usage limits and write the account files the other skills use. Use when they ask to set up, install, configure or onboard these skills, when a skill complains about a missing tool or account file, or when they want to add or drop skills later.
license: MIT
compatibility: Node 22+ and git. Reading accounts and limits needs T3 Code installed, and the limits need it running.
---

# Setup

You walk the person through setup and do the work yourself. Ask before each
step that installs something, reads their T3 Code data or writes a file. Keep
each question short and give a recommendation with it.

Read `local.md` next to this file first if it exists.

The script is `node ~/.agents/skills/setup/scripts/setup.mjs`. Below it is
called `setup.mjs`. Every command takes `--json`.

## 1. Check the machine

Run `setup.mjs check`. It needs no permission because it reads only tool
versions, whether T3 Code runs, and which skills are linked.

Tell the person what is missing, in one short list. Each required tool says
which skills need it. Offer to install the missing tools with their package
manager (for example `brew`, `apt`, `npm` or `uv tool install`). Ask before
you run an install, and ask again before anything that needs `sudo`.

## 2. Pick the skills

Show this table and ask which skills they want. Ask with multiple choice if
your harness supports it. Recommend subagents, pacing and orchestrate for
anyone who runs T3 Code, and message-board for anyone who runs several agent
chats at once.

| Skill | What it does | Needs |
|---|---|---|
| subagents | Picks a model and account for delegated work and starts the workers. | T3 Code |
| orchestrate | Works through a task list with workers and a review on each stage. | subagents |
| pacing | Checks whether the 5-hour or weekly usage is going too fast. | subagents |
| council | Has three models score a piece of work until all give it 9/10. | subagents, uv |
| message-board | Lets parallel agent chats share findings. | Python |
| takeover | Finishes another agent's PR and keeps the authors' credit. | gh |
| go-public | Takes a private repo public and checks it for leaks. | gitleaks, gh |

Then link their picks:

```bash
~/russell-skills/install.sh --only <skill> <skill> ...
```

`--only` also keeps setup, adds subagents when a pick needs it, and unlinks
the skills they didn't pick. Run `install.sh` with no arguments to link every
skill again. Skip the T3 steps below if they kept none of subagents,
orchestrate, pacing and council.

## 3. Read their T3 Code accounts

Ask before you run this step. Tell them what it reads:

- From T3's `settings.json`, each account's name, folder, on or off state and
  compaction window. It skips API keys, passwords and launch arguments.
- From T3, each account's plan name and its usage-limit windows, such as the
  5-hour session and the weekly limit.
- If Antigravity (`agy`) is signed in, its Gemini quota. The usage script uses
  the saved Google login to ask Google's quota service, and may refresh that
  login. Ask about this part on its own.

If they say no to the Antigravity part, add `--no-agy` to every `setup.mjs`
and `usage.mjs` command from here on. If they say no to all of it, use
`--no-usage` with `setup.mjs` and skip the `usage.mjs` check in step 6.

Then run `setup.mjs detect`. It shows the plans and limits only while T3 Code
is running. If T3 isn't running, ask them to start it, or run
`setup.mjs detect --no-usage` to skip the limits.

## 4. Write the account files

Run `setup.mjs draft` and show the result. A line that starts with `PROBLEM`
means T3 has no Claude or no Codex account turned on. Ask the person to turn
one on in T3 Code, then run `draft` again. Until then, `--write` refuses.

Then ask about each choice the draft made:

- **The Claude account for the lead agent** (`claude.t3Instance`) and the one
  for workers (`claude.t3WorkerInstance`). A worker profile with a smaller
  compaction window saves usage. If they have only one, use it for both.
- **The Codex account to use first** (`codex.default`), and whether any
  account is a reserve. Agents use a reserve only when the others run low.
- **Accounts that are off in T3.** The draft leaves them out, so ask if they
  want them added.
- **Plans that cost extra money** when they go over, so agents avoid them.

Write the files with `setup.mjs draft --write`, then edit them to match the
answers. The files are `accounts.local.json` and `accounts.local.md` in
`~/russell-skills/skills/subagents/`. Git ignores both.

If either file already exists, `--write` keeps it. Show the person how the
draft differs from it, and change only what they agree to. Use `--force` only
when they want the file replaced.

## 5. Optional extras

Offer these one at a time, and skip the ones that don't apply:

- **T3 settings.** If `check` shows that "auto-resume limited threads" or
  "snooze limited threads" is off, suggest turning both on in T3's settings.
  T3 then pauses a thread that hits a usage limit and resumes it after the
  reset. Don't edit T3's `settings.json` yourself while T3 runs.
- **Cleanup timers.** On Linux with systemd, offer the timers in
  [upkeep.md](../subagents/references/upkeep.md). They settle and archive
  finished worker threads.
- **Personal additions.** Any skill folder can hold a `local.md` with their
  own rules, such as a lower worker cap for pacing. Git ignores it.

## 6. Check that it works

Run the checks for the skills they kept, and skip the rest:

```bash
node ~/.agents/skills/subagents/code/usage.mjs   # subagents: plans and limits for each account
node ~/.agents/skills/pacing/scripts/pace.mjs    # pacing: whether the 5-hour window is on pace
python3 ~/.agents/skills/message-board/scripts/board.py --help   # message-board
```

Then tell them to start a new agent session, so the new skills load. Give
them one question to try for a skill they kept. With subagents, that is
"Using the subagents skill, which model should review a risky change?" The
answer should name a model from the subagents routing table.

End with a short summary: which skills are linked, which accounts the skills
use, and what is still missing. Tell them they can run this skill again at
any time to add or drop skills or change accounts.
