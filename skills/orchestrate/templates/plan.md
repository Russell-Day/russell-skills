# Plan <N>: <title> (<date>)

Source: <adapter: an issue tracker | <path>/TODO.md | …>. Items read <date>.
<the user approved the grouping and order on <date> | grouping is the lead's guess, see questions.>

| Stage | Items | Files owned | Live replay | Model | Reviewer | Status |
|---|---|---|---|---|---|---|
| S1 <title> | `<id>` <short>, `<id>` <short> | <dirs/files> (<N> files, ≤10 not counting tests/fixtures/screenshots/docs) | <snapshot, when the stage changes how the live app answers \| —> | opus high (or `opus medium`; risky stages `opus high · risky: <concurrency\|schema/migration\|auth\|mail/messages\|deletes\|GPU\|secrets>`) | <per Review cadence: terra61 high, or opus high → terra61 high> | planned / dispatched (<thread>) / review / fix r1 / APPROVE / committed <sha> / ended <no-work\|dropped\|blocked\|failed\|merged>: <why> |
| S2 <title> | … | … | … | … | … | … |

Skipped or deferred: `<id>` <why>.

## Seams (L plans, written before S1)
- <id, data shape or API that crosses stages>: owner S<n>, used by S<m>; seam review once both land.

## Decisions the user gave
- `<id>`: "<their words>" → <what we do>

## Questions (scoped; recommendation first)
1. **Question:** … **Context:** … **What I found:** … **Recommendation:** …
   **Pros / cons:** … **Other options:** … — working guess until answered: <X>

## Review lessons
Filled on every REVISE (orchestrate §9); later stages' worker prompts and reviews carry it.
- <class> (S<n> F<id>): <the fix pattern>; elsewhere: <places | none>

## Resume
What a fresh thread on this plan reads first: state and the next step, not history. Keep it current before you stop.
- **Stages:** S1 committed <sha>; S2 review r1 (<thread>); S3 ended dropped: <why>; S4 planned.
- **Decisions:** <the ones above that change what the next stage does>
- **Next step:** <exact next action, e.g. "dispatch S3 with /tmp/<plan>/s3.md">
- **Open risks:** <what could go wrong, what to check first>

Each stage: worker leaves changes uncommitted and lists its files; <reviewer(s) per the
Review cadence> review; lead commits on APPROVE (<plain | private index with HEAD check>), one
stage per commit, then marks items done with the sha.

## Log
Dated history (dispatches, rounds, hand-offs); Resume keeps only state and the next step.

## Sources
Each doc, thread, meeting or issue the plan relies on: link and the date read.
For a project with TEDI sources, from `source_sweep(project, topic, people)`.
