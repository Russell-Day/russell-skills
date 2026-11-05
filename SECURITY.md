# Security

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/Russell-Day/russell-skills/security/advisories/new),
not in a public issue. I'll reply within 14 days. This is a one-person project:
fixes land on `main`, with no backports.

Worth knowing before you run these skills: the dispatch scripts start agents with
full permissions (`--dangerously-skip-permissions`, Codex `--yolo`) so workers can
run unattended. Run them only in repos and on machines where you accept that.
