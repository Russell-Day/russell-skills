import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyClaudeLogs, latestClaudeWindows } from "./claude-logs.mjs";

const NOW = Date.parse("2026-10-09T16:30:00.000Z"); // fixture windows reset at 20:30Z
const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "testdata/provider-logs");
const accounts = (checkedAt) => [
  { instance: "codex", plan: "Pro", checkedAt, windows: [{ label: "Weekly", usedPercent: 78, resetsAt: null }], resetCredits: 0 },
  ...["claudeAgent_main", "claudeAgent_workers"].map((instance) => ({
    instance, plan: "Claude", checkedAt,
    windows: [{ label: "Session", usedPercent: 0, resetsAt: "2026-10-09T20:30:00.000Z" }, { label: "Weekly · Fable", usedPercent: 10, resetsAt: null }],
    resetCredits: 0,
  })),
];

test("latestClaudeWindows: newest real rate_limit_event, not quoted tool output", () => {
  const latest = latestClaudeWindows(fixtures, NOW);
  assert.equal(latest.at, Date.parse("2026-10-09T16:24:00.000Z"));
  assert.equal(latest.windows.five_hour.utilization, 0.43);
});

test("stale T3 probe: the thread logs win for every Claude instance", () => {
  const out = applyClaudeLogs(accounts("2026-10-09T15:45:01.000Z"), latestClaudeWindows(fixtures, NOW), NOW);
  for (const a of out.slice(1)) {
    assert.deepEqual(a.windows, [
      { label: "Session", usedPercent: 43, resetsAt: new Date(1791577800 * 1000).toISOString() },
      { label: "Weekly · Fable", usedPercent: 10, resetsAt: null },
      { label: "Weekly", usedPercent: 12, resetsAt: new Date(1791900000 * 1000).toISOString() },
    ]);
    assert.equal(a.checkedAt, "2026-10-09T16:24:00.000Z");
    assert.equal(a.source, "thread logs");
  }
  assert.deepEqual(out[0], accounts("2026-10-09T15:45:01.000Z")[0]);
});

test("fresh T3 probe, other window: the thread logs still win", () => {
  const fresh = accounts("2026-10-09T16:30:00.000Z").map((a) => a.plan === "Claude"
    ? { ...a, windows: [{ ...a.windows[0], resetsAt: "2026-10-09T22:30:00.000Z" }, a.windows[1]] } : a);
  const out = applyClaudeLogs(fresh, latestClaudeWindows(fixtures, NOW), NOW);
  assert.equal(out[1].windows[0].usedPercent, 43);
  assert.equal(out[1].source, "thread logs");
});

test("no logs: accounts unchanged", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-logs-"));
  assert.equal(latestClaudeWindows(empty, NOW), null);
  assert.equal(latestClaudeWindows(path.join(empty, "missing"), NOW), null);
  const before = accounts("2026-10-09T15:45:01.000Z");
  assert.deepEqual(applyClaudeLogs(accounts("2026-10-09T15:45:01.000Z"), null, NOW), before);
});

// Review regressions (sol61, b0de6f8).
const RESET = Date.parse("2026-10-09T20:30:00Z");
const AT = Date.parse("2026-10-09T16:24:00Z");
const event = (time, windows, extra = {}) => `[time] NTIVE: ${JSON.stringify({ event: { provider: "claudeAgent", method: "claude/rate_limit_event", createdAt: new Date(time).toISOString(), payload: { rate_limit_info: { unifiedWindows: windows } }, ...extra } })}\n`;
const five = (utilization = 0.43, resetsAt = RESET / 1000) => ({ five_hour: { utilization, resetsAt } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "claude-logs-"));
const write = (d, f, text, mtime = AT) => { const p = path.join(d, f); fs.writeFileSync(p, text); fs.utimesSync(p, new Date(mtime), new Date(mtime)); };
const session = (out) => out[0].windows.find((w) => w.label === "Session").usedPercent;
const one = () => accounts("2026-10-09T15:45:01.000Z").slice(1, 2);

test("expired log window: the probe's 0% stays and the source isn't claimed", () => {
  const out = applyClaudeLogs(one(), { at: AT, windows: five(0.9) }, RESET + 3600000);
  assert.equal(session(out), 0);
  assert.equal(out[0].source, undefined);
  assert.equal(out[0].checkedAt, "2026-10-09T15:45:01.000Z");
});

test("a newer event without utilization doesn't hide the earlier reading", () => {
  const d = tmp();
  write(d, "events.one.log", event(AT, five()) + event(AT + 60000, { five_hour: { resetsAt: RESET / 1000 } }));
  assert.equal(session(applyClaudeLogs(one(), latestClaudeWindows(d, NOW), NOW)), 43);
});

test("a newer seven_day-only event doesn't hide the earlier five_hour reading", () => {
  const d = tmp();
  write(d, "events.one.log", event(AT, five()) + event(AT + 60000, { seven_day: { utilization: 0.12, resetsAt: RESET / 1000 + 86400 } }));
  assert.equal(session(applyClaudeLogs(one(), latestClaudeWindows(d, NOW), NOW)), 43);
});

