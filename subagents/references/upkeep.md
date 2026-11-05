# Thread upkeep timers

Three optional systemd user timers keep T3's sidebar and memory tidy when
many workers run. Unit files are in `../systemd/`. Each script takes
`--dry-run`.

**Old worker threads are archived.** `prune-workers.timer` runs
`code/prune-workers.mjs` daily at 04:30: every worker thread (`[<model>] <job>`, or a `TITLE` one its job dir recorded) settled
more than 5 days ago, with no activity since, is archived, so the sidebar keeps the
orchestrators. Archived threads keep their transcripts (unarchive in T3), and job
reports stay in the job directory. `--dry-run` lists them, `--days N` changes the
age, and `--delete` deletes instead. Main threads are never touched.
`--settle [--min N]` settles finished delegate_task children (and the
provider subagent threads under them) once they've been stopped for N min,
and `[<model>] <job>` worker threads that a late report from their own helper
re-opened after the job ended (once no helper of theirs still runs). T3
never settles them itself. `settle-workers.timer` runs it with `--min 0` every
minute, so a finished worker leaves Working at once. It keeps a
worker whose Claude transcript shows background work with no completion notice
yet (`kept … background work pending` in the journal), the same check the
reaper makes, and a Codex worker whose rollout shows an open turn, tool call
or spawned agent; other providers' live sessions are kept until T3
releases them. Install: `cp ~/.agents/skills/subagents/systemd/settle-workers.{service,timer} ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now settle-workers.timer`.

**Finished threads' Claude and Codex sessions are closed.** T3 keeps a thread's `claude`
process (~250 MB plus its MCP servers) for 30 min after its last activity, and
up to 4 h when a finished worker left background work. `reap-sessions.timer`
runs `code/reap-sessions.mjs` every 5 min: a live Claude session whose thread
is settled, archived, snoozed, or a `thread:delegated-task:…` child whose task
ended, with no live or queued run and 5 min without activity, gets T3's
`provider-session.detach`. The process exits; the thread keeps its native
session, so its next message resumes it (`claude --resume`) with its whole
conversation. Open threads keep T3's 30 min. A session whose Claude transcript
shows a background Bash command or Monitor with no completion notice yet is
kept (`kept … background work pending` in the log), since only its live process
can deliver that notice and wake the agent. Codex threads are reaped the same
way: a Codex account runs one shared session (one `codex app-server`)
for all its threads, so each finished thread is detached from it on its own
(T3 unloads just that thread; the shared process stays), judged by its own
activity, and kept while its rollout shows an open turn, tool call or spawned
agent. Each detach, keep or failure is a line
in `~/.local/state/agent-stats/reap-sessions.log`, and a failure fails the
unit. `--dry-run` lists, `--json` prints the result, `--idle-min N` changes the
wait. Install: `cp ~/.agents/skills/subagents/systemd/reap-sessions.{service,timer} ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now reap-sessions.timer`.
