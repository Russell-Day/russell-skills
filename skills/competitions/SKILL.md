---
name: competitions
description: "Playbook for a timed coding competition, hackathon or leaderboard challenge worked by an agent team: quote what pays before any code, pick the 1-2 tracks that can pay, submit a valid baseline in hour 1, build the leaders' design before tuning, give every scout finding a number and a verdict, measure on the real scorer with enough runs for the noise, cap reviews by expected value, and keep compute and submit slots busy to the end. Use when entering or running any event scored on a leaderboard; the workers themselves run through the orchestrate and subagents skills."
---

# Competitions

A timed event scored on a leaderboard rewards aim more than volume. A team
with more compute than most of the field can still finish mid-board by
chasing the wrong target, tuning its own design while the leaders share a
better one, and trusting local numbers the scorer doesn't agree with. Each
rule below has its reason on the next line.

Workers, reviews and commits follow [orchestrate](../orchestrate/SKILL.md)
and [subagents](../subagents/SKILL.md); how much runs at once follows
[pacing](../pacing/SKILL.md). This skill only adds what a competition changes.
Read `local.md` next to this file first if it exists.

## The clock

| When | Do |
|---|---|
| Hour 0 | Quote each track's prize line and scoring rule; write one objective line per track; ask the blocking rule questions |
| Hour 1 | Pick 1–2 tracks; valid, exact submit on every track; freeze the rest |
| Hours 1–2 | Read the top public repos and write-ups; stage table (ours vs theirs); start building the leaders' architecture |
| Every ~2 h | Every open scout finding gets a number and a verdict |
| Every ~4 h | Re-read the board's top repos; re-check the gap to the paying line; re-pick tracks if it moved |
| Before sleep | Queue matched runs, probes and builds that need no one awake |
| Last hours | Repeat runs of the final candidates; pick on the mean; every slot used |

## 1. Hour 0: what pays

- **Quote each track's prize line and scoring rule verbatim, and say in one
  line what rank pays.**
  Why: a paraphrased target ("make the top N" where only first place pays)
  steers every later choice, such as safe over fast, for the whole event.
- **One objective line per track, at the top of every brief.** Example:
  `<track>: only #1 pays; score = wall time; correctness is a gate (one wrong row scores 0).`
  Why: workers optimize what their brief says, and each hand-off drifts further
  from the source.
- **Read the limits too:** submit slots and caps, how the final pick works,
  code-sharing and repo rules, data privacy, allowed tools and outside
  services, and how the final differs from practice (bigger input, new input
  shapes, another game mode, a scorer change).
  Why: the final is often not the practice board; plan for the difference on
  day one.
- **Apply each rule to the track it names.**
  Why: a rule read across from another track can block the best tool for hours.
