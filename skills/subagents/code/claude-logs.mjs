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

// One log line's reading, { at, inst, windows }, or null: not a rate_limit_event (tool output
// quoting these logs contains the same text, so it takes a real parse), no time, or no
// five_hour utilization. Whether its window is still in force depends on `now`, so that is
// checked when readings are picked, not here.
function lineReading(line) {
  let entry;
  try { entry = JSON.parse(line.slice(line.indexOf("{"))); } catch { return null; }
  const event = entry?.event;
  let at;
  if (event?.method === "claude/rate_limit_event") at = Date.parse(event.createdAt);
  else if (entry.provider === "claudeAgent" && event?.payload?.type === "rate_limit_event") at = Date.parse(line.slice(1, line.indexOf("]")));
  else return null;
  const windows = event.payload?.rate_limit_info?.unifiedWindows;
  if (typeof windows?.five_hour?.utilization !== "number" || !at) return null;
  return { at, inst: lineInstance(entry), windows };
}

const NEEDLE = Buffer.from("rate_limit_event");
const NL = 10;
// The readings of the whole lines in buf[from, to) (`from` starts a line), with `o`, each
// line's byte offset in the file (`base` is buf[0]'s). The cheap byte search comes first.
function scanLines(buf, base, from, to, out) {
  for (let i = buf.indexOf(NEEDLE, from); i !== -1 && i < to;) {
    const s = buf.lastIndexOf(NL, i) + 1;
    let e = buf.indexOf(NL, i);
    if (e === -1 || e > to) e = to;
    const r = lineReading(buf.toString("utf8", s, e));
    if (r) out.push({ o: base + s, ...r });
    i = buf.indexOf(NEEDLE, e + 1);
  }
  return out;
}

// When a reading's five_hour window stops being live (see `live`): never without a reset time.
const liveUntil = (r) => { const t = r.windows.five_hour.resetsAt * 1000; return r.windows.five_hour.resetsAt && !Number.isNaN(t) ? t : Infinity; };
// Drop the readings that can never be picked: a later line of the same instance has a newer
// time and stays live at least as long. The pick is the first newest live reading per account
// (and overall), so a reading with a strictly newer, longer-lived one after it never wins.
function prune(readings) {
  const kept = [];
  for (let i = readings.length - 1; i >= 0; i--) {
    const r = readings[i];
    if (!kept.some((k) => k.inst === r.inst && k.at > r.at && liveUntil(k) >= liveUntil(r))) kept.push(r);
  }
  return kept.reverse();
}

// The reading in the line the tail edge `lo` cuts (from `lo` to the next newline, or to the end
// of the file), parsed from its first "{" as a whole line is: a long line can lose only its
// prefix and keep its JSON. null when `lo` starts a line (that line is whole and scanned with
// the rest) or the piece holds no event. `buf`, when given, holds the file from lo - 1 on;
// else the piece is read, and its bytes added to `count.read`.
const CHUNK = 64 * 1024;
function edgeReading(fd, lo, size, buf, count) {
  if (lo === 0) return null;
  let piece;
  if (buf) {
    if (buf[0] === NL) return null;
    const nl = buf.indexOf(NL);
    piece = buf.subarray(1, nl === -1 ? buf.length : nl);
  } else {
    const parts = [];
    for (let pos = lo - 1; pos < size;) {
      const b = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = fs.readSync(fd, b, 0, b.length, pos);
      if (!n) break;
      count.read += n;
      let got = b.subarray(0, n);
      if (pos === lo - 1) { if (got[0] === NL) return null; got = got.subarray(1); }
      const nl = got.indexOf(NL);
      parts.push(nl === -1 ? got : got.subarray(0, nl));
      if (nl !== -1) break;
      pos += n;
    }
    piece = Buffer.concat(parts);
  }
  const r = piece.includes(NEEDLE) ? lineReading(piece.toString("utf8")) : null;
  return r && { o: lo, ...r };
}

