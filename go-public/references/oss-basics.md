# oss-basics.md: the minimal open-source files

Add only what the repo needs. A solo repo is complete with a LICENSE, a README, a
SECURITY.md and issue forms. Add CONTRIBUTING only if you want contributions, and a
Code of Conduct only if you expect a community. For a full kit, `library/oss-launch`
has templates per stack.

## LICENSE

Default **MIT** (short, permissive, what most skills and tools use). **Apache-2.0**
adds a patent grant and suits company use or anything with real patent risk. For
vendored code, keep each upstream licence next to the code and list it in the
README. `gh repo create --license mit` or copy from choosealicense.com, and put
the year and your public name in it.

## SECURITY.md

```markdown
# Security

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/OWNER/REPO/security/advisories/new),
not in a public issue. I'll reply within 14 days. This is a one-person project, so
fixes land in the next release; there is no backport policy.
```

Turn the reporting on when you flip the repo (publish-check.md step 6).

## Issue forms

`.github/ISSUE_TEMPLATE/config.yml`:

```yaml
blank_issues_enabled: false
contact_links:
  - name: Security problem
    url: https://github.com/OWNER/REPO/security/advisories/new
    about: Report privately, not in a public issue.
  - name: Question or idea
    url: https://github.com/OWNER/REPO/discussions
    about: Ask here (needs Discussions on), or remove this link.
```

`.github/ISSUE_TEMPLATE/bug.yml`:

```yaml
name: Bug
description: Something doesn't work as the README says
labels: ["bug"]
body:
  - type: textarea
    id: what
    attributes:
      label: What happened, and what did you expect?
    validations: { required: true }
  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      placeholder: "1. Ran `...`\n2. Saw `...`"
    validations: { required: true }
  - type: input
    id: env
    attributes:
      label: Versions
      placeholder: "OS, agent tool + version, Python/Node version, this repo's commit"
    validations: { required: true }
  - type: textarea
    id: logs
    attributes:
      label: Output or logs
      render: shell
```

Add `feature.yml` only if you want feature requests. Otherwise point ideas to
Discussions or say in SUPPORT.md that the scope is fixed.

## SUPPORT.md (if issues are on)

```markdown
# Support

This is a one-person project, maintained in spare time.

- **Bugs**: open an issue with the form; a reproduction gets looked at first.
- **Questions**: Discussions (or the README's troubleshooting section).
- **Response time**: usually within two weeks; issues are reviewed in a weekly batch.
- **Scope**: the project stays small on purpose. Features that serve one setup
  are better as a fork or a separate skill, and that's fine.
```

## CONTRIBUTING.md (only if you want contributions)

Keep it to: how to run the tests, the commit style (Conventional Commits if you
use release-please), "open an issue before a big PR", and the licence of
contributions (inbound = outbound). Skip the CLA.

## .gitignore

Make sure it covers the overlay and runtime state: `*.local.*`, `local.md` (if
skills use it), `.env`, `data/`, `logs/`, `*.sqlite*`, `node_modules/`, `.venv/`,
`__pycache__/`.

## Not needed on day one

CODE_OF_CONDUCT (until people gather), CHANGELOG (release-please writes it),
FUNDING.yml, badges, a docs site, PR templates, CODEOWNERS (solo).