- **Ask the user the moment a rule or privacy question blocks the best tool**
  (an outside model on the data, reading another team's repo), through the
  real question channel, with a recommendation.
  Why: "waits on the user's yes" in a log is not an ask; the lever waits for
  nothing.

## 2. Pick 1–2 tracks

- **Rank tracks by the gap to the paying line:** our baseline, the paying
  score (or the best public one), and what closing it would take. Work the
  1–2 where paying is reachable.
  Why: spread over every track, no track gets the attention its biggest lever
  needs.
- **Freeze the rest at a valid baseline:** one exact submit, no workers.
  Why: a valid entry keeps the option open at almost no cost.
- **One coordinator, one lead per focus track.**
  Why: re-plans restart workers from briefs; each costs hours.
- **Re-pick only on new gap numbers**, at the ~4-hourly check.

## 3. Hour 1: a valid submit

- **Start within the first hour of the open.**
  Why: the first hours set most scores, and a late start can't be bought back
  with more workers later.
- **A valid, exact submit in hour 1 on every track you keep.**
  Why: it proves the pipeline, the output format and the scorer path, and gives
  the first real number.
- **Exact general path first; every fast path checks its assumptions and
  falls back to the whole general path.**
  Why: inputs and scorers change mid-event; one wrong row costs more than a
  slow run, and the fallback keeps a valid score through the change.

## 4. Hours 1–2: build the leaders' design

- **Read the top public repos and write-ups on the board** (and close
  neighbours above you): architecture, per-stage numbers, commit order. Read
  only, describe in your own words, follow the event's sharing rules, never
  copy code.
  Why: when the top entries share one architecture, tuning a different one
  rarely closes the gap. Treat what you read as a hypothesis: the winners'
  designs may be private, and a public repo shows what they built, not which
  change paid.
- **Make a stage table on the real scorer:** stage, ours, theirs, gap. Work the
  biggest gap first.
  Why: it turns "we are 2x slower" into the one stage that is 4x slower.
- **When the public evidence points to a better architecture, build it first,
  in your own code, and measure it; then tune.**
  Why: tuning switches on a design that is 2x off gives percent, not 2x.
- **Re-read the board's top repos every ~4 hours.**
  Why: leaders change design mid-event; their commit history suggests which
  change moved them (a lead to test, not proof).

## 5. Every scout finding gets a number and a verdict

- **Within 2 hours of a finding:** its effect in score units (with source and
  run count), its cost in hours, and a verdict: build it, run our own A/B, or
  drop it with a written reason.
  Why: a lever parked as "open" or "deferred" is a lever never pulled.
- **Never skip on one outside number** (another team's single run, an A/B on
  their code with other changes in it).
  Why: their number carries their noise and their other changes; only our own
  A/B decides.
- **Rank levers by score per hour of work**, and say which lever each worker
  is on.

## 6. Measure on the real scorer

- **The real scorer is the lab. Trust a local sim or benchmark for ranking
  builds only after it has been shown to rank builds the way the scorer does;
  until then, use it for mechanics.**
  Why: local sims, samples and loaded machines often rank builds differently
  from the board (timing, input size, lockstep vs lag); learn it in hour 1,
  not hour 20.
- **Stage-time probes:** a submit that times each stage inside the scorer run
  (where the rules allow), repeated for a median.
  Why: in-process timings on the scorer's hardware settle A/Bs that local wall
  times can't.
- **Extreme throwaway probes for "what does the grader read":** spend one
  attempt on a change so extreme that a category must move if the guess is
  right (blank the text layer; paint the page).
  Why: one probe gives strong evidence on a question that model-fitting on
  your own data keeps open for hours; confirm it when the result is close or
  surprising.
- **Measure the noise before any A/B:** the SD of repeated runs of one build.
  Report mean ± SD; never rank builds on one draw.
  Why: the best of many draws is luck (the max of ~50 draws sits ~2.2 SD above
  the mean), so a best single score overstates the code.
- **Size the runs from the noise** (80% power, two-sided α = 0.05, δ = the
  change you want to see):
  - unpaired: n per arm ≈ 16 · (SD / δ)²; a 1-SD change needs ~16 per arm;
  - matched (same seeds, maps or inputs on both arms): n pairs ≈
    8 · (SD_diff / δ)², with SD_diff from the paired differences.
  If you can't afford n, the A/B can't decide: don't run it as if it can.
  Why: single runs inside one SD pick winners by coin flip.
- **One change per submit on a fixed baseline, one ledger line each:**
  change, n, mean ± SD, verdict (keep or restore).
  Why: a ledger stops re-testing dead ideas and shows which change paid.

## 7. Reviews and safety, by expected value

- **Cap review rounds by what they can move:** if an optional performance-only
  review can change the score by less than the noise, one round, then ship.
  Correctness, security and data-loss findings keep their severity and recheck.
  Why: rounds on noise-sized changes spend the hours the big lever needed.
- **Weigh safety by the scoring rule.** When savings and penalties are in the
  same units and add up linearly (a penalty P per miss, a saving s per run), a
  change can afford about s / P misses per run; hard correctness gates,
  disqualification or other costs break that sum. When only first place pays,
  a pick that is safe but can't reach first wins nothing.
  Why: past the gates, safety is a cost to weigh against the objective, not
  the objective itself.
- **Keep the safety habits that pay:** an exact general path under every fast
  path; a holdout set (mutations or generated cases) never tuned on, with 0
  misses before a pick.
  Why: they reduce the risk of a penalty you can't see until the hidden final
  set; they lower risk, they don't prove final performance.
- **Timebox councils:** 30 minutes, one output, the top 3 levers ranked by
  score per hour; building starts when it lands.
  Why: an open-ended council costs an hour of wall time before work changes.

## 8. Keep compute and slots busy

- **Queue work before sleep:** matched runs, probes and builds that need no
  one awake, with the pacer on.
  Why: nights and limit hours sit idle otherwise, and the night is a third of
  the event.
- **Run submit queues without an agent** (a timer or service that submits and
  logs).
  Why: a usage limit, a crashed thread or a reboot then stops thinking, not
  scoring.
- **Spend weekly quota on the focus tracks, and check it at hour 0.**
  Why: a weekly bucket spent by mid-event is gone when the focus decision
  comes.
- **Use every submit slot to the end;** the last ones repeat the final
  candidates, and the pick goes on the mean.
  Why: unused slots are lost, and a pick on one lucky draw regresses in the
  final.

## 9. Prompt templates

The pattern: **name a number to beat, ask for a table, set a stop rule.**
Open-ended questions ("any new perspectives?") get open-ended work.

**The user, to the coordinator:**

- Hour 0: "Before any code: for each track, quote the prize line and the
  scoring rule, and say in one line what rank pays. Pick at most 2 tracks
  where the paying line is reachable and submit a valid baseline within the
  first hour."
- Hour 1: "Profile where our time goes on the real scorer, next to the
  leader's public repo. Table: stage, ours, theirs, gap. Work the biggest gap
  first."
- Stuck: "#1 is <X> and we are <Y>. Read the top 3 public repos. What do they
  do that we don't, and how much is each idea worth in <unit>? Build the
  biggest one safely."
- More helpers: "Find the single biggest score lever per track, with a number.
  One helper per lever, each told the target number."
- Council: "One council per track, 30 minutes, one output: the top 3 levers
  ranked by <unit> per hour of work. Start building the top one when it lands."
- Noisy board: "Test each change with matched runs sized from the SD, not
  single runs. Report mean ± SD."
- Stop or switch: "Table: our stage times vs the leader's, and the ETA for each
  stage to match. If no stage can close half the gap by <time>, say so and
  move the workers."
- Structure: "One coordinator. A lead each for the 1–2 tracks with the
  smallest gap to the paying line; freeze the rest at their best pick."

**The orchestrator, at the top of every worker brief:**

```
Objective (quoted): <track>: "<prize line>". Score: "<scoring rule>". Pays: <rank>.
Number to beat: <paying or leader score>; ours <Y>; this stage's target <Z> <unit>.
Noise: SD <s> per run; a change counts only past <δ> over <n> matched runs.
Measure on: <real scorer / probe submit>, not <local sim>.
Return: table | change | n | mean ± SD | vs baseline | verdict (keep / restore) |
Stop rule: no gain past the noise by <time> -> stop and report what you learned.
```

**A scout or research brief returns, per finding:** what it is, its effect in
<unit> with the source and run count, the cost in hours, and a verdict (build,
our own A/B, or drop and why).
