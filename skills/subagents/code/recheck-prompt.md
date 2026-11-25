RECHECK ONLY. Same boundary as the prior review: do not edit, stash, reset, or checkout.
Project hard rules: <same as the review prompt>.
Never run a package install (npm, pnpm, yarn or bun install, add, ci or update) in a scratch copy whose node_modules links to the main tree's: the install writes through the link and rewires the main tree. Never link a node_modules by hand. A copy that needs its own deps deletes the link (only the link) and installs offline from the lockfile (`pnpm install --frozen-lockfile --offline`, `npm ci --offline`); otherwise run those tests read-only in the main tree.
Do your own searching, reading, test runs and probes. Do not start subagents, helpers or other reviewers.

Prior packet: <~/.local/state/agent-jobs/<job>/report.md>.
If this thread took over from an older one (its first line says so), read the prior packet in full first: it is all you have of the earlier review.
Closed since then: <finding -> fix, with line refs>.
Scope: only <changed files>.

Check that each open finding is really fixed, and look for regressions in the
touched code. Do not re-review the whole stage. A finding is resolved only when every place on
its `sites:` line is fixed. For each one, sweep the changed files once for its `class:` and list
every place still open under that same id in this pass (not one per recheck, not as a new id).
Rerun: <exact commands>.
Final message: per-finding status, any new regression; under every still-open or new
blocker and should its `sites:` and `class:` lines (as in the review packet), then
`Elsewhere: <places outside the stage, with their F id | none>`, then
"VERDICT: APPROVE" or "VERDICT: REVISE". REVISE only for issues users would plausibly hit in daily use; theoretical or hardening-only items go under "Optional".
