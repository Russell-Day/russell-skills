import "./testdata/use-test-accounts.mjs"; // first: fixed test accounts
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

// A line naming its instance, as T3 0.1.x logs it (providerSessionId "provider-session:provider-instance:<id>:…").
const onInstance = (time, windows, instance) => `[${new Date(time).toISOString()}] NTIVE: ${JSON.stringify({ provider: "claudeAgent", protocol: "claude-agent-sdk.query", kind: "protocol",
  providerSessionId: `provider-session:provider-instance:${instance}:thread:t1:abc`, event: { direction: "incoming", stage: "decoded", payload: { type: "rate_limit_event", rate_limit_info: { unifiedWindows: windows } } } })}\n`;

test("two Claude accounts: each instance gets its own account's reading, never the other's newer one", () => {
  const d = tmp();
  const homes = { claudeAgent_main: "~/.claude_main", claudeAgent_workers: "~/.claude_main", claudeAgent_spare: "~/.claude" };
  write(d, "events.main.log", onInstance(AT - 60000, five(0.97), "claudeAgent_workers"));
  write(d, "events.spare.log", onInstance(AT, five(0.12), "claudeAgent_spare"));
  const latest = latestClaudeWindows(d, NOW, homes);
  const rows = [...accounts("2026-10-09T15:45:01.000Z").slice(1), { instance: "claudeAgent_spare", plan: "Pro", windows: [], resetCredits: 0 }];
  const out = applyClaudeLogs(rows, latest, NOW, homes);
  const pct = (i) => out.find((a) => a.instance === i).windows.find((w) => w.label === "Session").usedPercent;
  assert.deepEqual([pct("claudeAgent_main"), pct("claudeAgent_workers"), pct("claudeAgent_spare")], [97, 97, 12]);
  // Sibling: the settings unreadable ({}): one account, the newest reading for all, as before.
  const all = applyClaudeLogs(accounts("2026-10-09T15:45:01.000Z").slice(1), latestClaudeWindows(d, NOW, {}), NOW, {});
  assert.deepEqual(all.map((a) => a.windows.find((w) => w.label === "Session").usedPercent), [12, 12]);
});

// The cache file (`cache`): readings kept between runs, so a grown log is read from where the
// last run stopped. The answer must equal a cold read in every case.
test("cache: a grown log reads only the appended bytes, and the answer equals a cold read", () => {
  const d = tmp(), cache = path.join(tmp(), "logs-cache.json");
  write(d, "events.alpha.log", event(AT - 5000, five(0.30)));
  write(d, "events.beta.log", v2event(AT - 4000, five(0.31)));
  const cold = {};
  assert.deepEqual(latestClaudeWindows(d, NOW, {}, { cache, stats: cold }), latestClaudeWindows(d, NOW, {}));
  assert.equal(cold.cached, 0);
  assert.equal(cold.read, fs.statSync(path.join(d, "events.alpha.log")).size + fs.statSync(path.join(d, "events.beta.log")).size);
  const added = v2event(AT - 1000, five(0.52)) + '[time] CANON: {"event":{"method":"tool.result"}}\n';
  fs.appendFileSync(path.join(d, "events.alpha.log"), added);
  fs.utimesSync(path.join(d, "events.alpha.log"), new Date(AT), new Date(AT));
  const warm = {};
  const got = latestClaudeWindows(d, NOW, {}, { cache, stats: warm });
  assert.equal(got.windows.five_hour.utilization, 0.52);
  assert.deepEqual(got, latestClaudeWindows(d, NOW, {}));
  assert.equal(warm.cached, 1); // the unchanged log
  assert.equal(warm.read, Buffer.byteLength(added) + 1); // the appended bytes and the newline before them
  // A third run with nothing changed reads nothing.
  const idle = {};
  assert.deepEqual(latestClaudeWindows(d, NOW, {}, { cache, stats: idle }), got);
  assert.deepEqual([idle.read, idle.cached], [0, 2]);
});

test("cache: a log rewritten shorter, or replaced by another file, is read again in full", () => {
  const d = tmp(), cache = path.join(tmp(), "logs-cache.json");
  write(d, "events.gamma.log", event(AT - 5000, five(0.61)) + event(AT - 4000, five(0.62)));
  assert.equal(latestClaudeWindows(d, NOW, {}, { cache }).windows.five_hour.utilization, 0.62);
  write(d, "events.gamma.log", event(AT - 3000, five(0.18)));
  assert.equal(latestClaudeWindows(d, NOW, {}, { cache }).windows.five_hour.utilization, 0.18);
  // Same size, new content and mtime (a rotated file): not taken for an append.
  const p = path.join(d, "events.gamma.log");
  write(d, "events.gamma.log", event(AT - 2000, five(0.27)), AT + 1000);
  assert.equal(fs.statSync(p).size, Buffer.byteLength(event(AT - 3000, five(0.18))));
  assert.deepEqual(latestClaudeWindows(d, NOW, {}, { cache }), latestClaudeWindows(d, NOW, {}));
  assert.equal(latestClaudeWindows(d, NOW, {}, { cache }).windows.five_hour.utilization, 0.27);
});

