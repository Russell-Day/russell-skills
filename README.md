# russell-skills

Russell Day's agent skills for Claude Code, Codex and Antigravity (AGY): the ones
he uses every day to delegate work to other models, run multi-stage coding
rounds through visible worker threads, and let parallel agent chats coordinate.
They are written for a Linux or WSL machine running
[T3 Code](https://github.com/pingdotgg/t3code) as the agent front end, and
they work from any repo.

Some personal skills (usage pacing, session continuity, a personal assistant
integration) live in a separate private repo. Skills here mention them where
they help (orchestrate queues its rounds with the pacer when one is installed)
and work without them.

## Skills

| Skill | What it does |
|---|---|
| [subagents](subagents/SKILL.md) | Model and account-pool routing for delegated work (planning, UI, implementation, exploration, review), plus the dispatch scripts: T3's `delegate_task` by default, `t3-thread.mjs` for visible T3 worker threads, `run.sh` for headless runs. Includes the `t3-api.mjs` T3 adapter, `usage.mjs` limit checks, review and recheck templates, and systemd timers that settle finished worker threads and close their idle sessions |
| [orchestrate](orchestrate/SKILL.md) | The lead loop for finishing a list of items through visible T3 workers: stages with disjoint file ownership, a plan file, dispatch, one review per stage, a fix loop on the same thread, commit on APPROVE, mark items done. Also a template for specialised orchestrators for recurring lists |
| [message-board](message-board/SKILL.md) | A local SQLite board where parallel chats post work cards and findings, get a short brief for their area, list T3 threads, message an idle chat, and keep per-area how-to notes |
| [council](council/SKILL.md) | A scored review by Opus, Fable and Sol 6.1 at high effort, run only when asked. All three review round 1 together, then the cheapest goes first: Opus until it scores 9/10, then Fable and Sol 6.1 together until both do. The commit or PR records every round's scores and averages. The idea comes from the `council` skill in Theo Browne's [tstack](https://github.com/t3dotgg/tstack) (MIT); the text here is our own |
| [takeover](takeover/SKILL.md) | Take over another agent's PR, branch or thread and finish its goal: read the source and its review findings, import the original commits onto a new branch with your fixes on top, keep authorship and co-author credit, update it to the current base, verify the real workflow, then file and watch the PR |
| [dev-projects](dev-projects/SKILL.md) | Rules for working on projects kept in OneDrive without syncing virtualenvs or `node_modules` into it (a local `C:\dev` copy, two-way synced). Needs your own `dev.ps1` runbook in OneDrive |

## Install

```bash
git clone https://github.com/Russell-Day/russell-skills ~/russell-skills
~/russell-skills/install.sh
```

`install.sh` symlinks each skill into `~/.agents/skills/` and from there into
`~/.claude/skills`, `~/.claude_*/skills` and `~/.codex*/skills`. Edits in this
repo show up everywhere at once. Rerun it after adding a skill.

The scripts need Node 22+ and Python 3 (standard library only; the message
board tests use pytest).

## Setup

Copy the account templates and fill in your own:

```bash
cd ~/russell-skills
cp accounts.example.json accounts.local.json
cp accounts.example.md accounts.local.md
```

Both local files are git-ignored. The subagents scripts read
`accounts.local.json` (Claude config dir and T3 profiles, Codex accounts and
their homes, optional extra job roots, the message board's feedback line) and
fall back to `accounts.example.json`. Agents read `accounts.local.md` for
capacity notes: which pool has room, which account is a reserve, which plans
cost you money. The `_doc` block in `accounts.example.json` explains each field.

The optional systemd user timers (`subagents/systemd/`) are installed by
copying them to `~/.config/systemd/user/`; the subagents skill has the
commands.

A project can keep its own copy of a skill (for example
`<repo>/.agents/skills/subagents` with project rules); the project copy wins
inside that repo.

## Library

`library/` holds skills that are not installed globally: design, UI, motion
and React skills that only some projects want. Each one has a folder with the
skill files and a `SOURCE.md` (upstream repo, commit, license, fetched date,
what was dropped and why), and `library/library.json` lists them all with
tags, kind (`markdown` or `has-scripts`) and status (`available`, or `known`
for skills listed but not copied in: ones that ship scripts, or whose
license notice can't be shipped with them).

A project gets a library skill through a symlink in its own repo,
`<repo>/.agents/skills/<name>` and `<repo>/.claude/skills/<name>` pointing at
`library/<name>`, with both paths in that repo's `.git/info/exclude` so the
link is never committed. A project that wants to fine-tune a skill replaces
the link with a real copy. `install.sh` skips `library/`.

The library is public content only: third-party skills under their own
licenses (kept next to each skill). Project-tuned skills stay in their
projects.

## Tests

```bash
node --test subagents/code/*.test.mjs
bash subagents/code/run.test.sh
python3 -m pytest message-board/scripts/test_board.py
```

The tests run against fake T3 and fake model CLIs in temp homes; they never
call a model. `run.test.sh` needs at least two Codex accounts in
`accounts.local.json` for its account-retry case.

## License

MIT for this repo's own skills (see [LICENSE](LICENSE)). Each skill in
`library/` keeps its upstream license, listed in its `SOURCE.md` and shipped
next to it.