// A log file's readings in its last TAIL bytes, in file order, as one full read of those bytes
// finds them. `old` is the file's cached record from an earlier run: when the file only grew
// (same inode, not smaller), its readings are kept and only the appended bytes are read.
// Returns { rec, readings, read }: `rec` is the record to cache (whole lines in `readings`, the
// line the tail edge cuts in `edge`), `readings` adds a trailing line still being written,
// `read` is the bytes read.
const same = (a, b) => a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const withEdge = (rec) => (rec.edge ? [rec.edge, ...rec.readings] : rec.readings);
function fileReadings(f, st, old) {
  if (old && same(old, st) && old.end === st.size) return { rec: old, readings: withEdge(old), read: 0 };
  const fd = fs.openSync(f, "r");
  let buf, from, rec, read;
  try {
    const info = fs.fstatSync(fd);
    const lo = Math.max(0, info.size - TAIL);
    const grew = old && old.ino === info.ino && info.size >= old.size && !(info.size === old.size && info.mtimeMs !== old.mtimeMs);
    const start = grew ? Math.max(old.end, lo) : lo;
    from = start > 0 ? start - 1 : 0; // one byte early: is `start` a line start?
    buf = Buffer.alloc(Math.max(0, info.size - from));
    buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, from));
    read = buf.length;
    let first = 0;
    if (start > 0) first = buf[0] === NL ? 1 : buf.indexOf(NL) + 1 || buf.length;
    const end = Math.max(first, buf.lastIndexOf(NL) + 1);
    const kept = grew ? old.readings.filter((r) => r.o >= lo) : [];
    let edge;
    if (grew && info.size === old.size) edge = old.edge; // same bytes, same edge
    else if (start === lo) edge = edgeReading(fd, lo, info.size, buf);
    else { const count = { read: 0 }; edge = edgeReading(fd, lo, info.size, null, count); read += count.read; }
    rec = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, end: from + end, edge, readings: prune(scanLines(buf, from, first, end, kept)) };
  } finally { fs.closeSync(fd); }
  const end = rec.end - from;
  const tail = end < buf.length && buf.includes(NEEDLE, end) ? lineReading(buf.toString("utf8", end)) : null;
  const readings = withEdge(rec);
  return { rec, readings: tail ? [...readings, { o: rec.end, ...tail }] : readings, read };
}

const CACHE_VERSION = 2;
const isReading = (r) => typeof r?.o === "number" && typeof r.at === "number" && typeof r.windows?.five_hour?.utilization === "number";
const isRecord = (r) => [r?.ino, r?.size, r?.mtimeMs, r?.end].every(Number.isFinite) && Array.isArray(r.readings)
  && r.readings.every(isReading) && (r.edge === null || isReading(r.edge));
function readCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    // A record of the wrong shape is left out: that file gets a full read.
    if (c?.v === CACHE_VERSION && c.tail === TAIL && c.files && typeof c.files === "object") return Object.fromEntries(Object.entries(c.files).filter(([, r]) => isRecord(r)));
  } catch { /* missing or corrupt: a cold read */ }
  return {};
}
function writeCache(file, files) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, tail: TAIL, files }));
    fs.renameSync(tmp, file);
  } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ } }
}

// The newest rate_limit_event with a live five_hour window:
// { at, windows: { five_hour: { utilization, resetsAt }, ... }, accounts: { <home>: { at, windows } } },
// or null. `accounts` holds the newest reading per account (see accountKey).
// Reads the last 2 MB of every log touched in the last 5 h: file mtime isn't event order (a
// busy thread's log can hold an older reading than a quiet one's), and newer Codex logs
// mustn't push the Claude reading out of view. A full scan takes ~0.3 s, so a caller that runs
// often passes `cache`, a JSON file the per-file readings are kept in between runs (keyed by
// path, inode, size and mtime): then only the bytes appended since are read. The answer is the
// same with or without it; a missing or unreadable cache file is a full scan. `stats`, when
// given, gets { files, read: bytes read, cached: files answered from the cache }.
export function latestClaudeWindows(dir = LOG_DIR, now = Date.now(), homes = claudeHomes(), { cache, stats } = {}) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^events\..*\.log$/.test(f))
      .map((f) => ({ f: path.join(dir, f), st: fs.statSync(path.join(dir, f)) }))
      .filter(({ st }) => st.mtimeMs > now - WINDOW_MS);
  } catch { return null; }
  const old = cache ? readCache(cache) : {};
  const next = {};
  let best = null;
  const byAccount = {};
  if (stats) Object.assign(stats, { files: files.length, read: 0, cached: 0 });
  for (const { f, st } of files) {
    let got;
    try { got = fileReadings(f, st, old[f]); } catch { continue; } // gone since the listing
    next[f] = got.rec;
    if (stats) { stats.read += got.read; if (got.rec === old[f]) stats.cached++; }
    for (const { at, inst, windows } of got.readings) {
      if (!live(windows.five_hour, now)) continue;
      const key = accountKey(inst, homes);
      if (!(byAccount[key]?.at >= at)) byAccount[key] = { at, windows };
      if (!(best?.at >= at)) best = { at, windows };
    }
  }
  const changed = (f) => next[f] !== old[f];
  if (cache && (Object.keys(next).some(changed) || Object.keys(old).some(changed))) writeCache(cache, next);
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
