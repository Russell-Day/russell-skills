# setup.md: fewest dependencies, one command, a passed stranger test

Most people who try a repo give up at install. The goal is one copy-paste command,
a way to check it worked, and nothing that needs editing JSON by hand.

## 1. Cut dependencies

- **Stdlib first.** Python's `urllib.request`, `json`, `sqlite3`, `argparse`,
  `subprocess` and `pathlib` cover most helper scripts. Node 22 has `fetch`,
  `node:test`, `node:sqlite` (behind a flag in some versions) and `parseArgs`.
- **When a package is really needed (Python)**, use PEP 723 inline metadata, so
  `uv run script.py` makes the environment by itself:
  ```python
  # /// script
  # requires-python = ">=3.10"
  # dependencies = ["httpx>=0.27"]
  # ///
  ```
- **No global installs** in instructions (`pip install --user`, `npm i -g`). Use
  `uvx` / `npx -y` / `uv run` for one-off tools.
- **Optional tools are detected** (`command -v`) and named, with a link, when missing.
- **Shell**: POSIX `sh` or bash with `set -euo pipefail`. Note macOS differences
  (`sed -i ''`, `readlink -f`, `date`). Prefer Python for anything with parsing.
- **Windows**: say whether it is supported. If it isn't, say "Linux and macOS
  (Windows via WSL)" instead of leaving people to find out.

## 2. One install command

### Agent skills

| Audience | Command | Needs |
|---|---|---|
| any agent (auto-detects Claude Code, Codex, Cursor, Gemini CLI, …) | `npx skills add owner/repo` (add `-a claude-code` when run by an agent, `-g` for global) | Node ≥ 22 |
| Claude Code | `/plugin marketplace add owner/repo` then `/plugin install <plugin>@<marketplace>` | `.claude-plugin/marketplace.json` |
| manual | `git clone … && ./install.sh` (symlinks into `~/.agents/skills` and each harness's skills dir) | git |

`marketplace.json` (in `.claude-plugin/`):

```json
{
  "name": "my-skills",
  "owner": { "name": "Your Name", "url": "https://github.com/owner" },
  "plugins": [
    { "name": "my-skills", "description": "…", "source": "./", "strict": false,
      "skills": ["./skills/skill-a", "./skills/skill-b"] }
  ]
}
```

Skills that need config should still work with no config (from the example file) and
say how to personalise.

### MCP servers

From easiest for a non-technical user to most manual:

1. **`.mcpb` bundle** (Claude Desktop, double-click to install). `npx @anthropic-ai/mcpb init`
   then `mcpb pack`. Use `server.type: "node"` (Node ships with Claude Desktop) or
   `"uv"` (the app manages Python). Settings go in `user_config`, which Claude Desktop
   shows as a form (mark secrets `"sensitive": true`). Attach the `.mcpb` to each
   GitHub release.
2. **Remote server with OAuth** if it is hosted: users paste a URL and sign in.
   `claude mcp add --transport http name https://…/mcp`.
3. **One command** for agent CLIs:
   `claude mcp add name -- uvx my-mcp` or `claude mcp add name -- npx -y my-mcp`
   (`-e KEY=value` for settings, `--scope user` for all projects). Codex:
   `codex mcp add name -- uvx my-mcp`.
4. **Cursor deep link** button in the README: `cursor://anysphere.cursor-deeplink/mcp/install?name=<n>&config=<base64 json>`.
5. **Registry listing** so clients can find it: `mcp-publisher init` (writes
   `server.json`, name `io.github.<owner>/<name>`), `mcp-publisher login github`,
   `mcp-publisher publish`.

Publish the package to PyPI/npm so `uvx`/`npx` work. A git URL works too
(`uvx --from git+https://github.com/owner/repo my-mcp`), but it is slower and less
familiar.

### Verify it worked

Give one exact check right after install, for example: *"Start a new session and
ask: `check this repo for anything personal before I publish it` — the go-public
skill should start with a coupling report."* For CLIs: `my-tool --version`. For MCP:
"ask Claude: `what tools does <server> have?`"

### Troubleshooting

List the top three failures and their fixes: skill not found (wrong dir, restart
the session), command not found (runtime missing or too old), and an MCP server that
won't start (run the command by hand to see the error).

## 3. Stranger test

Run the README exactly as written somewhere that has none of your setup:

```bash
# a throwaway home: no dotfiles, no tokens, no overlay
export TMPHOME=$(mktemp -d) && env -i HOME=$TMPHOME PATH=/usr/bin:/bin:$HOME/.local/bin bash -l
# or a container with nothing mounted from your home
docker run --rm -it -v "$PWD":/src:ro -w /src python:3.12-slim bash
```

1. Clone from the public URL (or a `git clone --no-local` of the clean branch) and
   follow the README word for word. Note every step that needed knowledge the README
   doesn't give.
2. Run the test suite and one real use.
3. Unset everything the overlay provides and check that the defaults or the error
   messages make sense: no stack traces pointing at missing files under your home.
4. **Cold reader**: give a subagent only the README and the repo (no conversation
   context) and ask it to install and use the thing. Its questions are your gaps.

Fix and repeat until a run passes with no notes.
