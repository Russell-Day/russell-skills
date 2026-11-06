# publish-check.md: can this repo go public, and fixing it until it can

A public repo publishes **everything git has**: every commit on every branch and tag,
every commit message, every author email, and every file that was ever committed,
even if it was deleted later. Once it is public, forks, clones and caches can keep a
copy forever. So the check runs on the whole history, and the work is not done until
it says GO.

`scripts/publish-check.py` does the looking; this file is the walkthrough for fixing
what it finds. Run them in order. Steps 3 and 4 change files; nothing here pushes
or flips visibility without the user's explicit yes.

## 1. Run the check

```bash
python3 scripts/publish-check.py <repo>          # report + exit 1 on any BLOCK
python3 scripts/publish-check.py <repo> --json /tmp/pc.json
```

Small repos take seconds. A repo with thousands of commits and big data diffs can take
many minutes (gitleaks reads every diff), so run it in the background there. Files over
`--max-mb` (default 5) are skipped by gitleaks and listed for review instead.

Needs `git` and `gitleaks` (single binary from github.com/gitleaks/gitleaks/releases;
check the release checksum). A missing gitleaks is reported as a BLOCK, never skipped.

What it covers:

| Section | Looks at | Level |
|---|---|---|
| Secrets | gitleaks over **all history** (`--log-opts=--all`) and over the files that would be pushed now (tracked + untracked-not-ignored) | BLOCK |
| Personal info | the user's personal list (`personal.local.txt`: emails, phone, family names, address, machine/account names) plus home paths, private and Tailscale IPs, `.local`/`.lan` hosts, in current files, every added line in history, and commit messages | BLOCK |
| | any other email address, phone-number-looking strings | REVIEW |
| | commit author/committer identities (they ship with the history) | BLOCK if on the personal list, else REVIEW |
| Files | keys, `.env`, credentials JSON, `.npmrc`/`.netrc`, keystores, now or ever in history | BLOCK |
| | databases, logs, `.jsonl`, mail, `.har` dumps, now or in history; blobs over 5 MB anywhere in history; submodules; symlinks pointing outside the repo | REVIEW |
| GitHub | workflows on `self-hosted` runners (a fork PR could run code on that machine) | BLOCK |
| | `pull_request_target` workflows, Actions secrets, secret scanning / push protection off on a public repo | REVIEW |
| | issues, PRs, Actions runs (logs + artifacts), releases, wiki, Pages that go public with the flip | REVIEW |
| | `${{ github.event.*.title/body }}` and similar inside workflow steps (script injection) | REVIEW |
| | branches, tags or PR heads on the remote that were never fetched, so not scanned | BLOCK |
| Files | agent files (`CLAUDE.md`, `AGENTS.md`, `.claude/`, memory, transcripts) | REVIEW |
| | file or folder names that contain something on the personal list | BLOCK |
| Files | built binaries and archives (`.exe`, `.so`, `.jar`, `.whl`, `.zip`…) | REVIEW |

Before the first run on a machine, make sure the personal list exists:
`cp personal.example.txt personal.local.txt` (git-ignored) and fill it in. Without it
only the generic patterns run, and the report says so.

## 2. Triage with the user

Show the report grouped as it prints. For each REVIEW, decide together: intended
(e.g. a fake phone number in a design example, a test fixture log) or a leak. Intended
hits go in `.publish-check-ignore` at the repo root (or `.github/publish-check-ignore`, to keep the root clean), so the next run is quiet:

```
path:docs/examples/*          # skip these paths in the personal/email scans; data, binary
                              # and agent files here count as reviewed (keys still BLOCK)
allow:Your Name               # a match containing this literal is fine
```

Never allowlist a gitleaks secret this way. If one is a false positive, add its
fingerprint to `.gitleaksignore` (gitleaks prints it with `-v`), with a comment saying why.

### 2b. Read-through for what no pattern knows

Patterns only find what someone listed. Read the material a stranger would read with
fresh eyes: README and docs, comments, config, agent files (`CLAUDE.md`, `AGENTS.md`,
`.claude/`), fixtures and examples, and `git log --all --format='%h %s'` for commit
subjects. Do it even when the check found nothing. Look for: real people's names,
project codenames, private repo or service names, school/work/client details,
meeting or chat snippets, health, money or location details, notes like "ask X about
the server". For each, decide: public, synthetic, or private. List the private
strings with a placeholder for each (`PERSON_NAME`, `internal.example.com`). They feed
step 3, and step 4's `--replace-text` file if they are in history. Run it on the files,
not on a diff: a diff can't show that the rest of a file is clean. (Adapted from
daymade/claude-code-skills, github-sensitive-data-cleanup, AI semantic review.)

## 3. Fix the current files (edit them; do not just report)

Work through every BLOCK and every REVIEW judged a leak. Typical fixes:

- **A real secret** (API key, token, password): **rotate it first** at the provider
  (revoke and reissue). Deleting it from the repo does not un-leak a value that is
  in history or already pushed anywhere. Then read it from the environment or a
  git-ignored file instead.
- **Machine-specific values** (home paths, hostnames, IPs, account names, emails):
  move them into a git-ignored local file and commit an example beside it, e.g.
  `accounts.local.json` (ignored) + `accounts.example.json` (committed, fake values),
  and have the code read the local one. Replace absolute paths with paths relative to
  the repo, `~`, or an environment variable.
- **Personal details in docs or comments**: rewrite the sentence generically. Example IPs
  in docs use the documentation ranges (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`),
  example domains `example.com`.
- **Agent files** (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`, memory, transcripts):
  keep only what helps a stranger work on the repo; move personal workflow, machine
  names and accounts into git-ignored files, and add `.claude/` and `.codex/` to
  `.gitignore` unless they are meant to ship.
