#!/usr/bin/env bash
# Example: review two disjoint stages at once, then show each verdict.
#   code/parallel-review.sh stage-a.md stage-b.md
set -euo pipefail
here=$(dirname "$0")
pids=()
for p in "$@"; do
  JOB=review-$(basename "$p" .md)-$(date +%H%M%S) "$here/run.sh" astra "$p" &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid" || true; done
for p in "$@"; do
  d=$(ls -dt "${AGENT_JOBS_DIR:-$HOME/.local/state/agent-jobs}"/review-"$(basename "$p" .md)"-* | head -1)
  echo "== $d (exit $(cat "$d/exit_code"))"
  grep -E '^VERDICT:' "$d/report.md" || echo "no VERDICT line — read $d/report.md and $d/run.log"
done
