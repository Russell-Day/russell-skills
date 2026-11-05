# structure.md: a layout a stranger can navigate

A newcomer spends ten times longer working out *where* things are than changing
them (matklad). Structure is about cutting that time: a layout people already
know, a README that works as a map, and one place that explains the architecture.

## Layout by repo type

**Agent skills** (agentskills.io spec, read by Claude Code, Codex, Gemini CLI,
Cursor and others):

```
repo/
├── README.md                 # the map
├── LICENSE
├── .claude-plugin/
│   └── marketplace.json      # optional: `/plugin marketplace add owner/repo`
└── skills/                   # or top-level dirs if there are only a few
    └── <skill-name>/         # dir name == frontmatter `name`, [a-z0-9-]
        ├── SKILL.md          # frontmatter + instructions, < ~300 lines
        ├── scripts/          # code the agent runs
        ├── references/       # detail loaded on demand
        └── assets/           # templates, schemas
```

- Frontmatter: `name` (matches the dir), `description` (≤ 1024 chars: what it does
  and when to use it, with trigger words), plus optional `license` and
  `compatibility` (required tools). Validate with `skills-ref validate` if it is
  installed.
- Group related skills under one plugin per audience if there are many.
  Keep experimental skills in `experimental/` or out of the repo.
- Third-party skills you vendor sit in their own folder with a `SOURCE.md` (repo,
  commit, licence, what you changed) and are listed separately in the README.

**Python app or library**: `src/<package>/`, `tests/`, `pyproject.toml`, and
`docs/` only if needed. The `src/` layout makes tests run against the installed
package, not whatever happens to be in your working dir.

**Node/TypeScript**: `src/`, `test/`, `package.json` with `bin` for CLIs, and `engines`
set to the lowest Node you test.

**Go**: `cmd/<binary>/` for thin entry points; logic in `internal/` (private) or
`pkg/` (meant for import).

**MCP server**: one package (`src/` + `pyproject.toml` with a console script, or
`package.json` with `bin`) so `uvx <pkg>` / `npx -y <pkg>` runs it. Add
`manifest.json` for an `.mcpb` bundle and `server.json` for the MCP registry.

Everywhere: runtime state (`data/`, `logs/`, `cache/`) is git-ignored and created on
first run.

## README as a map

In this order, short:

1. **One paragraph**: what it is and what problem it solves, for the target user.
2. **Requirements**: exact runtimes (`Python ≥ 3.10`, `Node ≥ 22`) and anything else
   that must already be installed.
3. **Install**: one command per audience, copy-pasteable, before any options.
4. **Verify it worked**: one prompt or command and what the user should see.
5. **Contents**: a table of skills, commands or modules, one line each.
6. **Configure**: only what someone might change, with defaults. Link to the
   example config.
7. **How it works / Architecture**: a link, or three sentences.
8. **License**, and credits for borrowed ideas or code.

Avoid badges walls, roadmaps and personal backstory. A short "Why" is fine.

## ARCHITECTURE.md (when there is real code)

Following matklad's pattern, keep only things that rarely change:

- **Bird's-eye view**: the problem and the data flow, inputs to outputs, in two or three paragraphs.
- **Entry points**: the files where execution starts and where requests come in.
- **Code map**: each directory and what it owns. Name files and types but don't link them (links rot); readers search by name.
- **Invariants**, especially *absences*: "the core never touches the network", "scripts never write outside the state dir".
- **Boundaries**: where the core meets adapters, and the contract between them.
- **Cross-cutting**: errors, logging, config, testing.

Revisit it a couple of times a year; don't try to keep it in sync with every change.

## Docs (only if the README overflows)

Use Diátaxis to keep the kinds apart: **tutorial** (first success, no options),
**how-to** (recipes for real tasks), **reference** (config keys, flags, env vars),
**explanation** (design and trade-offs). Most small repos need just the README plus
one reference page.

## Consistency pass

- Same section order in every SKILL.md / module README.
- Names say what things do (`publish-check`, not `pc2`); no internal nicknames.
- One term per concept across all files (don't use "worker" in one file and "child" in another).
- Every script has `--help` with a usage line and its exit codes.
- Delete empty dirs, stale TODO files and old plans.
