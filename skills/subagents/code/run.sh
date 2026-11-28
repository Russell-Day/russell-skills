#!/usr/bin/env bash
# Launch one delegated worker/reviewer through the right CLI harness.
#
#   code/run.sh <model> <prompt-file>
#
# <model>: sol | sol62 | terra61 | luna | astra | fable | opus | sonnet | haiku | gemini-flash
# Env overrides:
#   EFFORT=<level>      reasoning level (default: the model's preferred level)
#   ACCOUNT=<name>      Codex account name from accounts.local.json (default: its codex.default) | auto
#                       auto = the one whose weekly limit resets soonest (usage.mjs --pick-codex)
#   JOB=<name>          job directory name (default: <timestamp>-<model>)
#   CWD=<dir>           working directory for the worker (default: git root of $PWD, else $PWD)
#   TIMEOUT=<duration>  hard limit passed to timeout(1); a bare number is minutes (default: 45m)
#   KILL_AFTER=<dur>    SIGKILL this long after timeout's SIGTERM (default: 30s)
#
#   AGENT_JOBS_DIR=<dir> where job directories go (default: ~/.local/state/agent-jobs)
#
# Writes $AGENT_JOBS_DIR/<JOB>/{prompt.md,report.md,run.log,attempts.jsonl,exit_code,
# lead_thread (inside a T3 Code thread)}
# and prints that directory. Exit code 0 is not acceptance: read report.md.
set -euo pipefail
# A headless run is not a T3 thread: don't hand it the caller's session ids, or
# tools that find "my thread" from them would act on the caller's thread instead.
unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID CODEX_SESSION_ID

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ $# -eq 2 ]] || usage
model=$1 prompt_src=$2
[[ -f $prompt_src ]] || { echo "prompt file not found: $prompt_src" >&2; exit 2; }

# The worker runs in the caller's project, not in this skill's directory.
cwd=${CWD:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
# A bare TIMEOUT number is minutes, as in t3-thread.mjs (timeout(1) alone would read seconds).
[[ -n ${TIMEOUT:-} ]] && TIMEOUT=${TIMEOUT//[[:space:]]/}
[[ ${TIMEOUT:-} =~ ^[0-9]+$ ]] && TIMEOUT=${TIMEOUT}m
timeout_=${TIMEOUT:-45m}
kill_after=${KILL_AFTER:-30s}

# Label -> harness, exact model ID, preferred reasoning level.
case $model in
  sol)          harness=codex  id=gpt-6-sol          effort=${EFFORT:-medium} ;;
  sol62|sol61)  harness=codex  id=gpt-6.2-sol        effort=${EFFORT:-high} ;;
  terra61)      harness=codex  id=gpt-6.1-terra      effort=${EFFORT:-high} ;;
  luna)         harness=codex  id=gpt-6-luna         effort=${EFFORT:-xhigh} ;;
  astra)        harness=codex  id=gpt-6-astra        effort=${EFFORT:-low} ;;   # EFFORT=medium for final checks
  fable)        harness=claude id=claude-fable-5-2   effort=${EFFORT:-medium} ;;
  opus)         harness=claude id=claude-opus-5-5    effort=${EFFORT:-high} ;;
  sonnet)       harness=claude id=claude-sonnet-5-5  effort=${EFFORT:-high} ;;
  haiku)        harness=claude id=claude-haiku-5-5   effort=${EFFORT:-high} ;;
  gemini-flash) harness=agy    effort=${EFFORT:-high}
                id=gemini-3.8-flash-$effort ;;   # AGY encodes the level in the slug
  *) echo "unknown model: $model" >&2; usage ;;
