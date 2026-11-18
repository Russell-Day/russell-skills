// Claude usage from T3's per-thread provider logs. T3's own probe (getConfig)
// can go stale for hours and read 0% (seen 2026-10-09), while every live
// Claude turn logs the account's real windows as a rate_limit_event. T3 0.1.0 (2026-10-17) logs
// the SDK message itself, timed by the line's prefix:
//   [time] NTIVE: {"provider":"claudeAgent",...,"event":{"payload":{"type":"rate_limit_event",
//     "rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.53,"resetsAt":<unix s>}}}}}}
// and logs from before it carry the older notification shape:
//   [time] NTIVE: {"event":{"method":"claude/rate_limit_event","createdAt":...,"payload":{"rate_limit_info":...}}}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOG_DIR = `${os.homedir()}/.t3/userdata/logs/provider`;
const TAIL = 2 * 1024 * 1024; // bytes read from the end of each file
const WINDOW_MS = 5 * 3600 * 1000; // a file untouched this long holds only expired five_hour windows

// A log window still in force: a utilization number and a reset not yet past.
const live = (w, now) => typeof w?.utilization === "number" && !(w.resetsAt && w.resetsAt * 1000 <= now);

// Each Claude T3 instance's config home from T3's settings (homePath; empty means ~/.claude):
// instances sharing a home are one account with one set of windows. {} when unreadable.
export function claudeHomes(file = path.join(os.homedir(), ".t3/userdata/settings.json")) {
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8")).providerInstances ?? {};
    return Object.fromEntries(Object.entries(p).filter(([, v]) => v?.driver === "claudeAgent").map(([k, v]) => [k, v.config?.homePath?.trim() || "~/.claude"]));
  } catch { return {}; }
}
// A reading's account: its instance's home (0.1.0 lines name the instance in providerSessionId,
// "provider-instance:<id>:"). An instance the settings don't list, or a line naming none, is "*".
const accountKey = (instance, homes) => (instance && homes[instance]) || "*";
const lineInstance = (entry) => /provider-instance:([^:]+):/.exec(entry?.providerSessionId ?? "")?.[1] ?? null;

// The newest rate_limit_event with a live five_hour window:
// { at, windows: { five_hour: { utilization, resetsAt }, ... }, accounts: { <home>: { at, windows } } },
// or null. `accounts` holds the newest reading per account (see accountKey).
// Reads every log touched in the last 5 h: file mtime isn't event order (a busy
// thread's log can hold an older reading than a quiet one's), and newer Codex
// logs mustn't push the Claude reading out of view. A full scan takes ~0.3 s.
export function latestClaudeWindows(dir = LOG_DIR, now = Date.now(), homes = claudeHomes()) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^events\..*\.log$/.test(f))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter(({ m }) => m > now - WINDOW_MS);
  } catch { return null; }
  let best = null;
  const byAccount = {};
  for (const { f } of files) {
    const fd = fs.openSync(f, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, TAIL));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      // Cheap filter first; then a real parse, since tool output quoting these logs contains the same text.
      if (!line.includes("rate_limit_event")) continue;
      let entry;
      try { entry = JSON.parse(line.slice(line.indexOf("{"))); } catch { continue; }
      const event = entry?.event;
      let at;
      if (event?.method === "claude/rate_limit_event") at = Date.parse(event.createdAt);
      else if (entry.provider === "claudeAgent" && event?.payload?.type === "rate_limit_event") at = Date.parse(line.slice(1, line.indexOf("]")));
      else continue;
      const windows = event.payload?.rate_limit_info?.unifiedWindows;
      if (!live(windows?.five_hour, now) || !at) continue;
      const key = accountKey(lineInstance(entry), homes);
      if (!(byAccount[key]?.at >= at)) byAccount[key] = { at, windows };
      if (!(best?.at >= at)) best = { at, windows };
    }
  }
  return best ? { ...best, accounts: byAccount } : null;
}

const LABELS = { five_hour: "Session", seven_day: "Weekly" };

// Put the log windows into every claudeAgent* account: each instance gets its own account's
// newest reading (instances sharing a config home are one account), else the "*" reading (a
// line naming no known instance). A second Claude account (the pacer's overflow) must never
// lend its windows to the main one (2026-11-18).
// The thread logs are the source: every live log window replaces T3's probe
// window of the same label. T3's probe is only the fallback when the logs hold
// no live window (no Claude turn since the reset). The probe kept reading
// stale (0% with no reset time, or 14% vs a real 31%), and
// pacing decisions went wrong.
export function applyClaudeLogs(accounts, latest, now = Date.now(), homes = claudeHomes()) {
  if (!latest) return accounts;
  for (const a of accounts) {
    if (!a.instance.startsWith("claudeAgent")) continue;
    const reading = latest.accounts ? latest.accounts[accountKey(a.instance, homes)] ?? latest.accounts["*"] : latest;
    if (!reading) continue;
    let replaced = false;
    for (const [key, w] of Object.entries(reading.windows)) {
      if (!live(w, now)) continue;
      const label = LABELS[key] ?? key;
      const win = { label, usedPercent: Math.round(w.utilization * 100), resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null };
      const i = a.windows.findIndex((x) => x.label === label);
      if (i === -1) a.windows.push(win); else a.windows[i] = win;
      replaced = true;
    }
    if (!replaced) continue;
    a.checkedAt = new Date(reading.at).toISOString();
    a.source = "thread logs";
  }
  return accounts;
}
