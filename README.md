# russell-skills

Agent skills for Claude Code and Codex (and Gemini through Antigravity) for
working with several models at once: hand work to other models in visible
worker threads, run a list of tasks to done with a review on every stage, let
parallel chats coordinate, score work with a multi-model council, take over
another agent's PR, and take a private repo public. They are my daily setup,
shared as is, and they work from any repo.

## Requirements

- Linux, macOS or WSL with bash, git, Node 22+ and Python 3.9+. The scripts use
  only the standard library; the message-board tests need pytest, go-public's
  leak check needs [gitleaks](https://github.com/gitleaks/gitleaks), and the
  council's before/after images need [uv](https://docs.astral.sh/uv/) (it
  fetches Playwright).
- [Claude Code](https://code.claude.com) and/or [Codex](https://github.com/openai/codex).
- [T3 Code](https://github.com/pingdotgg/t3code) as the agent front end for the
  skills marked **T3** below: their workers are T3 threads you can watch and
  steer from the sidebar. takeover and go-public need none of it.
- Optional: Google's [Antigravity](https://antigravity.google) CLI (`agy`, called
  AGY in the skills) for the cheap Gemini helpers that `run.sh` starts.

## Skills

| Skill | Needs | What it does |
|---|---|---|
| [subagents](skills/subagents/SKILL.md) | T3 | Model and account-pool routing for delegated work (planning, UI, implementation, exploration, review), plus the dispatch scripts: T3's `delegate_task` by default, `t3-thread.mjs` for visible worker threads, `run.sh` for headless runs. Includes the `t3-api.mjs` adapter, `usage.mjs` limit checks, review and recheck templates, and optional systemd timers that settle and archive finished workers |
| [orchestrate](skills/orchestrate/SKILL.md) | T3 | The lead loop for finishing a list of items through visible workers: stages with disjoint file ownership, a plan file, dispatch, one review per stage, a fix loop on the same thread, commit on APPROVE, mark items done. Also a template for specialised orchestrators for recurring lists |
| [message-board](skills/message-board/SKILL.md) | Python | A local SQLite board where parallel chats post work cards and findings, get a short brief for their area, and keep per-area how-to notes; with T3 it also lists threads and messages an idle chat |
| [council](skills/council/SKILL.md) | T3 | A scored review by Opus, Fable and Sol 6.1 at high effort, run only when asked. All three review round 1 together, then the cheapest goes first: Opus until it scores 9/10, then Fable and Sol 6.1 together until both do. The commit or PR records every round's scores. The idea comes from the `council` skill in Theo Browne's [tstack](https://github.com/t3dotgg/tstack) (MIT); the text here is our own |
| [takeover](skills/takeover/SKILL.md) | git, gh | Take over another agent's PR, branch or thread and finish its goal: read the source and its review findings, import the original commits onto a new branch with your fixes on top, keep authorship and co-author credit, update it to the current base, verify the real workflow, then file and watch the PR |
| [go-public](skills/go-public/SKILL.md) | Python, gitleaks | Take a private, personal codebase public: inventory what is general and what is yours, generalize the code with a private overlay so your own setup keeps working, restructure, make setup one command (including one-click MCP install), then a full-history leak check (`publish-check.py`), clean history and the minimal open-source files, and a GitHub watcher (`gh-watch.py`) that pings you about new issues |

The model names and scores in subagents and council are my own preferences
from my own bake-offs; change them for your accounts.

## Install

```bash
git clone https://github.com/Russell-Day/russell-skills ~/russell-skills && ~/russell-skills/install.sh
```

`install.sh` symlinks each skill into `~/.agents/skills/` and from there into
`~/.claude/skills` and each existing `~/.claude_*` and `~/.codex*` home, so edits in the
clone show up everywhere at once. Rerun it after pulling a new skill. (The
skills call each other's scripts by their path under `~/.agents/skills`, so the
clone is linked there rather than installed as a plugin.)

**Check it worked:** `ls ~/.agents/skills` lists the skills. In a new Claude Code
or Codex session, ask *"Using the subagents skill, which model should review a
risky change?"* The answer should come from the skill's routing table.

## Setup

The skills work with the example config. To name your own accounts, copy the
templates and fill them in:

```bash
cd ~/russell-skills/skills/subagents
cp accounts.example.json accounts.local.json
cp accounts.example.md accounts.local.md
```

Both local files are git-ignored. The subagents scripts read
`accounts.local.json` (Claude config dir and T3 profiles, Codex accounts and
their homes, optional extra job roots, the message board's feedback line) and
fall back to `accounts.example.json`. Agents read `accounts.local.md` for
capacity notes: which pool has room, which account is a reserve, which plans
cost you money. The `_doc` block in `accounts.example.json` explains each field.

The optional systemd user timers (`skills/subagents/systemd/`) install with the
snippet in [upkeep.md](skills/subagents/references/upkeep.md).

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
the link with a real copy. `install.sh` links only `skills/`.

The library is public content only: third-party skills under their own
licenses (kept next to each skill). Project-tuned skills stay in their
projects.

## Tests

```bash
node --test skills/subagents/code/*.test.mjs
bash skills/subagents/code/run.test.sh
python3 -m pytest skills/message-board/scripts/test_board.py
```

The tests run against fake T3, fake model CLIs and fixed test accounts
(`skills/subagents/code/testdata/accounts.test.json`) in temp homes; they never call a
model or read your own config. The message board tests need pytest
(`pip install pytest`, or `uvx pytest skills/message-board/scripts/test_board.py`).

## Support

This is a one-person project shared as is. Bug reports with steps to reproduce
are welcome (use the issue form); I read them in a weekly batch, so replies can
take a week or two. Requests that only fit one setup are better as a fork.
Security problems: see [SECURITY.md](.github/SECURITY.md).

## License

MIT for this repo's own skills (see [LICENSE](LICENSE)). Each skill in
`library/` keeps its upstream license, listed in its `SOURCE.md` and shipped
next to it.