test("crowded logs: newer Codex files don't push out the Claude reading", () => {
  const d = tmp();
  write(d, "events.claude.log", event(AT, five()));
  for (let i = 0; i < 20; i++) {
    write(d, `events.codex${i}.log`, "[time] NTIVE: " + JSON.stringify({ event: { provider: "codex", method: "codex/rate_limits", createdAt: new Date(AT + 60000 + i).toISOString(), payload: {} } }) + "\n", AT + 60000 + i);
  }
  assert.equal(session(applyClaudeLogs(one(), latestClaudeWindows(d, NOW), NOW)), 43);
});

test("logs older than the 5 h window aren't read", () => {
  const d = tmp();
  write(d, "events.old.log", event(AT, five()), NOW - 6 * 3600000);
  assert.equal(latestClaudeWindows(d, NOW), null);
});

test("partial first line, malformed lines, missing windows and quoted events are skipped", () => {
  const d = tmp();
  write(d, "events.big.log", "[time] CANON: " + JSON.stringify({ payload: "x".repeat(3 * 1024 * 1024) }) + "\n"
    + '[time] NTIVE: {"event":{"method":"claude/rate_limit_event" broken\n' + event(AT, five()) + event(AT + 60000, undefined)
    + "[time] CANON: " + JSON.stringify({ event: { provider: "codex", method: "item.completed", payload: { text: event(AT + 90000, five(0.99)) } } }) + "\n");
  assert.equal(latestClaudeWindows(d, NOW).windows.five_hour.utilization, 0.43);
});

test("file mtime isn't event order: a quiet log's newer reading beats a busy log's older one", () => {
  const d = tmp();
  // The busy thread's log holds the older 94% but was touched last (later tool output).
  write(d, "events.busy-claude.log", event(AT - 120000, five(0.94)) + '[time] CANON: {"event":{"method":"tool.result"}}\n', AT + 60000);
  for (let i = 0; i < 10; i++) write(d, `events.codex${i}.log`, '[time] CANON: {"event":{"provider":"codex","method":"item.completed"}}\n', AT + i);
  write(d, "events.quiet-claude.log", event(AT - 1000, five(0.95)), AT - 1000);
  const latest = latestClaudeWindows(d, NOW);
  assert.equal(latest.at, AT - 1000);
  assert.equal(latest.windows.five_hour.utilization, 0.95);
});

// The thread logs win over any probe reading; the probe is only the fallback.
const probe = (usedPercent, resetsAt = "2026-10-09T20:30:00.000Z", checkedAt = "2026-10-09T16:29:00.000Z") =>
  [{ instance: "claudeAgent_main", plan: "Claude", checkedAt, windows: [{ label: "Session", usedPercent, resetsAt }], resetCredits: 0 }];

for (const [name, p] of [
  ["probe fresher and lower", probe(14)],
  ["probe fresher and higher", probe(50, "2026-10-09T20:30:07.000Z")],
  ["probe on a different reset", probe(5, "2026-10-09T21:30:00.000Z")],
  ["probe window expired", probe(90, "2026-10-09T16:00:00.000Z")],
  ["probe 0% with no reset time (2026-10-10)", probe(0, null)],
]) {
  test(`${name}: the log window wins`, () => {
    const out = applyClaudeLogs(p, { at: AT, windows: five(0.31) }, NOW);
    assert.deepEqual(out[0].windows, [{ label: "Session", usedPercent: 31, resetsAt: new Date(RESET).toISOString() }]);
    assert.equal(out[0].checkedAt, new Date(AT).toISOString());
    assert.equal(out[0].source, "thread logs");
  });
}

// T3 0.1.0 (2026-10-17) logs the SDK message itself; the time comes from the line prefix.
const v2event = (time, windows, provider = "claudeAgent") => `[${new Date(time).toISOString()}] NTIVE: ${JSON.stringify({ provider, protocol: "claude-agent-sdk.query", kind: "protocol", event: { direction: "incoming", stage: "decoded", payload: { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: windows } } } })}\n`;

test("0.1.0 log lines: read, timed by the prefix, and newer than an older-format reading", () => {
  const d = tmp();
  write(d, "events.old.log", event(AT - 60000, five(0.2)));
  write(d, "events.new.log", v2event(AT, five(0.53)) + v2event(AT + 60000, five(0.99), "codex"));
  const latest = latestClaudeWindows(d, NOW);
  assert.equal(latest.at, AT);
  assert.equal(latest.windows.five_hour.utilization, 0.53);
});

test("0.1.0 log lines: a quoted rate_limit_event in tool output doesn't count", () => {
  const d = tmp();
  write(d, "events.new.log", v2event(AT, five(0.53))
    + `[${new Date(AT + 60000).toISOString()}] NTIVE: ${JSON.stringify({ provider: "claudeAgent", event: { payload: { type: "user", text: v2event(AT + 60000, five(0.99)) } } })}\n`);
  assert.equal(latestClaudeWindows(d, NOW).windows.five_hour.utilization, 0.53);
});
