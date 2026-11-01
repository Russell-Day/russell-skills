RECHECK ONLY. Same boundary as the prior review: do not edit, stash, reset, or checkout.
Project hard rules: <same as the review prompt>.
Do your own searching, reading, test runs and probes. Do not start subagents, helpers or other reviewers.

Prior packet: <~/.local/state/agent-jobs/<job>/report.md>.
If this thread took over from an older one (its first line says so), read the prior packet in full first: it is all you have of the earlier review.
Closed since then: <finding -> fix, with line refs>.
Scope: only <changed files>.

Check that each open finding is really fixed, and look for regressions in the
touched code. Do not re-review the whole stage. Rerun: <exact commands>.
Final message: per-finding status, any new regression, then
"VERDICT: APPROVE" or "VERDICT: REVISE". REVISE only for issues users would plausibly hit in daily use; theoretical or hardening-only items go under "Optional".