esac
# A review runs at least high on every model unless EFFORT says otherwise, with
# t3-thread.mjs's one role rule (nameRole): a JOB name with a review/recheck token is a review's
# (-review, -recheck1, -fix-review); with no fix/impl/work/build token, so is a final (-final,
# -final2, -final-sol-r2) or a name ending in a reviewer (-terra, -sol, -codex, an -rN after). A fix
# or impl name (-final-fix-r2, -impl-r1) never is; a council name says neither, and then the brief
# decides (REVIEW ONLY. / RECHECK ONLY.). Fable's own medium (any default below high) is ordinary work.
name_role() {  # prints review, work or nothing
  local name=${1##*/} t last="" prev="" review="" work="" final="" IFS='-_'
  local -a toks=()
  name=${name,,}
  read -ra toks <<< "$name" || true
  for t in "${toks[@]}"; do
    [[ -n $t ]] || continue
    [[ $t == council* ]] && return 0
    [[ $t =~ ^(x?review|rev|orev|recheck)[0-9]*[a-z]?$ ]] && review=1
    [[ $t =~ ^(fix|impl|work|build)[a-z0-9]*$ ]] && work=1
    [[ $t =~ ^final[0-9]*$ ]] && final=1
    prev=$last last=$t
  done
  if [[ -n $review ]]; then echo review; return 0; fi
  if [[ -n $work ]]; then echo work; return 0; fi
  [[ $last =~ ^r[0-9]+[a-z]?$ ]] && last=$prev
  if [[ -n $final || $last =~ ^(terra|sol|codex)[0-9]*[a-z]?$ ]]; then echo review; fi
  return 0
}
review_launch() {
  local text role
  role=$(name_role "${JOB:-}")
  [[ $role == review ]] && return 0
  [[ $role == work ]] && return 1
  text=$(head -c 4096 -- "$prompt_src") text=${text#"${text%%[![:space:]]*}"}
  [[ $text == "REVIEW ONLY."* || $text == "RECHECK ONLY."* || $text == "FINAL REVIEW ONLY."* ]]
}
launch_effort() {  # $1: the model's own default; EFFORT, when set, is already in it
  if [[ -z ${EFFORT:-} && $1 =~ ^(minimal|low|medium)$ ]] && review_launch; then echo high; else echo "$1"; fi
}
effort=$(launch_effort "$effort")
label=$model fallback_from=""

jobs_root=${AGENT_JOBS_DIR:-$HOME/.local/state/agent-jobs}
job=$jobs_root/${JOB:-$(date +%Y%m%d-%H%M%S)-$model}
# One run per brief file: a caller that sees `setsid … &` print Done and relaunches would run the
# brief twice. The lock is per real path and held by this run.sh until it exits; the harness
# doesn't inherit it (agy can leave a hub daemon running). A refused run (exit 75) makes no job
# dir. To run a brief twice on purpose, copy it.
brief_real=$(realpath -e -- "$prompt_src")
mkdir -p "$jobs_root/.brief-locks"
brief_lock=$jobs_root/.brief-locks/$(printf '%s' "$brief_real" | sha256sum | cut -c1-16).lock
exec 8<>"$brief_lock"
if ! flock -n 8; then
  holder=$(head -n1 "$brief_lock" 2>/dev/null) || holder=""
  echo "run.sh: $prompt_src is already running: ${holder:-holder unknown} (end that run first, or copy the brief to run it twice)" >&2
  exit 75
fi
printf 'pid=%s job=%s model=%s brief=%s started=%s\n' "$$" "$job" "$model" "$brief_real" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$brief_lock"
# A keeper holds the lock too, until run.sh and every harness it started are gone: a run.sh
# killed by SIGKILL mid-attempt doesn't free the brief while its harness still runs. Each
# harness's timeout(1) is started with BRIEF_LOCK_TAG=$brief_tag in its environment and starts
# its child with the tag unset, so exactly that process carries it, from its exec on; a daemon
# the harness leaves behind doesn't. Once run.sh is gone (or a zombie), the keeper holds the
# lock while any process carries the tag, and lets go after two empty looks 0.2 s apart (a fork
# about to exec a harness is never missed). run.sh ends it on exit.
brief_tag="$brief_lock:$$"
keep_brief_lock() {
  local parent=$1 s
  while s=$(cat "/proc/$parent/stat" 2>/dev/null) && s=${s##*) } && [[ ${s%% *} != Z ]]; do
    sleep "${BRIEF_KEEPER_SECS:-1}" 8>&-   # a sleep left over when the keeper is killed holds nothing
  done
  while tagged || { sleep 0.2 8>&-; tagged; }; do
    sleep "${BRIEF_KEEPER_SECS:-1}" 8>&-
  done
}
tagged() { grep -qsxzF -- "BRIEF_LOCK_TAG=$brief_tag" /proc/[0-9]*/environ; }
keep_brief_lock "$$" </dev/null >/dev/null 2>&1 &
brief_keeper=$!
trap 'kill "$brief_keeper" 2>/dev/null || true' EXIT
mkdir -p "$job"
# The T3 thread that started this helper ("<thread id> <pid> <start time>"), so a sidebar can
# show that thread as waiting on it while this run.sh lives. Removed first, so a reused job dir
# never keeps an old one.
rm -f "$job/lead_thread"
if [[ -n ${T3CODE_THREAD_ID:-} ]]; then
  stat_=$(cat "/proc/$$/stat") stat_=${stat_##*) }
  read -ra stat_ <<<"$stat_"
  echo "$T3CODE_THREAD_ID $$ ${stat_[19]}" >"$job/lead_thread"
fi
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
  env CODEX_HOME="$home" BRIEF_LOCK_TAG="$brief_tag" timeout --kill-after="$kill_after" "$timeout_" env -u BRIEF_LOCK_TAG codex exec --yolo --skip-git-repo-check \
    -C "$cwd" -m "$id" -c "model_reasoning_effort=\"$effort\"" -c daybreak=false -o "$report" \
    "$(cat "$job/prompt.md")" </dev/null >>"$log" 2>&1 8>&-
}

run_claude() {
  config_dir=$(node "$accounts" claude-config-dir) || return 2  # attempts.jsonl records it
  (cd "$cwd" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$config_dir" \
    CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000 \
    BRIEF_LOCK_TAG="$brief_tag" timeout --kill-after="$kill_after" "$timeout_" env -u BRIEF_LOCK_TAG claude -p --model "$id" --effort "$effort" \
    --dangerously-skip-permissions --output-format text --session-id "$session_id" \
    <"$job/prompt.md" >"$report" 2>>"$log" 8>&-)
}

run_agy() {
  # AGY's cwd does not contain its file tools; --add-dir admits the worker's tree.
  (cd "$cwd" && env BRIEF_LOCK_TAG="$brief_tag" timeout --kill-after="$kill_after" "$timeout_" env -u BRIEF_LOCK_TAG agy --input-format text --output-format json \
    --model "$id" --effort "$effort" --mode accept-edits \
    --dangerously-skip-permissions --add-dir "$cwd" --print-timeout 0 \
    <"$job/prompt.md" >"$job/result.json" 2>>"$log" 8>&-)
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
  elif [[ $id == claude-fable-* ]]; then
    fallback_from=$label label=opus id=claude-opus-5-5; echo "falling back to $id" >&2
  else
    break
  fi
done

echo "$rc" >"$job/exit_code"
echo "$job"
[[ $rc -eq 0 ]] || { echo "exit $rc — see $log" >&2; exit "$rc"; }
