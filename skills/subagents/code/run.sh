#!/usr/bin/env bash
# Launch one delegated worker/reviewer through the right CLI harness.
#
#   code/run.sh <model> <prompt-file>
#
# <model>: sol | sol61 | terra61 | luna | astra | fable | opus | sonnet | haiku | gemini-flash
# Env overrides:
#   EFFORT=<level>      reasoning level (default: the model's preferred level)
#   ACCOUNT=<name>      Codex account name from accounts.local.json (default: its codex.default) | auto
#                       auto = the one whose weekly limit resets soonest (usage.mjs --pick-codex)
#   JOB=<name>          job directory name (default: <timestamp>-<model>)
#   CWD=<dir>           working directory for the worker (default: git root of $PWD, else $PWD)
#   TIMEOUT=<duration>  hard limit passed to timeout(1) (default: 45m)
#   KILL_AFTER=<dur>    SIGKILL this long after timeout's SIGTERM (default: 30s)
#
#   AGENT_JOBS_DIR=<dir> where job directories go (default: ~/.local/state/agent-jobs)
#
# Writes $AGENT_JOBS_DIR/<JOB>/{prompt.md,report.md,run.log,attempts.jsonl,exit_code}
# and prints that directory. Exit code 0 is not acceptance: read report.md.
set -euo pipefail
# A headless run is not a T3 thread: don't hand it the caller's session ids, or
# continuity.mjs would resolve them to the caller's thread (a reviewer settled its orchestrator).
unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID CODEX_SESSION_ID

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ $# -eq 2 ]] || usage
model=$1 prompt_src=$2
[[ -f $prompt_src ]] || { echo "prompt file not found: $prompt_src" >&2; exit 2; }

# The worker runs in the caller's project, not in this skill's directory.
cwd=${CWD:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
timeout_=${TIMEOUT:-45m}
kill_after=${KILL_AFTER:-30s}

# Label -> harness, exact model ID, preferred reasoning level.
case $model in
  sol)          harness=codex  id=gpt-6-sol          effort=${EFFORT:-medium} ;;
  sol61)        harness=codex  id=gpt-6.1-sol        effort=${EFFORT:-high} ;;
  terra61)      harness=codex  id=gpt-6.1-terra      effort=${EFFORT:-high} ;;
  luna)         harness=codex  id=gpt-6-luna         effort=${EFFORT:-xhigh} ;;
  astra)        harness=codex  id=gpt-6-astra        effort=${EFFORT:-low} ;;   # EFFORT=medium for final checks
  fable)        harness=claude id=claude-fable-5-1   effort=${EFFORT:-medium} ;;
  opus)         harness=claude id=claude-opus-5-5    effort=${EFFORT:-high} ;;
  sonnet)       harness=claude id=claude-sonnet-5-5  effort=${EFFORT:-high} ;;
  haiku)        harness=claude id=claude-haiku-5-5   effort=${EFFORT:-high} ;;
  gemini-flash) harness=agy    effort=${EFFORT:-high}
                id=gemini-3.8-flash-$effort ;;   # AGY encodes the level in the slug
  *) echo "unknown model: $model" >&2; usage ;;
esac
label=$model fallback_from=""

job=${AGENT_JOBS_DIR:-$HOME/.local/state/agent-jobs}/${JOB:-$(date +%Y%m%d-%H%M%S)-$model}
mkdir -p "$job"
cp "$prompt_src" "$job/prompt.md"
printf '\n\n' >>"$job/prompt.md"
cat "$(dirname "$0")/worker-communication.md" >>"$job/prompt.md"
report=$job/report.md log=$job/run.log

# AGY out (agy-state.mjs): gemini-flash runs on Haiku high instead (EFFORT still
# wins), and says so in run.log and limits.log. The first switch per AGY reset
# posts one `limits` notice to the message board; a failed post is only logged.
agy_state=$(dirname "$0")/agy-state.mjs
to_haiku() {  # $1: the AGY reset (ISO) or "unknown"
  fallback_from=$label label=haiku harness=claude id=claude-haiku-5-5 effort=${EFFORT:-high}
  echo "fallback gemini-flash -> haiku (AGY out until $1)" | tee -a "$job/limits.log" "$log" >&2
  [[ $1 == unknown ]] || node "$agy_state" notice "$1" 2>&1 | tee -a "$log" >&2 || true
}
if [[ $harness == agy ]]; then
  agy_until=$(node "$agy_state" check 2>/dev/null) || agy_until=""
  [[ -z $agy_until ]] || to_haiku "$agy_until"
fi
# Account names, homes and the Claude config dir come from accounts.local.json.
accounts=$(dirname "$0")/accounts.mjs

# A limit hit shows up as a nonzero exit with one of these in the output.
limit_re='usage limit|hit your (usage )?limit|usage_limit_reached|rate.?limit (reached|exceeded)|quota (exceeded|exhausted)|RESOURCE_EXHAUSTED|Individual quota reached'
# run.log keeps every attempt; only this attempt's part counts.
hit_limit() { [[ $rc -ne 0 ]] && grep -qiE "$limit_re" <(tail -c +$((log_off + 1)) "$log" 2>/dev/null) "$report" 2>/dev/null; }

