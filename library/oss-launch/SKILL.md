---
name: oss-launch
description: Use when taking a repo open source, or hardening one that already is. Run /oss-launch and it walks the whole way to public. It first runs publish-check, which scans ALL git history, commit messages and author emails for secrets (gitleaks), personal details (the user's own list), home paths, private IPs, data dumps and risky workflows. Then it fixes what it finds in the files and cleans the history until the check says GO. It also scans the repo (stack, existing files, git remote), asks only what it cannot infer, then generates a tailored OSS file collection (README, LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG, .gitignore, .github/ issue + PR templates, CI/CD). Also covers launch (GitHub metadata, badges, Show HN, Reddit, YouTube), release cadence (SemVer + CHANGELOG), and demo-GIF generation. Triggers on "open source this", "OSS checklist", "prep for launch", "make this repo public", "add a license / contributing / security policy", "Show HN", "release workflow", "star growth", "get contributors".
---
# oss-launch

Take a repo all the way to public: prove nothing private ships (whole history, not
just today's files), fix what would leak, fill the open-source gaps with adapted (not
boilerplate) files, flip it public with the right settings, then optionally launch it.

The full walkthrough is steps 0-7 below. It is not done until `publish-check` says GO
and the user has said yes to the flip.

`templates/` holds the payload this skill writes into a USER's repo. The root files
(README, LICENSE, etc.) describe oss-launch itself. Never confuse the two.

## Run (when invoked)

Work top to bottom. Do not dump all files blindly; scan first, then fill only real gaps.

**0. Scan the repo** (details: `references/scan.md`)
- Stack: `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `composer.json` /
  `*.csproj` / `Gemfile` / `pom.xml` or `build.gradle` / `Package.swift` -> language,
  package manager, test/build/lint commands. Full marker table: `references/scan.md`.
- Existing OSS files present vs missing: README, LICENSE, CONTRIBUTING, CODE_OF_CONDUCT,
  SECURITY, CHANGELOG, `.gitignore`, `.github/` templates, CI workflows.
- Git: `git remote -v` -> `{{OWNER}}/{{REPO}}` + default branch. `gh repo view` -> public?
- Declared license (`package.json` "license" field / existing `LICENSE`).
- Demo asset present? (screenshot / gif in README or `docs/`).
- **Publish check** (every run, even for a repo that is already public): run
  `python3 scripts/publish-check.py .` (walkthrough: `references/publish-check.md`).
  It needs `gitleaks`; if missing, install it (single binary, verify the checksum) or
  stop: never fall back to a quick grep. It scans every commit on every branch, commit
  messages and author emails, plus the files that would be pushed now, for secrets,
  the user's personal list (`personal.local.txt`, git-ignored; create it from
  `personal.example.txt` on first use), home paths, private/Tailscale IPs, data dumps,
  big blobs, submodules and self-hosted-runner workflows.

**1. Report** the publish-check verdict (GO / NO-GO, each BLOCK and REVIEW) and a gap
table of open-source files. Triage every REVIEW with the user; intended hits go in
`.publish-check-ignore`. Run the audit for the checklist:
```bash
bash scripts/audit.sh .
```

**2. Ask only what cannot be inferred** (batch into one question round):
license (if undeclared), author / copyright holder + year, security contact,
project type (library / app / CLI / skill / service), are outside contributions wanted,
distribution target (npm / pypi / none), one-line tagline. Skip any the scan answered.

Then ask about the opt-in workflows, but **only the ones the scan made relevant**: a
question about a thing the repo cannot use is noise, not thoroughness:

| Ask | Only when |
|-----|-----------|
| Coverage upload to Codecov? | stack is node or python **and** a test runner was detected |
| release-please instead of tag-triggered releases? | always, but say it *replaces* `scripts/release.sh` rather than adding to it; both own the version number and CHANGELOG |
| Build + push a container image to GHCR? | `detect_docker` found a Dockerfile or compose file |
| Citable (paper/DOI)? Sponsorship links? | rarely; skip unless the project type suggests it |

All four default to no. Details + tradeoffs: `references/ci-cd.md`.

**3. Generate** the file collection from `templates/`, adapted (details: `references/generate.md`):
- Fill placeholders: `{{OWNER}} {{REPO}} {{AUTHOR}} {{YEAR}} {{LICENSE}}`
  `{{SECURITY_EMAIL}} {{CONTACT_EMAIL}} {{TAGLINE}} {{STACK}}` (full map: `references/generate.md`).
- Pick the stack-appropriate `.gitignore` (`templates/gitignore/`) and CI workflow
  (`templates/.github/workflows/`).
- LICENSE: `templates/LICENSE-apache.txt` (default) or `LICENSE-mit.txt`.
- `llms.txt` always (it indexes the project, not a site). Add `404.html`, `robots.txt`
  and `sitemap.xml` from `templates/site/` **only** when a static-site or docs framework
  is clearly present (`detect_site_framework` in `scripts/lib/detect-site.sh`). Set
  `{{SITE_URL}}` for a custom domain, and skip all three when unsure.
- **Never overwrite an existing non-trivial file without showing a diff and confirming.**
  Prefer to augment (e.g. add missing README sections) over clobbering.

**4. Fix what would leak**: edit the files, don't just report
(`references/publish-check.md` steps 3-4). Rotate real secrets first. Move machine
values into git-ignored `*.local.*` files with a committed example. Make paths
relative. Delete data dumps and add them to `.gitignore`. Fix risky workflows. Then
clean the history: a **fresh single-commit history in a new repo** (default for
personal repos) or a `git filter-repo` rewrite in a temp `--mirror` clone. Never
rewrite or force-push the shared working copy.

**5. Re-check until GO**: rerun `publish-check.py` on the repo that will actually go
public, and `scripts/audit.sh .`. Report what was created, updated, removed from
history, and what is still manual (demo GIF, real security email, topics). Loop 4-5
until the verdict is GO, or GO after review with every REVIEW decided.

**6. Flip and lock down** (only after an explicit yes, showing the final report):
`gh repo edit --visibility public --accept-visibility-change-consequences`, then
secret scanning + push protection, Dependabot alerts, read-only default workflow
token, approval for fork-PR workflows (`references/publish-check.md` step 6). Rerun
publish-check once more on the public repo.

**7. Offer launch modules on demand** (do not auto-run any of these):
| Module | Reference | Tool |
|--------|-----------|------|
| README anatomy (50-star vs 1000-star) | `references/readme-anatomy.md` | - |
| GitHub metadata: topics, description, badges, star-ask | `references/github-metadata.md` | `gh repo edit` |
| CI/CD baseline + when to add each workflow | `references/ci-cd.md` | `templates/.github/workflows/` |
| Release: SemVer + CHANGELOG + tag + GH release + npm/pypi | `references/release.md` | `scripts/release.sh` |
| Standard GitHub labels | - | `scripts/setup-labels.sh <owner/repo>` |
| Demo GIF / screenshot generation | `references/media.md`, `setup/MEDIA_SETUP.md` | `scripts/generate-media.sh`, `scripts/update-readme-with-gif.sh` |
| Launch playbook: Show HN, Reddit, YouTube, star growth | `references/launch-playbook.md` | `launch/*` |

## Rules
- Scan before you write. A gap table beats a wall of generated files.
- Adapt, do not paste. Every emitted file gets the repo's real name, owner, stack, license.
- Nothing goes public on a NO-GO. A leaked secret is rotated, not just deleted.
- History counts: a file or line deleted in an old commit is still public after the flip.
- Public push is irreversible and outward-facing: show the `gh repo create` / push command
  and the leak-scan result, and get explicit confirmation first.
- Apache-2.0 is the default license here; offer MIT when the user prefers minimal ceremony.

## Limitations

- **License choice is Apache-2.0 or MIT only.** No GPL/BSD/other license templates out of
  the box; the user's own choice of a different license needs a manual `LICENSE` swap.
- **README prose is agent-only.** The headless path (`scripts/apply.sh`) intentionally skips
  generating `README.md` - a template can't write an honest project pitch, so it leaves that
  file for a human or an agent session to do instead of emitting boilerplate.
- **Never pushes, rewrites a shared repo or flips visibility on its own.** History clean-up
  happens in a temp mirror or a new repo; the flip (step 6), tagging a release and posting a
  launch thread each need the user's explicit yes (`references/publish-check.md`,
  `references/release.md`, `references/launch-playbook.md`).
- **Stack coverage is templated, not exhaustive.** CI + `.gitignore` templates cover
  Node/Python/Rust/Go/PHP/.NET/Ruby/Java/Swift; an unlisted stack needs a manual template add
  (see `CONTRIBUTING.md`).
- **Doesn't audit code quality.** publish-check covers leaks (secrets, personal details,
  data, risky workflows), not vulnerabilities in the code itself.
- **Not a design tool.** `oss-launch` scaffolds governance files, not UI. If the repo being
  launched is a frontend/design project, pairing it with the
  [`components`](https://github.com/AnayDhawan/Components) skill's `TASTE.md` (layout
  curation + anti-slop taste standards, with a pointer table to compatible companion
  skills) gets better-than-generic output on the parts of the repo `oss-launch` doesn't
  touch. Optional, unrelated to this skill's own scope.

## Scripts
| Script | Purpose | Args |
|--------|---------|------|
| `publish-check.py` | Go/no-go leak check over all history + current files + GitHub settings; exit 1 on BLOCK | `[REPO] [--personal FILE] [--max-mb N] [--json OUT]` |
| `audit.sh` | Gap checklist with relative fix hints | `[REPO_PATH]` (default `.`) |
| `apply.sh` | Headless scaffold: no agent loop, config file instead of Q&A | `<target-dir> [--config <file>]` |
| `build-agent-dirs.sh` | Emit ready-to-copy skill dirs per harness (Claude, Codex, Cursor, Gemini, Windsurf, Aider) | `[output-dir]` (default `dist/`) |
| `release.sh` | SemVer bump + CHANGELOG + tag + GH release | `patch\|minor\|major\|x.y.z` |
| `setup-labels.sh` | Create standard OSS labels via `gh` | `[owner/repo]` |
| `generate-media.sh` | Playwright screenshots + ffmpeg GIF | `--storyboard YAML` or `--url URL` |
| `update-readme-with-gif.sh` | Insert GIF into README above Quick Start | `--readme`, `--gif` |

All scripts resolve their own root path, so they run from a clone or from the installed
skill location without edits. They all need shell/bash execution, so on Windows run them
from Git Bash or WSL; `cmd.exe` and PowerShell cannot execute them.
