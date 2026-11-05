---
name: go-public
description: Take a private, personal codebase (an app, a library, agent skills, an MCP server) to a public open-source repo a stranger can install and use. Inventory what is general and what is yours; generalize the code (config with defaults, adapters, a private overlay so your own setup keeps working); restructure it so it reads clearly; make setup one command with the fewest dependencies, including one-click MCP install; then the last mile, a full-history leak check, clean history and the minimal open-source files; and afterwards a watcher that pings you about new issues, plus a maintenance routine. Use when asked to open-source, publish, make public, "get ready for release", clean up or generalize a repo for other people, or set up upkeep for a public repo.
license: MIT
compatibility: Needs git and Python 3.9+. The leak check needs gitleaks; history rewrites need git-filter-repo; GitHub steps need the gh CLI.
---

# go-public

A personal codebase is written for one person on one machine. Making it public is
mostly **code work**: separating what anyone could use from what only you have,
and making the general part easy to understand and install. The leak check and the
open-source files come last. Six phases, in order; each ends with something the
user looks at.

| Phase | Output | Detail |
|---|---|---|
| 1 Inventory | a table: general / generalizable / personal / delete, and the target user | below |
| 2 Generalize | code and instructions with no personal coupling; your values in an overlay | [references/generalize.md](references/generalize.md) |
| 3 Structure | a layout and README a stranger can navigate | [references/structure.md](references/structure.md) |
| 4 Setup | one install command, fewest dependencies, a passed stranger test | [references/setup.md](references/setup.md) |
| 5 Publish | GO from the leak check, clean history, minimal OSS files, the flip | [references/publish-check.md](references/publish-check.md), [references/oss-basics.md](references/oss-basics.md) |
| 6 Maintain | a watcher on a timer, GitHub automation, a weekly routine | [references/maintain.md](references/maintain.md) |

Scripts (stdlib Python, read-only, paths relative to this skill):

- `scripts/coupling-report.py <repo>`: per-directory and per-file counts of machine paths, personal identifiers, dated history in instructions, and your own terms (`coupling.local.txt`). This is the worklist for phases 1–2.
- `scripts/publish-check.py <repo>`: the GO/NO-GO leak check over all history (gitleaks, personal list, files, GitHub settings). Exits 1 on any BLOCK.
- `scripts/gh-watch.py`: one poll of GitHub notifications, run on a timer. Urgent items go to your notify command and the rest to a digest.

Your own lists stay next to the skill, git-ignored: `personal.local.txt` (what must
never ship), `coupling.local.txt` (what only you have), and `local.md` (your notes
for this skill: notify command, defaults, where your private repo is). Read
`local.md` first if it exists. Copy the `*.example.txt` files to start.

## Rules

- **Two layers, one codebase.** The public repo is the one you keep using. Your
  personal values and integrations move into a git-ignored overlay (`local.md` next to
  a skill, `*.local.json` / `.env` config, an adapter in your private repo) that the
  code reads when it is present. After every phase **your own setup still works**:
  run it. Never fork into a "public copy" that drifts.
- **Bias toward deletion.** A thing that only you use, that would take real work to
  generalize, stays private or goes. A smaller repo is easier to explain and maintain.
- **Name the stranger.** Every "is this clear?" question is asked for the target
  user from phase 1, not for you.
- **One step at a time, committed.** Work in the repo on a branch, commit per step
  with explicit paths, and keep the plan in a git-ignored `GO-PUBLIC.local.md`
  (it names personal things).
- **Nothing outward without a yes.** Creating or flipping a public repo, rewriting
  history and force-pushing need the user's explicit go-ahead in this conversation.
  A history rewrite always happens in a temporary mirror, never the working copy.
- **Don't publish what you won't maintain.** If the user will not answer issues,
  say so in the README ("provided as is, issues off") and turn issues off.

## Phase 1: Inventory (with the user)

1. Run `scripts/coupling-report.py <repo>` (add `--exclude 'vendor/*'` for
   third-party code). Read the README, the top-level layout and every entry point
   (`SKILL.md`, `main`, CLI, server).
2. Name the **target user** in one line: who, which tools they already have, what
   they want from this. Example: "a developer using Claude Code or Codex on Linux or
   macOS who wants to hand work to other models; already has git and Node."