# One JSON line per attempt in attempts.jsonl, so a reused job dir keeps its history.
record_attempt() {
  python3 - "$start" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$id" "$harness" "$1" "$effort" "$rc" "$fallback_from" "$session_id" "$cwd" \
    >>"$job/attempts.jsonl" <<'PY2' || true
import json, sys
keys = ["start", "end", "model_label", "model_id", "harness", "account", "effort", "exit", "fallback_from", "session_id", "cwd"]
row = {k: v or None for k, v in zip(keys, sys.argv[1:])}
row["exit"] = int(row["exit"] or 0)
row["thread_id"] = None
print(json.dumps(row))
PY2
}

run_codex() {
  home=$(node "$accounts" codex-home "$account") || exit 2
  # Fail fast if this account's catalog lacks the model.
  python3 - "$home/models_cache.json" "$id" <<'PY2' || exit 3
import json, sys
data = json.load(open(sys.argv[1]))
models = data.get("models", data) if isinstance(data, dict) else data
if sys.argv[2] not in {m.get("slug") for m in models}:
    sys.exit(f"{sys.argv[2]} is not in {sys.argv[1]}; try another ACCOUNT")
PY2
  # `daybreak = true` in a config.toml (set for Daybreak pen-test runs) makes other
  # models fail at once with "Daybreak is unavailable for model ..."; turn it off here.
  # Prompt as an argument from the file (no quoting hazards); </dev/null or a
  # backgrounded Codex waits on stdin until the timeout.
  env CODEX_HOME="$home" timeout --kill-after="$kill_after" "$timeout_" codex exec --yolo --skip-git-repo-check \
    -C "$cwd" -m "$id" -c "model_reasoning_effort=\"$effort\"" -c daybreak=false -o "$report" \
    "$(cat "$job/prompt.md")" </dev/null >>"$log" 2>&1
}

run_claude() {
  config_dir=$(node "$accounts" claude-config-dir) || return 2  # attempts.jsonl records it
  (cd "$cwd" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$config_dir" \
    CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000 \
    timeout --kill-after="$kill_after" "$timeout_" claude -p --model "$id" --effort "$effort" \
    --dangerously-skip-permissions --output-format text --session-id "$session_id" \
    <"$job/prompt.md" >"$report" 2>>"$log")
}

run_agy() {
  # AGY's cwd does not contain its file tools; --add-dir admits the worker's tree.
  (cd "$cwd" && timeout --kill-after="$kill_after" "$timeout_" agy --input-format text --output-format json \
    --model "$id" --effort "$effort" --mode accept-edits \
    --dangerously-skip-permissions --add-dir "$cwd" --print-timeout 0 \
    <"$job/prompt.md" >"$job/result.json" 2>>"$log")
  local status=$?
  # status SUCCESS only means a response exists; the text goes to report.md.
  python3 - "$job/result.json" "$report" <<'PY2' || true
import json, sys
raw = open(sys.argv[1]).read().strip()
try:
    doc = json.loads(raw)
    text = doc.get("response") or doc.get("result") or doc.get("error") or raw
except json.JSONDecodeError:
    text = raw
open(sys.argv[2], "w").write(text if isinstance(text, str) else json.dumps(text, indent=2))
PY2
  return $status
}

# Limit go-around: Codex moves to the next account (auto mode only), Fable falls
# back to Opus (separate weekly bucket on the same Claude account), and an AGY
# quota error reruns the prompt on Haiku high and records the reset in the AGY
# state, so the next jobs skip Gemini. A retry starts the prompt over; an
# editing worker's partial changes stay in the tree.
account=${ACCOUNT:-$(node "$accounts" codex-default)} tried=""
[[ $harness == codex && $account == auto ]] && auto=1 || auto=0
for attempt in 1 2 3; do
  if [[ $harness == codex && $auto == 1 ]]; then
    account=$(node "$(dirname "$0")/usage.mjs" --pick-codex "$id" --exclude "$tried" 2>/dev/null) || {
      [[ -z $tried ]] && account=$(node "$accounts" codex-fallback) || { echo "every Codex account is at its limit" >&2; break; }
    }
  fi
  [[ $harness == codex ]] && echo "codex account: $account" >&2
  log_off=0; [[ -f $log ]] && log_off=$(wc -c <"$log")
  session_id=""; [[ $harness == claude ]] && session_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
  start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  set +e; "run_$harness"; rc=$?; set -e
  case $harness in codex) record_attempt "$account" ;; claude) record_attempt "${config_dir:-}" ;; *) record_attempt "" ;; esac
  if [[ $harness == agy && $rc -ne 0 ]] && { [[ $rc -eq 3 ]] || hit_limit; }; then
    echo "limit reached on $id (attempt $attempt)" | tee -a "$job/limits.log" >&2
    # This attempt's slice of run.log too: a reset printed only to stderr still counts.
    agy_until=$(node "$agy_state" record-error "$report" "$job/result.json" <(tail -c +$((log_off + 1)) "$log") 2>/dev/null) || agy_until=""
    to_haiku "${agy_until:-unknown}"
    continue
  fi
  hit_limit || break
  echo "limit reached on $([[ $harness == codex ]] && echo "$account" || echo "$id") (attempt $attempt)" | tee -a "$job/limits.log" >&2
  if [[ $harness == codex && $auto == 1 ]]; then
    tried=${tried:+$tried,}$account
  elif [[ $id == claude-fable-5-1 ]]; then
    fallback_from=$label label=opus id=claude-opus-5-5; echo "falling back to $id" >&2
  else
    break
  fi
done

echo "$rc" >"$job/exit_code"
echo "$job"
[[ $rc -eq 0 ]] || { echo "exit $rc — see $log" >&2; exit "$rc"; }
