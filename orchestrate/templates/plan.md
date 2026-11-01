# Plan <N>: <title> (<date>)

Source: <adapter: an issue tracker | <path>/TODO.md | …>. Items read <date>.
<the user approved the grouping and order on <date> | grouping is the lead's guess, see questions.>

| Stage | Items | Files owned | Live replay | Model | Reviewer | Status |
|---|---|---|---|---|---|---|
| S1 <title> | `<id>` <short>, `<id>` <short> | <dirs/files> | <snapshot, when the stage changes how the live app answers \| —> | opus med | sol61 high | planned / dispatched (<thread>) / review / fix r1 / APPROVE / committed <sha> |
| S2 <title> | … | … | … | … | … | … |

Skipped or deferred: `<id>` <why>.

## Decisions the user gave
- `<id>`: "<their words>" → <what we do>

## Questions (scoped; recommendation first)
1. **Question:** … **Context:** … **What I found:** … **Recommendation:** …
   **Pros / cons:** … **Other options:** … — working guess until answered: <X>

## Resume
What a thread woken by the pacer reads first. Update it before `enqueue` and `pause`.
- **Stages:** S1 committed <sha>; S2 review r1 (<thread>); S3 planned.
- **Decisions:** <the ones above that change what the next stage does>
- **Next step:** <exact next action, e.g. "dispatch S3 with /tmp/<plan>/s3.md">
- **Open risks:** <what could go wrong, what to check first>

Each stage: worker leaves changes uncommitted and lists its files; one <reviewer>
review; lead commits on APPROVE (<plain | private index with HEAD check>), one
stage per commit, then marks items done with the sha.
