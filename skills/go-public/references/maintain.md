# maintain.md: hear about what matters, automate the rest

Solo maintenance works when robots do the chores, a filter decides what reaches you,
and you spend one short batch a week on the rest. It fails when every notification
is a phone buzz, or when nothing reaches you at all.

## 1. The watcher (local, on a timer)

`scripts/gh-watch.py` makes one poll of the GitHub notifications API per run:

```bash
python3 scripts/gh-watch.py --repos owner/repo-a,owner/repo-b --notify-cmd "notify-send GitHub"
python3 scripts/gh-watch.py --digest     # weekly: print + clear everything that wasn't urgent
```

- **Now** (sent to `--notify-cmd`): mentions, review requests, assignments,
  security alerts, and new issues, PRs or discussions opened by a person.
- **Digest**: comments on threads you already know about, CI, releases, and
  Dependabot/release-please PRs.
- Cheap: it sends the saved ETag (an unchanged inbox costs no rate limit) and
  respects `X-Poll-Interval`. State lives in `$XDG_STATE_HOME/go-public/gh-watch.json`.
  The first run puts the whole backlog in the digest. It never marks anything read.
- Token: `GH_TOKEN`, or the `gh` login (`gh auth login`; the default scopes are
  enough for notifications).

Schedule it, for example with a systemd user timer:

```ini
# ~/.config/systemd/user/gh-watch.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 %h/path/to/go-public/scripts/gh-watch.py --repos owner/repo --notify-cmd "notify-send GitHub"

# ~/.config/systemd/user/gh-watch.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
```

`systemctl --user enable --now gh-watch.timer`. Alternatives: cron
(`*/10 * * * *`), launchd on macOS, or your assistant's scheduler. Use the same
pattern for the weekly `--digest`, piped to mail, a chat channel, or a file.

The notify command gets the message as its last argument, and `{key}` in the
command becomes a stable id per item (useful for notifiers that de-duplicate).
If the command fails, the item goes to the digest rather than being lost.

## 2. GitHub automation (runs in the cloud)

### Dependabot, weekly and grouped

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "pip"        # or npm, cargo, gomod, ...
    directory: "/"
    schedule: { interval: "weekly" }
    open-pull-requests-limit: 5
    groups:
      minor-and-patch:
        update-types: ["minor", "patch"]
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule: { interval: "monthly" }
```

Auto-merge minor and patch updates once CI passes
(`gh repo edit --enable-auto-merge` once, and branch protection must require the CI check):

```yaml
# .github/workflows/dependabot-auto-merge.yml
name: dependabot auto-merge
on: pull_request
permissions: { contents: write, pull-requests: write }
jobs:
  merge:
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - id: meta
        uses: dependabot/fetch-metadata@v3
      - if: steps.meta.outputs.update-type != 'version-update:semver-major'
        run: gh pr merge --auto --squash "$PR"
        env: { PR: "${{ github.event.pull_request.html_url }}", GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```

A pure-markdown skills repo has no dependencies; there, only the
`github-actions` entry is needed, and only if you have workflows.

### Releases (optional)

If people install by version (PyPI, npm, `.mcpb` downloads), use
`googleapis/release-please-action@v4` on pushes to the default branch with
Conventional Commits. It keeps a release PR open with the changelog, and merging it
tags and releases. Skills repos installed from `main` can skip releases.

### Stale, but only for missing information

```yaml
# .github/workflows/stale.yml
on: { schedule: [{ cron: "0 4 * * 1" }], workflow_dispatch: {} }
permissions: { issues: write }
jobs:
  stale:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/stale@v10
        with:
          any-of-labels: needs-more-info
          days-before-issue-stale: 14
          days-before-issue-close: 7
          days-before-pr-stale: -1
          days-before-pr-close: -1
          stale-issue-message: "No reply for two weeks; this closes in a week unless there's more info."
```

Never auto-close real bugs or PRs.

### Optional AI triage

`anthropics/claude-code-action` (or GitHub Agentic Workflows) can label new issues,
ask for missing reproduction steps, or draft a fix PR when you comment `@claude`.
Run it only on `issues: opened` and on comments from you, and give it read-only
permissions plus `issues: write`. Never let text from strangers run with write
access to code.

## 3. Keep the public and private layers apart

You keep developing in the public repo, and personal details creep back in. Guard
the push:

```bash
# .git/hooks/pre-push (not committed; or core.hooksPath to a private hooks dir)
#!/bin/sh
exec python3 /path/to/go-public/scripts/publish-check.py "$(git rev-parse --show-toplevel)" --no-history-text >/dev/null \
  || { echo "publish-check says NO-GO; run it to see why" >&2; exit 1; }
```

`--no-history-text` keeps it fast on big repos (gitleaks still scans history). Run
the full check monthly. GitHub push protection catches secrets on the server side,
but not personal details, so the hook is what catches those.

When a new personal need appears, it goes into the overlay (`local.md`,
`*.local.json`, an adapter in the private repo), never into the public code with an
`if user == me`.

## 4. Routine

- **Daily**: nothing. The watcher interrupts you only for a mention, a new
  human issue/PR or a security alert.
- **Weekly (30 minutes)**: read the digest. Triage new issues: reproducible → `bug`;
  missing info → saved reply + `needs-more-info`; out of scope → saved reply and
  close. Merge or close PRs. Check that Dependabot merges went green.
- **Monthly**: run the full `publish-check.py`, look at the security tab, bump
  runtime versions, and remove anything you've stopped using.

### Saying no

"No is temporary, yes is forever": everything you merge, you maintain. Close
out-of-scope requests quickly and kindly. Leaving them open out of guilt costs
more than closing them.

Saved replies (github.com/settings/replies):

- **Out of scope**: "Thanks for this! It's outside what this project tries to do. I'm keeping it small so one person can maintain it. A fork or a separate skill is a great home for it."
- **Needs a reproduction**: "Thanks for the report. Could you add the exact steps, the versions (OS, agent tool, this repo's commit) and the full output? I'll take another look then."
- **Closing for no reply**: "Closing since there's been no reply. If it still happens on the latest version, comment with the details and I'll reopen."
- **First contribution merged**: "Merged, thank you! It's in `main` now."

### Changing what's public

- Semantic versioning once people pin versions: breaking a tool's parameters or a
  skill's name means a major version.
- Deprecate before removing: keep the old name working for at least one minor release,
  with a one-line warning saying what replaces it.
- Agent-facing schemas change **additively**: new parameters are optional with
  defaults, and unknown extra fields are ignored rather than rejected.
