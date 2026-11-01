#!/usr/bin/env bash
# Offline tests for run.sh: AGY-out fallback to Haiku, the board notice and
# attempts.jsonl. Stub claude/agy CLIs and a stub board script on PATH, a temp
# HOME; nothing reaches a model, T3 or the real message board.
#
#   bash code/run.test.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
run_sh=$here/run.sh
fails=0 n=0

iso() { python3 -c 'import sys, datetime as d; print((d.datetime.now(d.timezone.utc) + d.timedelta(minutes=float(sys.argv[1]))).isoformat())' "$1"; }

setup() {
  HOME_=$(mktemp -d) bin=$HOME_/bin
  mkdir -p "$bin" "$HOME_/.local/state/agent-stats"
  jobs=$HOME_/jobs
  cat >"$bin/claude" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' "$@" >"$HOME/claude.args"
echo "haiku report"
EOF
  cat >"$bin/agy" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo called >>"$HOME/agy.calls"
if [[ ${AGY_MODE:-ok} == quota-stderr ]]; then  # the reset only on stderr
  echo "error: Individual quota reached. Resets in 10h5m0s." >&2
  echo '{"status":"ERROR","response":"","error":"Individual quota reached."}'
  exit 3
fi
if [[ ${AGY_MODE:-ok} == quota ]]; then
  echo "error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 10h5m0s." >&2
  echo '{"status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 10h5m0s."}'
  exit 3
fi
echo '{"status":"SUCCESS","response":"gemini report"}'
EOF
  cat >"$bin/board-ok" <<'EOF'
#!/usr/bin/env python3
import json, os, sys
open(os.path.join(os.environ["HOME"], "board.posts"), "a").write(json.dumps({"args": sys.argv[1:], "body": sys.stdin.read()}) + "\n")
EOF
  printf 'import sys\nsys.exit("board is down")\n' >"$bin/board-down"
  # Codex: a usage limit on $LIMIT_HOME, else the report via -o. CODEX_HOME per call to codex.homes.
  cat >"$bin/codex" <<'EOF2'
#!/usr/bin/env bash
echo "$CODEX_HOME" >>"$HOME/codex.homes"
[[ $CODEX_HOME == "${LIMIT_HOME:-}" ]] && { echo "ERROR: You've hit your usage limit." >&2; exit 1; }
while [[ $# -gt 0 ]]; do [[ $1 == -o ]] && { echo "codex report" >"$2"; shift; }; shift; done
EOF2
  # node: FAKE_PICKS=a,b answers usage.mjs --pick-codex (first name not in --exclude); else the real node.
  cat >"$bin/node" <<EOF2
#!/usr/bin/env bash
if [[ -n \${FAKE_PICKS:-} && " \$* " == *" --pick-codex "* ]]; then
  ex=","; prev=""; for a in "\$@"; do [[ \$prev == --exclude ]] && ex=",\$a,"; prev=\$a; done
  for n in \${FAKE_PICKS//,/ }; do [[ \$ex == *",\$n,"* ]] || { echo "\$n"; exit 0; }; done
  exit 1
fi
exec $(command -v node) "\$@"
EOF2
  chmod +x "$bin"/*
  echo "do the thing" >"$HOME_/prompt.md"
}

state() {  # $1 checkedAt offset (min), $2 usedPercent, $3 resetsAt offset (min)
  printf '{"checkedAt":"%s","windows":[{"label":"Session · Gemini Flash","usedPercent":10,"resetsAt":"%s"},{"label":"Weekly · Gemini Flash","usedPercent":%s,"resetsAt":"%s"}]}' \
    "$(iso "$1")" "$(iso 60)" "$2" "$(iso "$3")" >"$HOME_/.local/state/agent-stats/agy_state.json"
}

launch() { launch_as gemini-flash "$@"; }
launch_as() {  # $1 model label, $2 JOB, rest: extra env
  local model=$1 job=$2; shift 2
  env -i PATH="$bin:$PATH" HOME="$HOME_" AGENT_JOBS_DIR="$jobs" JOB="$job" TIMEOUT=60s \
    MESSAGE_BOARD_SCRIPT="$bin/board-ok" "$@" bash "$run_sh" "$model" "$HOME_/prompt.md" >/dev/null 2>"$HOME_/stderr"
}

check() {  # $1 description, rest: test command
  local what=$1; shift; n=$((n + 1))
  if "$@"; then echo "ok   $what"; else echo "FAIL $what"; fails=$((fails + 1)); fi
}
has() { grep -qF -- "$2" "$1" 2>/dev/null; }
lines() { [[ $(wc -l <"$1" 2>/dev/null || echo 0) -eq $2 ]]; }
# Every attempt's start and end parse, in order.
ordered() { python3 -c '
import json, sys, datetime as d
p = lambda t: d.datetime.fromisoformat(t.replace("Z", "+00:00"))
rows = [json.loads(l) for l in open(sys.argv[1])]
sys.exit(not rows or not all(p(r["start"]) <= p(r["end"]) for r in rows))' "$1" 2>/dev/null; }
# The account headless Claude runs on (CLAUDE_CONFIG_DIR) under the temp HOME.
claude_dir() { HOME=$HOME_ node "$here/accounts.mjs" claude-config-dir; }
jq_() { python3 -c 'import json, sys; rows = [json.loads(l) for l in open(sys.argv[1])]; print(eval(sys.argv[2]))' "$@"; }

# AGY weekly at 100% until a future reset: Haiku high runs instead, logged, one board notice.
setup; state -10 100 300
reset=$(S=$HOME_/.local/state/agent-stats/agy_state.json python3 -c 'import json, os, datetime as d; print(d.datetime.fromisoformat(json.load(open(os.environ["S"]))["windows"][1]["resetsAt"]).astimezone(d.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))')
launch out1; rc=$?
check "exhausted: exit 0" test $rc -eq 0
check "exhausted: agy never called" test ! -e "$HOME_/agy.calls"
check "exhausted: claude on haiku" has "$HOME_/claude.args" "claude-haiku-5-5"
check "exhausted: effort high" grep -qx high "$HOME_/claude.args"
check "exhausted: report from haiku" has "$jobs/out1/report.md" "haiku report"
check "exhausted: run.log fallback line" has "$jobs/out1/run.log" "fallback gemini-flash -> haiku (AGY out until $reset)"
check "exhausted: limits.log fallback line" has "$jobs/out1/limits.log" "fallback gemini-flash -> haiku (AGY out until $reset)"
check "exhausted: one board post" lines "$HOME_/board.posts" 1
check "exhausted: post is a limits broadcast from subagents-launcher" \
  test "$(jq_ "$HOME_/board.posts" 'rows[0]["args"][:5], "--to" in rows[0]["args"]')" = "(['post', '--agent', 'subagents-launcher', '--topic', 'limits'], False)"
check "exhausted: post body" test "$(jq_ "$HOME_/board.posts" 'rows[0]["body"].startswith("AGY/Gemini out until ") and rows[0]["body"].endswith("→ helpers on Haiku high")')" = True
check "exhausted: one attempt line" lines "$jobs/out1/attempts.jsonl" 1
check "exhausted: attempt fields" test "$(jq_ "$jobs/out1/attempts.jsonl" '[rows[0][k] for k in ("model_label", "model_id", "harness", "effort", "exit", "fallback_from")]')" \
  = "['haiku', 'claude-haiku-5-5', 'claude', 'high', 0, 'gemini-flash']"
check "exhausted: account is the Claude config dir" test "$(jq_ "$jobs/out1/attempts.jsonl" 'rows[0]["account"]')" = "$(claude_dir)"
check "exhausted: start/end parse, in order" ordered "$jobs/out1/attempts.jsonl"
sid=$(jq_ "$jobs/out1/attempts.jsonl" 'rows[0]["session_id"]')
check "exhausted: session id recorded and passed to claude" grep -qx -- "$sid" "$HOME_/claude.args"
check "exhausted: attempt keys" test "$(jq_ "$jobs/out1/attempts.jsonl" 'sorted(rows[0])')" \
  = "['account', 'cwd', 'effort', 'end', 'exit', 'fallback_from', 'harness', 'model_id', 'model_label', 'session_id', 'start', 'thread_id']"
check "exhausted: cwd is where the worker ran" test "$(jq_ "$jobs/out1/attempts.jsonl" 'rows[0]["cwd"]')" = "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# Same reset again: no second notice.
launch out2
check "same reset: still one board post" lines "$HOME_/board.posts" 1
check "same reset: still falls back" has "$jobs/out2/run.log" "fallback gemini-flash -> haiku"
# EFFORT override is kept on Haiku.
launch out3 EFFORT=medium
check "EFFORT=medium kept on haiku" grep -qx medium "$HOME_/claude.args"

# Reset already passed: Gemini runs.
setup; state -10 100 -5
launch rec; rc=$?
check "recovered: exit 0" test $rc -eq 0
check "recovered: agy called" test -e "$HOME_/agy.calls"
check "recovered: claude not called" test ! -e "$HOME_/claude.args"
check "recovered: gemini report" has "$jobs/rec/report.md" "gemini report"
check "recovered: no fallback line" bash -c "! grep -q fallback '$jobs/rec/run.log'"
check "recovered: attempt is gemini" test "$(jq_ "$jobs/rec/attempts.jsonl" '[r["model_label"] for r in rows]')" = "['gemini-flash']"

# Stale state (checked 3 h ago) says out: try Gemini anyway.
setup; state -180 100 300
launch stale
check "stale: agy called" test -e "$HOME_/agy.calls"
check "stale: gemini report" has "$jobs/stale/report.md" "gemini report"

# No state + AGY quota error: same job reruns on Haiku high, state written, notice posted.
setup
launch quota AGY_MODE=quota; rc=$?
check "quota error: exit 0" test $rc -eq 0
check "quota error: agy called once" lines "$HOME_/agy.calls" 1
check "quota error: haiku ran" has "$HOME_/claude.args" "claude-haiku-5-5"
check "quota error: report from haiku" has "$jobs/quota/report.md" "haiku report"
check "quota error: two attempts" test "$(jq_ "$jobs/quota/attempts.jsonl" '[(r["model_label"], r["exit"], r["fallback_from"]) for r in rows]')" \
  = "[('gemini-flash', 3, None), ('haiku', 0, 'gemini-flash')]"
check "quota error: accounts (agy none, then claude)" test "$(jq_ "$jobs/quota/attempts.jsonl" '[r["account"] for r in rows]')" = "[None, '$(claude_dir)']"
check "quota error: start/end parse, in order" ordered "$jobs/quota/attempts.jsonl"
check "quota error: state written ~10h05m out" python3 -c '
import json, sys, datetime as d
s = json.load(open(sys.argv[1])); w = [w for w in s["windows"] if w["usedPercent"] >= 100][0]
left = d.datetime.fromisoformat(w["resetsAt"].replace("Z", "+00:00")) - d.datetime.now(d.timezone.utc)
sys.exit(not (d.timedelta(hours=10) < left <= d.timedelta(hours=10, minutes=5)))' "$HOME_/.local/state/agent-stats/agy_state.json"
check "quota error: fallback logged" has "$jobs/quota/limits.log" "fallback gemini-flash -> haiku (AGY out until"
check "quota error: board notice" lines "$HOME_/board.posts" 1
# The next job reads that state and skips Gemini.
launch quota2 AGY_MODE=quota
check "after quota error: next job skips gemini" lines "$HOME_/agy.calls" 1
check "after quota error: no second notice" lines "$HOME_/board.posts" 1

# Board down: the job still runs on Haiku; the failure is logged; the next job tries again.
setup; state -10 100 300
launch down MESSAGE_BOARD_SCRIPT="$bin/board-down"; rc=$?
check "board down: exit 0" test $rc -eq 0
check "board down: haiku report" has "$jobs/down/report.md" "haiku report"
check "board down: failure logged" has "$jobs/down/run.log" "board notice failed: board is down"
check "board down: no marker" test ! -e "$HOME_/.local/state/agent-stats/agy_notice"

# AGY quota with the reset only on stderr: the reset is still cached.
setup
launch qstderr AGY_MODE=quota-stderr; rc=$?
check "stderr-only reset: exit 0" test $rc -eq 0
check "stderr-only reset: state written ~10h05m out" python3 -c '
import json, sys, datetime as d
s = json.load(open(sys.argv[1])); w = [w for w in s["windows"] if w["usedPercent"] >= 100][0]
left = d.datetime.fromisoformat(w["resetsAt"].replace("Z", "+00:00")) - d.datetime.now(d.timezone.utc)
sys.exit(not (d.timedelta(hours=10) < left <= d.timedelta(hours=10, minutes=5)))' "$HOME_/.local/state/agent-stats/agy_state.json"
check "stderr-only reset: board notice" lines "$HOME_/board.posts" 1

# ACCOUNT=auto Codex retry: the first account hits its limit, the second runs; each attempt records its account.
setup
read -r first second < <(cd "$here" && HOME=$HOME_ command node --input-type=module -e 'import { codexAccounts, codexDefault } from "./accounts.mjs"; console.log(codexDefault, codexAccounts.find((a) => a.name !== codexDefault).name)')
home_of() { HOME=$HOME_ command node "$here/accounts.mjs" codex-home "$1"; }
for a in "$first" "$second"; do mkdir -p "$(home_of "$a")"; echo '{"models":[{"slug":"gpt-6.1-sol"}]}' >"$(home_of "$a")/models_cache.json"; done
launch_as sol61 retry ACCOUNT=auto FAKE_PICKS="$first,$second" LIMIT_HOME="$(home_of "$first")"; rc=$?
check "codex retry: exit 0" test $rc -eq 0
check "codex retry: report from the second account" has "$jobs/retry/report.md" "codex report"
check "codex retry: CODEX_HOME per attempt" test "$(cat "$HOME_/codex.homes" | tr '\n' ' ')" = "$(home_of "$first") $(home_of "$second") "
check "codex retry: attempts record each account" test "$(jq_ "$jobs/retry/attempts.jsonl" '[(r["model_label"], r["model_id"], r["effort"], r["account"], r["exit"]) for r in rows]')" \
  = "[('sol61', 'gpt-6.1-sol', 'medium', '$first', 1), ('sol61', 'gpt-6.1-sol', 'medium', '$second', 0)]"
check "codex retry: start/end parse, in order" ordered "$jobs/retry/attempts.jsonl"

echo "$((n - fails))/$n passed"
[[ $fails -eq 0 ]]