test("cache: a missing, corrupt or other-version cache file gives the cold answer and is rewritten", () => {
  const d = tmp(), dir = tmp();
  write(d, "events.delta.log", event(AT - 2000, five(0.44)) + v2event(AT - 1000, five(0.45)));
  const want = latestClaudeWindows(d, NOW, {});
  for (const [name, text] of [["missing.json", null], ["corrupt.json", "{not json"], ["old.json", JSON.stringify({ v: 0, files: { x: 1 } })], ["wrong.json", JSON.stringify({ v: 2, tail: 2 * 1024 * 1024, files: { [path.join(d, "events.delta.log")]: { bogus: true } } })]]) {
    const cache = path.join(dir, name);
    if (text != null) fs.writeFileSync(cache, text);
    const stats = {};
    assert.deepEqual(latestClaudeWindows(d, NOW, {}, { cache, stats }), want, name);
    assert.equal(JSON.parse(fs.readFileSync(cache, "utf8")).v, 2, name);
    assert.deepEqual(latestClaudeWindows(d, NOW, {}, { cache }), want, name);
  }
});

test("cache: a last line still being written counts now and is read again once it ends", () => {
  const d = tmp(), cache = path.join(tmp(), "logs-cache.json");
  const p = path.join(d, "events.epsilon.log");
  const half = v2event(AT - 1000, five(0.71));
  write(d, "events.epsilon.log", event(AT - 3000, five(0.70)) + half.slice(0, -1)); // no newline yet
  assert.equal(latestClaudeWindows(d, NOW, {}, { cache }).windows.five_hour.utilization, 0.71);
  fs.appendFileSync(p, "\n" + v2event(AT - 500, five(0.72)).slice(0, 40));
  fs.utimesSync(p, new Date(AT), new Date(AT));
  const got = latestClaudeWindows(d, NOW, {}, { cache });
  assert.equal(got.windows.five_hour.utilization, 0.71);
  assert.deepEqual(got, latestClaudeWindows(d, NOW, {}));
});

test("cache: older readings dropped from the cache never change the pick, an expiring newer one included", () => {
  const d = tmp(), cache = path.join(tmp(), "logs-cache.json");
  // The newer reading's window ends before NOW; the older one's is still live, so it must stay.
  write(d, "events.zeta.log", event(AT - 9000, five(0.20)) + event(AT - 8000, five(0.33)) + event(AT - 1000, five(0.90, (NOW - 1000) / 1000)));
  const want = latestClaudeWindows(d, NOW, {});
  assert.equal(want.windows.five_hour.utilization, 0.33);
  latestClaudeWindows(d, NOW, {}, { cache });
  const kept = Object.values(JSON.parse(fs.readFileSync(cache, "utf8")).files)[0].readings.map((r) => r.windows.five_hour.utilization);
  assert.deepEqual(kept, [0.33, 0.90]); // 0.20 can never win again
  assert.deepEqual(latestClaudeWindows(d, NOW, {}, { cache }), want);
  // Earlier, while 0.90 is still live, it wins with or without the cache.
  assert.deepEqual(latestClaudeWindows(d, NOW - 5000, {}, { cache }), latestClaudeWindows(d, NOW - 5000, {}));
});

// One plain read of each log's last 2 MB, split on newlines, every piece parsed from its first
// "{" (the scan before the cache). The cached scan must give this answer at the tail edge too.
const TAIL = 2 * 1024 * 1024;
function fullScan(dir, now) {
  let best = null;
  for (const f of fs.readdirSync(dir).filter((f) => /^events\..*\.log$/.test(f))) {
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs <= now - 5 * 3600 * 1000) continue;
    const all = fs.readFileSync(p);
    for (const line of all.subarray(Math.max(0, all.length - TAIL)).toString("utf8").split("\n")) {
      if (!line.includes("rate_limit_event")) continue;
      let entry;
      try { entry = JSON.parse(line.slice(line.indexOf("{"))); } catch { continue; }
      const event = entry?.event;
      let at;
      if (event?.method === "claude/rate_limit_event") at = Date.parse(event.createdAt);
      else if (entry.provider === "claudeAgent" && event?.payload?.type === "rate_limit_event") at = Date.parse(line.slice(1, line.indexOf("]")));
      else continue;
      const windows = event.payload?.rate_limit_info?.unifiedWindows;
      const w = windows?.five_hour;
      if (typeof w?.utilization !== "number" || (w.resetsAt && w.resetsAt * 1000 <= now) || !at) continue;
      if (!(best?.at >= at)) best = { at, windows };
    }
  }
  return best ? { ...best, accounts: { "*": best } } : null;
}
// Cold with a cache, warm from it, and with no cache: each equals the plain read.
const sameAsFullScan = (d, label) => {
  const cache = path.join(tmp(), "logs-cache.json"), want = fullScan(d, NOW);
  for (const run of ["cold", "warm"]) assert.deepEqual(latestClaudeWindows(d, NOW, {}, { cache }), want, `${label} ${run}`);
  assert.deepEqual(latestClaudeWindows(d, NOW, {}), want, `${label} no cache`);
  return { want, cache };
};

