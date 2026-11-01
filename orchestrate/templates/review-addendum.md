Expectations check (append to the filled-in subagents review-prompt.md):

For each item in the stage, the worker's packet has a block
"Item <id> / Input/trigger / Expected output / Checked by". Confirm that:
1. every item has one, and the expectation matches the user's words for the item;
2. the named test exists and asserts that expectation, not merely "no error";
3. the test would fail without the change (revert the key line yourself in
   /tmp/<verify-dir> and rerun, when cheap; the copy runs the
   repo's interpreter by absolute path, never a symlinked or copied venv, and
   never uv or pip);
4. anything marked "manual step" really cannot be a test.
A missing, mismatched or tautological expectation is a REVISE finding, not
Optional. Propose the extra test in one line when one is obvious.

Background jobs (tests, scratch runs): wait on them, never poll: run in the
foreground, `wait $!`, or `tail --pid=<pid> -f <log>`. Don't re-tail or `ls`
/tmp logs in a loop.