- **Workflow script injection**: never put `${{ github.event.issue.title }}` (or any
  title, body, branch name, commit message) straight into a `run:` line; pass it via
  `env:` and use `"$VAR"`.
- **Data files** (databases, logs, exports, recordings): delete them from the repo and
  add their pattern to `.gitignore`. Keep a small, fake fixture if tests need one.
- **Self-hosted runner workflows**: switch to `runs-on: ubuntu-latest`, or keep the
  workflow off the public repo. Remove the runner registration after the flip.
- **`pull_request_target`**: make sure it never checks out or runs the PR's code;
  otherwise use `pull_request`.
- **Submodules**: each must be public too, or vendor/remove it.
- **Big files**: drop them, move them to a release asset, or use Git LFS.
- **GitHub content that goes public with the repo**: old issues and PRs (with their
  comments and screenshots), Actions run logs and artifacts, releases and their assets,
  the wiki, a Pages site. `git filter-repo` can't touch any of these. Skim them; delete
  what is private (`gh issue delete`, `gh release delete`, and for all old runs
  `gh run list --limit 1000 --json databaseId -q '.[].databaseId' | xargs -n1 gh run delete`).
  Route A in step 4 (a new repo) leaves all of this behind automatically.
- **Third-party code and dependencies**: vendored code keeps its own LICENSE; check that
  no dependency's license conflicts with the chosen one (`pip-licenses`,
  `npx license-checker --summary`, `cargo deny check licenses`). Only for repos with
  real dependencies.

Commit these fixes like any other change. Then rerun step 1: current-file findings
should be gone; history findings remain until step 4.

## 4. Clean the history

Anything still reported as "in history" or "first at <commit>" will be public after
the flip. That includes branches and pull-request heads on GitHub: if the check says
some remote refs were never fetched, fetch them first
(`git fetch origin '+refs/*:refs/remote-all/*'`) and rerun. Pick one route with the user:

**A. Fresh history (simplest; the default for personal repos).** Publish the cleaned
tree as a new repo with one initial commit, and keep the private repo as the archive.

```bash
git clone <private-url> /tmp/pub && cd /tmp/pub
git checkout --orphan public && git add -A
git -c user.email=<noreply> commit -m "Initial public release"
gh repo create <owner>/<name> --private --source . --push   # private until step 6
```

Nothing old can leak and nothing gets force-pushed. Cost: the public repo loses the
commit history and contributor graph.

**B. Rewrite the history (keeps it).** Only in a fresh `--mirror` clone in a temp
directory, never in a working tree other sessions use.

```bash
git clone --mirror <private-url> /tmp/rewrite.git && cd /tmp/rewrite.git
git filter-repo --analyze        # sizes and paths over all history: .git/filter-repo/analysis/ (here: filter-repo/analysis/)
# replace strings everywhere (literal, or regex:/glob: prefixes); "==>" sets the replacement
printf '%s\n' 'you@school.edu==>REDACTED' 'regex:/home/[a-z]+/==>~/' > /tmp/replace.txt
git filter-repo --replace-text /tmp/replace.txt --replace-message /tmp/replace.txt
# drop files from every commit
git filter-repo --invert-paths --path data/contacts.json --path-glob '*.sqlite'
git filter-repo --strip-blobs-bigger-than 10M
# public commit identity (noreply: gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')
printf '%s\n' 'Name <ID+login@users.noreply.github.com> <old@email>' > /tmp/mailmap
git filter-repo --mailmap /tmp/mailmap
python3 scripts/publish-check.py /tmp/rewrite.git   # must say GO before anything is pushed
```

Every commit SHA changes, so every other clone (other machines, worktrees, CI caches)
must re-clone. Push the rewrite to a **new** repo (as in A) rather than force-pushing
over the old one: GitHub keeps old commits reachable through pull-request refs and
caches, and force-pushing a shared repo needs the owner's explicit OK.

For future commits, set the noreply email: `git config user.email <noreply>`, and turn
on GitHub's "Block command line pushes that expose my email" (Settings → Emails).

## 5. Re-check until GO

Rerun `publish-check.py` on the repo that will actually go public (the new repo or the
rewritten mirror), then `bash scripts/audit.sh .` for the open-source files. Repeat
3–4 until the verdict is `GO` (or `GO after review` with every REVIEW decided).
Show the final report to the user.

## 6. Flip and lock down (explicit yes required)

Going public cannot be taken back in practice: bots and archives (including Software
Heritage) clone public repos within minutes, and making it private again does not
recall forks or copies.
Show the final report and these commands, and run them only after the user says yes.

```bash
gh repo edit <owner>/<repo> --visibility public --accept-visibility-change-consequences
gh repo edit <owner>/<repo> --enable-secret-scanning
gh repo edit <owner>/<repo> --enable-secret-scanning-push-protection
gh api -X PUT repos/<owner>/<repo>/vulnerability-alerts            # Dependabot alerts
gh api -X PUT repos/<owner>/<repo>/private-vulnerability-reporting # private security reports
gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

Then, in Settings → Actions → General, require approval for workflows from outside
contributors (fork pull requests).

Guard the default branch the solo-safe way: block deleting and force-pushing it, but
require no reviews, so the owner can still push and merge their own work (adapted from
kajisho5/github-solo-skill):

```bash
gh api -X POST repos/<owner>/<repo>/rulesets --input - <<'JSON'
{"name": "guard default branch", "target": "branch", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
 "rules": [{"type": "deletion"}, {"type": "non_fast_forward"}]}
JSON
```

Add required reviews only once other people send pull requests.

Finally rerun `publish-check.py`: on a public repo it also confirms secret scanning and
push protection are on. Then set up the watcher and automation (phase 6, `maintain.md`).
