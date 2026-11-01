---
name: dev-projects
description: Work on code projects that live in OneDrive without syncing venvs or node_modules. `dev open <project>` copies OneDrive\PROJECTS\<project> to C:\dev\<project>, installs deps, and rclone two-way syncs it every 2 minutes minus .venv/node_modules/caches; `dev close` syncs, verifies and deletes the local copy. Use when opening, setting up, running or installing dependencies for any project under OneDrive, or setting up a new computer.
---

# dev-projects

This machine's exact paths are under "dev-projects" in the repo's
`accounts.local.md` (`~/.agents/skills/dev-projects/../accounts.local.md`);
below, `<OneDrive>` is the OneDrive folder, `%USERPROFILE%\OneDrive`.

Full runbook (canonical, synced to every computer):
`<OneDrive>\PROJECTS\_dev\README.md`
(WSL: `/mnt/c/Users/<you>/OneDrive/PROJECTS/_dev/README.md`). Read it before acting.

Why: a personal OneDrive account has no working folder-exclusion setting
(GPO policy, junctions, ClientPolicy.ini lists all fail when tested),
so dependency folders must never be created inside OneDrive.

Rules for agents:
- Never run `uv sync`, `uv venv`, `pip install`, `npm install` (or `uv run`
  without `UV_PROJECT_ENVIRONMENT` set outside OneDrive) inside a folder under
  OneDrive. Run `dev open <project>` and work in `C:\dev\<project>`
  (`/mnt/c/dev/<project>` from WSL).
- From WSL, call the tool as
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<OneDrive>\PROJECTS\_dev\dev.ps1' <command> [project]`.
- `dev status` shows open projects and sync errors; fix errors with the
  README's troubleshooting list.
- `dev close` deletes the C:\dev copy after a verified sync; ask the user
  before closing a project they are using.