test("tail edge: the line the 2 MB edge cuts still counts when its JSON survives, as a plain read finds it", () => {
  const d = tmp();
  // The edge falls in a long prefix: the event's JSON is whole in the tail.
  write(d, "events.eta.log", "x".repeat(TAIL) + event(AT - 2000, five(0.87)) + event(AT - 9000, five(0.40)));
  assert.equal(sameAsFullScan(d, "long prefix").want.windows.five_hour.utilization, 0.87);
  // Sibling: a prefix of two-byte characters, so the edge also splits a character.
  const e = tmp();
  write(e, "events.theta.log", "é".repeat(TAIL / 2 + 7) + "x" + event(AT - 1500, five(0.64)));
  assert.equal(sameAsFullScan(e, "split character").want.windows.five_hour.utilization, 0.64);
  // The edge piece runs to the end of the file (no newline yet).
  const g = tmp();
  write(g, "events.iota.log", "x".repeat(TAIL) + event(AT - 1000, five(0.58)).slice(0, -1));
  assert.equal(sameAsFullScan(g, "no newline").want.windows.five_hour.utilization, 0.58);
});

test("tail edge: an edge inside the JSON drops that line; an edge on a line start keeps it whole", () => {
  const d = tmp();
  const cut = event(AT - 1000, five(0.91));
  // Lands 20 bytes into the cut line, past "[time] NTIVE: {".
  write(d, "events.kappa.log", event(AT - 3000, five(0.35)) + cut + "y".repeat(TAIL - cut.length + 19) + "\n");
  assert.equal(sameAsFullScan(d, "inside JSON").want, null);
  const e = tmp();
  const whole = event(AT - 1000, five(0.55));
  write(e, "events.lambda.log", "z".repeat(1000) + "\n" + whole + "w".repeat(TAIL - whole.length - 1) + "\n");
  assert.equal(sameAsFullScan(e, "line start").want.windows.five_hour.utilization, 0.55);
});

test("tail edge: a cached log that grows past 2 MB keeps the cut line's reading, as a plain read does", () => {
  const d = tmp(), cache = path.join(tmp(), "logs-cache.json");
  const p = path.join(d, "events.mu.log");
  write(d, "events.mu.log", "p".repeat(5000) + event(AT - 2000, five(0.66)) + event(AT - 9000, five(0.12)));
  assert.equal(latestClaudeWindows(d, NOW, {}, { cache }).windows.five_hour.utilization, 0.66);
  // Grow it so the edge lands 2500 bytes into the long prefix of the 0.66 line.
  const before = fs.statSync(p).size;
  fs.appendFileSync(p, "r".repeat(2500 + TAIL - before - 1) + "\n");
  fs.utimesSync(p, new Date(AT), new Date(AT));
  const want = fullScan(d, NOW);
  assert.equal(want.windows.five_hour.utilization, 0.66);
  const stats = {};
  assert.deepEqual(latestClaudeWindows(d, NOW, {}, { cache, stats }), want);
  // The appended bytes (and the newline before them), then one 64 KB chunk from the edge for the cut line.
  assert.equal(stats.read, fs.statSync(p).size - before + 1 + 64 * 1024);
  const idle = {};
  assert.deepEqual(latestClaudeWindows(d, NOW, {}, { cache, stats: idle }), want);
  assert.equal(idle.read, 0);
  // Grow it again so the edge moves past the 0.66 line: only 0.12's line is left, cut.
  fs.appendFileSync(p, "s".repeat(6000) + "\n");
  fs.utimesSync(p, new Date(AT), new Date(AT));
  assert.deepEqual(latestClaudeWindows(d, NOW, {}, { cache }), fullScan(d, NOW));
});

test("cache: a record of the wrong shape for an unchanged file is a full read, not an error", () => {
  const d = tmp(), cache = path.join(tmp(), "logs-cache.json");
  write(d, "events.nu.log", event(AT - 1000, five(0.48)));
  const f = path.join(d, "events.nu.log"), st = fs.statSync(f);
  const stamp = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, end: st.size };
  for (const rec of [{ ...stamp }, { ...stamp, edge: null, readings: "nope" }, { ...stamp, edge: null, readings: [{ o: 0 }] }, { ...stamp, edge: { bad: 1 }, readings: [] }]) {
    fs.writeFileSync(cache, JSON.stringify({ v: 2, tail: TAIL, files: { [f]: rec } }));
    assert.equal(latestClaudeWindows(d, NOW, {}, { cache }).windows.five_hour.utilization, 0.48, JSON.stringify(rec));
  }
});
