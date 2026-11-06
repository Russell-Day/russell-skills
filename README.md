# russell-skills

Skills for Claude Code and Codex that let one agent hand work to other models
and keep track of it. I use them every day, and they work in any repo.

## Skills

| Skill | What it does |
|---|---|
| [setup](skills/setup/SKILL.md) | Walks you through setup. It asks which skills you want, reads your T3 Code accounts and limits if you allow it, and writes the account files. |
| [subagents](skills/subagents/SKILL.md) | Picks a model and an account for each piece of delegated work, and starts the workers. |
| [orchestrate](skills/orchestrate/SKILL.md) | Works through a list of tasks with workers, reviews each stage, and commits the stages that pass. |
| [pacing](skills/pacing/SKILL.md) | Before you start more workers, checks whether you are using up your 5-hour or weekly usage too fast. |
| [council](skills/council/SKILL.md) | Has three models score a piece of work, and repeats until all three give it 9/10. Based on the council skill in Theo Browne's [tstack](https://github.com/t3dotgg/tstack). |
| [message-board](skills/message-board/SKILL.md) | Lets agent chats that run in parallel share findings through a local SQLite board. |
| [takeover](skills/takeover/SKILL.md) | Finishes another agent's PR or branch and keeps the original authors' credit. |
| [go-public](skills/go-public/SKILL.md) | Helps you take a private repo public. It finds personal details for you to remove, checks the whole git history for leaks, and sets up a watcher for new issues. |

subagents, orchestrate, pacing and council run their workers as
[T3 Code](https://github.com/pingdotgg/t3code) threads, so T3 Code has to be
running on the same machine. Your own session can run in T3 or in a terminal.
The model names in subagents and council are my picks from my own tests. Change
them to fit your accounts.

## Install

You need Linux, macOS or WSL with git, Node 22 or later and Python 3.9 or
later, plus Claude Code or Codex.

```bash
git clone https://github.com/Russell-Day/russell-skills ~/russell-skills
~/russell-skills/install.sh
```

`install.sh` links each skill into `~/.agents/skills/` and from there into
your Claude Code and Codex skill folders, so a `git pull` updates every agent
at once. Run `install.sh` again when a new skill appears.

Then start a new Claude Code or Codex session and say "Use the setup skill to
set me up." The agent checks what is missing, asks which skills you want, and
writes your account files. The sections below show how to do the same steps
by hand.

To check the install, start a new session and ask "Using the subagents skill,
which model should review a risky change?" The answer should name a model from
the routing table in [subagents](skills/subagents/SKILL.md).

Some skills need another tool:

- go-public needs [gitleaks](https://github.com/gitleaks/gitleaks),
  [git-filter-repo](https://github.com/newren/git-filter-repo) and the
  [GitHub CLI](https://cli.github.com) (`gh`).
- takeover needs `gh`.
- council needs [uv](https://docs.astral.sh/uv/) for its before-and-after images.

One tool is optional. With Google's [Antigravity](https://antigravity.google)
CLI (`agy`) installed, subagents can run cheap Gemini helpers.

## Your accounts

The example account file uses one Claude login in `~/.claude` and one Codex
login in `~/.codex`. If that is your setup, skip this section. Otherwise, copy
the two templates:

```bash
cd ~/russell-skills/skills/subagents
cp accounts.example.json accounts.local.json
cp accounts.example.md accounts.local.md
```

Put your Claude config folder, T3 profiles and Codex accounts in
`accounts.local.json`. The `_doc` block in `accounts.example.json` explains
each field. Write capacity notes in `accounts.local.md`, such as which account
has room or costs money. Agents read it before they pick an account.

Any skill folder can also hold a `local.md` with your own additions, and the
skill reads it first. Git ignores `local.md` and every `*.local.*` file.

To clean up finished worker threads on a timer, install the systemd units in
[upkeep.md](skills/subagents/references/upkeep.md).

## Library

`library/` holds skills by other people that only some projects need, such as
design, React and writing skills. Each one keeps its license and a `SOURCE.md`
that says where it came from. `install.sh` doesn't install them.

To use one in a project, run this from the project's root. It links the
`unslop` skill and keeps the links out of git:

```bash
mkdir -p .agents/skills .claude/skills
ln -s ~/russell-skills/library/unslop .agents/skills/unslop   # Codex
ln -s ~/russell-skills/library/unslop .claude/skills/unslop   # Claude Code
printf '%s\n' .agents/skills/unslop .claude/skills/unslop >> .git/info/exclude
```

If you use only one of the two agents, make only its link.

## Tests

```bash
node --test skills/subagents/code/*.test.mjs skills/pacing/scripts/*.test.mjs skills/setup/scripts/*.test.mjs
bash skills/subagents/code/run.test.sh
uvx pytest skills/message-board/scripts/test_board.py
```

The tests use a fake T3, fake model CLIs and test accounts. They never call a
model or read your config.

## Support

I maintain this alone and read issues once a week. Bug reports with steps to
reproduce are welcome. For security problems, see
[SECURITY.md](.github/SECURITY.md).

## License

MIT. Skills in `library/` keep their own licenses.
