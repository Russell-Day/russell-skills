# Accounts and capacity (this machine)

Copy to `accounts.local.md` (git-ignored) and describe your own accounts. The
subagents skill tells agents to read it before choosing a pool. Account names,
homes and T3 profiles for the scripts go in `accounts.local.json`.

| Pool | Realistic capacity (API-list $) | Accounts (config home) |
|---|---|---|
| **AGY** | e.g. weekly estimate | default T3 account |
| **Claude** (plan) | per 5 h session; weekly cap if any | `CLAUDE_CONFIG_DIR=~/.claude` |
| **Codex** (plan) | per week | `main`: `~/.codex` |

Notes agents should know: which account has which models, which account is
the reserve, any account to use first, and which plans cost you money.

**Claude T3 profiles.** Orchestrators use `claudeAgent`; workers use the same
profile, or a second one with a smaller auto-compact window. Name the T3
profile Haiku runs on here too, if it has its own.
