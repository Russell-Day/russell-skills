---
name: takeover
description: Take over existing work and finish its original goal while keeping the original contributors' credit. Use when the user asks to take over a PR, branch or agent thread, or asks for a takeover.
---

# Takeover

You now own finishing the original goal, and the original contributors keep
their credit. Don't defend an implementation just because another agent
already built it. Read `local.md` next to this file first if it exists.

## 1. Read the source

- Read the source PR, branch or thread in full: the review findings and the
  user's later corrections too. For a T3 thread, use `t3_thread_read`. For a
  PR, `gh pr view <n> --comments` and `gh pr diff <n>`.
- Pin the handoff to the actual code and the current head (`git log`,
  `gh pr view --json headRefOid`). Check for uncommitted work in the source
  checkout or worktree.
- Treat the handoff as context, not proof. A thread saying "done, tests pass"
  is a claim you still have to check.

## 2. Pick the shape

- **Replacement PR (default):** make a new branch off the intended base,
  bring in the original commits (`git cherry-pick` or a rebase that keeps
  them as they are), then add your fixes as separate commits on top.
- **In-place or stacked continuation:** use this only when the user asks for
  it explicitly.
- Never overwrite unrelated work, and never change the original PR (push to
  its branch, edit its description, close it) without permission.

## 3. Keep the credit

- Keep Git authorship and any existing `Co-Authored-By:` trailers. Cherry-pick
  and rebase keep the author. Don't squash other people's commits into yours.
- The PR description credits the original contributors and links the
  original PR when there is one.
- If the work will be squashed, carry the human authors and co-authors into
  the merge commit as `Co-Authored-By:` trailers. Use verified identities
  from `git log --format='%an <%ae>'` or the PR's commits, never guessed
  emails.
- Model attribution doesn't replace contributor credit. Keep both.

## 4. Update and finish

- Bring the continuation up to date with its intended base and the current
  architecture. Rebase onto the latest base, then fix code that has gone
  stale against APIs, files or patterns that changed since it was written.
- Rework only what you need to finish the same goal. Don't take on unrelated
  features.
- Simplify where you can, without dropping any intended behaviour or surface.
- Before you file, check the source PR or thread again: it may have moved on
  while you worked. Fold in any new commits or comments.

## 5. Verify for real

- Reproduce the original failure yourself, then confirm it's gone. Follow
  the repo's guidance and permissions (its AGENTS.md or CLAUDE.md, test
  rules, what needs a go-ahead).
- Run the realistic workflows, not only unit tests. Green mocked tests don't
  prove the user experience works.
- Say what you couldn't verify, and why.

## 6. File and see it through

When the finish includes a PR:

- Write a short, plain description: why, what changed, what ran, what's
  still open, and the credit from step 3.
- Don't stop at creating the PR. Watch it until checks and reviews settle
  (T3: `watch_pull_request`) and fix what they turn up.
- Keep replies to review comments short and direct: what you changed, or
  why you didn't.
- Merge or close the original PR only with permission.

## Report

End with:

- **Inherited:** the source, its head, and its state when you took it over.
- **Changed:** your commits, and why each one was needed.
- **Verified:** what you ran and saw, plus what stays unverified.
- **Credit:** how authorship and co-authors were kept, and the link to the
  original PR.
- **Open:** any decision still left to the user.
