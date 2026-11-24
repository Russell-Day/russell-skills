REVIEW ONLY. Do not edit, stash, reset, checkout, start servers, or make live calls.
Project hard rules: <copy them from AGENTS.md / CLAUDE.md, e.g. "never call the local model host">.
Run tests and linters freely; anything that mutates state runs in a scratch copy under /tmp.
Do your own searching, reading, test runs and probes. Do not start subagents, helpers or other reviewers.

Stage: <id/title>. Read <plan sections>.
Scope: <exact files, incl. untracked>. Ignore other dirty WIP: <list>.
Claims: <what the implementer says it did, with line refs>.
Review lessons: <the plan's `## Review lessons` lines (orchestrate §9) | none>. Probe each one
against this stage's files; a place the stage missed is a finding under that lesson's class.

Adversarial probes (name the classes; most real REVISEs are one of these):
1. Lifecycle races: <restart, concurrent run, cancel mid-write, duplicate delivery>.
2. Tokenizer/parse edges: <empty, unicode, punctuation, casing, very long input>.
3. <stage-specific probe>.

Proportion: <project> is <who uses it and how, e.g. "one person's single-user personal tool, not a
multi-tenant product">. Rate every finding by what it would actually cost its users in daily use.
REVISE only for defects they would plausibly hit: wrong answers, lost or corrupted data, broken
flows, real secret leaks. List theoretical or hardening-only issues (a path no UI or caller
reaches, a hostile input nobody would type, defence-in-depth) under "Optional", and don't let
them block APPROVE.
Always REVISE for: <the project's never-ship classes, e.g. a secret leak, a duplicate
consequential effect such as a second email, unrecoverable data loss>.

Sweep each finding. Before you write up a blocker or should, search the stage's whole scope for
every other place with the same cause: other call sites, branches and files the stage touches,
other wordings or spellings of the same input, and the tests that should cover each. List them
all under that one finding, so one fix round closes them all (one more sibling per recheck burns
the round budget). A same-cause place outside the stage's files goes in the packet's
`Elsewhere:` list, not in a finding.

Run: <exact test / bench / lint commands>.

Write the FULL packet to your final message (it is saved as the report), not a
summary: findings with stable ids (`F1 [blocker|should|nit] location / trigger / smallest fix`),
under each blocker and should a `sites:` line (every same-cause place from the sweep) and a
`class:` line (the cause in a few plain words; `class: one-off` when nothing else could share
it), evidence, commands run with results, `Elsewhere: <same-cause places outside the stage | none>`,
and a last line of exactly "VERDICT: APPROVE" or "VERDICT: REVISE".
