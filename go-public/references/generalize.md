# generalize.md: removing one person and one machine from the code

The twelve-factor test is a good north star: *the codebase could be made open
source at any moment without compromising anything*. Here that covers more than
credentials. It means nothing in the code assumes your machine, your accounts, your
tools or your habits.

Work unit by unit (one skill, one module), starting with the coupling report's top
rows. For each hit, ask in this order: **delete it, detect it, configure it,
or put it behind an adapter**. Rewriting instructions is its own pass at the end.

## The six coupling kinds

| Kind | Looks like | Usual fix |
|---|---|---|
| **Machine** | `/home/me/...`, `C:\Users\me`, `/mnt/c/...`, `.venv/bin/python`, a Tailscale IP, `desktop-gpu`, port 8001, "the 4090", `cuda:0` | relative paths, `$XDG_*` dirs, `command -v`, config with a default, hardware detection with a CPU fallback |
| **Identity** | your name in instructions, emails, phone, usernames, account IDs, bot accounts | config (`GIT_AUTHOR_*`, `gh api user`), placeholders in examples, or delete |
| **Personal tools** | calls to your assistant, your notifier script, your private repos, your dashboards | a port with a generic default adapter; your tool becomes the adapter in the overlay |
| **Harness / vendor lock-in** | assumes one agent front end, one model lineup, specific subscription pools or account names | make the harness one adapter among others, or name it as a requirement up front; models and accounts move to config |
| **Personal instructions** | "Alex prefers…", sleep hours, "text me first", dated decisions ("since 2026-10-04"), plan numbers, trial periods | rewrite as a plain rule with its reason, or move to `local.md` |
| **Private context** | links to private repos, internal docs, chat threads, ticket numbers, tools strangers can't see | delete, or replace with what the reader needs to know |

## Fixes, in order of preference

### 1. Delete

Ask the reducing-entropy questions: what is the smallest version that does the
job? Can this be zero code (drop the feature)? What only existed because of
something you're removing? Experiments, one-off scripts, migration helpers, debug
dumps and backwards-compatibility shims for your own old setup usually go.

### 2. Detect

```bash
if command -v gitleaks >/dev/null 2>&1; then ...; else echo "gitleaks not found: https://github.com/gitleaks/gitleaks#installing" >&2; exit 2; fi
```
```python
exe = shutil.which("uv") or sys.exit("needs uv: https://docs.astral.sh/uv/")
```

Detect optional extras and keep the core working without them. Say clearly what
is missing and where to get it. Never fail silently and never quietly skip a step.

### 3. Config with a default

Order: **env var → config file → built-in default**. The default must work on a
fresh machine with no config at all (localhost, a SQLite file in the data dir,
stdout logging).

| What | Where (XDG, with fallbacks) |
|---|---|
| config | `${XDG_CONFIG_HOME:-~/.config}/<app>/config.json` |
| data | `${XDG_DATA_HOME:-~/.local/share}/<app>/` |
| state (logs, cursors) | `${XDG_STATE_HOME:-~/.local/state}/<app>/` |
| cache | `${XDG_CACHE_HOME:-~/.cache}/<app>/` |

Commit `config.example.json` / `.env.example` with every key, its default and one
line of explanation; ignore `*.local.*` and `.env`. Keep variables orthogonal
(`APP_PORT`, `APP_DB`), not bundled into named environments.

For skills, the config is often **a list of names** (models, accounts, channels). Put
it in a JSON file the scripts read (`accounts.local.json` with
`accounts.example.json` as the fallback) and have the prose say "your fast model"
instead of naming one.

### 4. Port and adapter

When the code calls something only you have (your assistant, your phone pager,
your dashboard), define the smallest interface the code needs and ship a generic
default:

```python
class Notifier(Protocol):
    def notify(self, text: str, level: str = "info") -> None: ...

# shipped: StdoutNotifier (default), WebhookNotifier (POST to a URL from config), NullNotifier (tests)
# yours, in the overlay: a command adapter that runs `notify-cmd` from local config
```

For scripts, the cheapest port is a **command hook**: `--notify-cmd "<cmd>"` or
`NOTIFY_CMD`, with the message appended. You keep your tool, and strangers get
stdout. For agent instructions, the port is a sentence such as "if a `local.md` sits
next to this skill, read it first; it may name a notifier, a model list, a channel."

### 5. Rewrite instructions for strangers

Agent instructions (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`, prompts) collect history
over time. For each paragraph:

- **Rule, not story.** "Reviews run at high effort" instead of "since 11-04
  reviews run at high effort (Alex, after the plan 600 incident)". Keep the
  reason only when it changes behaviour: "…because low effort missed whole-file
  regressions."
- **No dates, plan numbers, trial windows or names** in the public text. If
  the decision still matters to you, it goes in `local.md`.
- **Prune** what any capable model already does ("write clean code", "use
  descriptive names"), vague rules, and rules about tools the repo no longer has.
- **Resolve contradictions**: when two paragraphs disagree, keep one.
- **Progressive disclosure**: the root file stays short (aim for under 50 lines for
  `AGENTS.md`/`CLAUDE.md`, and under about 300 for a `SKILL.md`) and links to
  `references/*.md` for detail. Move the deep content; don't delete it.
- **Say what's needed up front**: if the skill needs a particular tool, the first
  paragraph says so and says what happens without it.

## The private overlay

What you take out still has to work for you. Patterns, simplest first:

| Pattern | For | How |
|---|---|---|
| `local.md` next to a skill | personal preferences, your tool names, your defaults | git-ignored; the public SKILL.md says "read `local.md` first if it exists" |
| `*.local.json`, `.env` | values the scripts read | git-ignored, with a committed `*.example.*` fallback the code also reads |
| command hooks | notifier, uploader, your assistant | `--notify-cmd`, an env var, or a key in local config |
| private repo | whole personal skills or modules | a sibling repo; public skills mention it as optional ("works without it") |
| symlinks | personal skills that reuse public code | the private repo symlinks into the public one, never the other way |

Check at the end: delete or rename the overlay files temporarily and run the
public parts. They must still work (with defaults or a clear message). Put the
overlay back and check that your own setup works too.

## Done when

- The coupling report shows only intentional hits (credits, author line, examples)
  or files that are git-ignored.
- `rg -i '<your name>|<your machine>|<your tool>'` over the tracked files returns
  nothing surprising.
- Your daily setup works with the overlay, and the public parts work without it.