3. Classify every unit (skill, module, script, doc) in one table:

   | Unit | Class | Why | Coupling (from the report) |
   |---|---|---|---|
   | notes-board | general | works anywhere | none |
   | model-router | generalizable | routing idea is general; models and accounts are mine | 120 harness, 80 models |
   | phone-pager | personal | texts my phone through my own assistant | stays private |
   | old-experiment/ | delete | unused for months | |

   Classes: **general** (ship as is), **generalizable** (ship after phase 2),
   **personal** (stays private, or becomes an overlay/adapter), **delete**.
4. Agree the table with the user before changing anything. Personal units move to
   the private repo first, so that nothing later depends on them by accident.

## Phase 2: Generalize

For each generalizable unit, work through the six coupling kinds in
[references/generalize.md](references/generalize.md): machine, identity, personal
tools, harness/vendor lock-in, personal instructions, private context. The fixes, in
order of preference:

1. **Delete** the coupling if the feature works without it.
2. **Detect** instead of assume (`command -v`, `shutil.which`, a config file's presence), with a clear message when something optional is missing.
3. **Config with a default**: env var, then config file (`$XDG_CONFIG_HOME/<app>/`), then a sane built-in default that works out of the box. Commit `*.example.*` and ignore `*.local.*`.
4. **Port and adapter**: a small interface with a generic default (stdout, webhook, no-op). Your personal integration becomes an adapter in the overlay or private repo.
5. **Rewrite instructions for strangers**: state rules as rules, not history. Drop dates, plan numbers and "X said"; keep the *why* when it isn't obvious; cut what any model already knows. Personal preferences go to `local.md`.

Then rerun the coupling report: what is left should be intentional (credits, the
author line) or live only in the overlay. Run your own setup to confirm it works.

## Phase 3: Structure

Follow [references/structure.md](references/structure.md): a layout people
recognise for this kind of repo (agentskills.io layout for skills, `src/` for
Python, and so on), a README that works as a map (what, who for, install, verify,
contents, configure, license), `ARCHITECTURE.md` when there is real code, and one
consistency pass (names, frontmatter, section order). Group or split anything a
newcomer can't place in ten seconds.

## Phase 4: Setup

Follow [references/setup.md](references/setup.md):

1. **Cut dependencies**: stdlib first, PEP 723 + `uv run` when a package is really needed, nothing global, optional tools detected.
2. **One install command** per audience: `npx skills add owner/repo` and a Claude Code plugin marketplace for skills; `claude mcp add name -- uvx pkg` / `npx -y pkg` for MCP, plus a `.mcpb` bundle (double-click, GUI form for settings) for non-technical Claude Desktop users. Add a "verify it worked" prompt.
3. **Stranger test**: in a fresh `HOME` (or a container), follow the README word for word. Better still, hand it to a cold subagent that sees only the README. Every snag is a fix; repeat until it passes.

## Phase 5: Publish (the last mile)

1. `scripts/publish-check.py <repo>`. The fix walkthrough is [references/publish-check.md](references/publish-check.md).
2. **Read-through** of everything that would go public, then **triage with the user**: each BLOCK and REVIEW is fixed, removed, or allowed in `.publish-check-ignore`.
3. **Fix the files**, then **clean the history**: a fresh single-commit history in a new repo (the default for personal repos) or `git filter-repo` in a temporary mirror.
4. **Minimal OSS files** from [references/oss-basics.md](references/oss-basics.md): LICENSE, SECURITY.md, issue forms, and SUPPORT.md if issues are on. (For a full contributor kit, the library's `oss-launch` has templates.)
5. Recheck until **GO**, show the user the result, and only on an explicit **yes** create or flip the public repo and lock it down (commands in publish-check.md step 6).

## Phase 6: Maintain

Follow [references/maintain.md](references/maintain.md):

1. **Watcher**: `scripts/gh-watch.py --repos owner/repo --notify-cmd "<your notifier>"` on a 10-minute timer, and a weekly `--digest` to wherever you read summaries.
2. **GitHub automation**: Dependabot (weekly, grouped) with auto-merge for patch/minor, stale only on `needs-more-info`, issue forms with blank issues off, optional release-please.
3. **Keep the layers apart**: keep developing in the public repo and add a pre-push hook that runs `publish-check.py`, so a personal line added next month can't ship.
4. **Routine**: one weekly batch, saved replies, a stated response time, and saying no early.

## Hand-off

At the end of each phase, report the counts (coupling before and after, publish-check
verdict) and what changed, and ask before starting the next phase.
