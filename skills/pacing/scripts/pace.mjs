#!/usr/bin/env node
// Is a usage window on pace? Compares a window's used % with an even-spend line
// that reaches 100% --margin minutes before the window resets.
//
//   node pace.mjs                       Claude session window (5 h) of your Claude T3 instance
//   node pace.mjs --window weekly       the weekly window (7 days)
//   node pace.mjs --instance <id>       another T3 provider instance (see usage.mjs --json)
//   node pace.mjs --margin 30           reach 100% 30 min before the reset (default 10)
//   node pace.mjs --band 5              how far over the line counts as "over" (default 5 points)
//   node pace.mjs --cached              use T3's last probe instead of refreshing
//   node pace.mjs --json                machine-readable
//   node pace.mjs --usage-file f.json   read usage.mjs --json output from a file (tests)
//
// Usage comes from the subagents skill's usage.mjs (needs T3 running).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const subagents = path.resolve(here, "../../subagents/code");
const WINDOWS = { session: { label: "Session", hours: 5 }, weekly: { label: "Weekly", hours: 24 * 7 } };

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
if (flag("help") || flag("h")) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

const windowName = opt("window", "session");
const win = WINDOWS[windowName];
if (!win) {
  console.error(`--window must be session or weekly, not ${windowName}`);
  process.exit(2);
}
const margin = Number(opt("margin", "10"));
const band = Number(opt("band", "5"));

let instance = opt("instance", null);
if (!instance) instance = (await import(path.join(subagents, "accounts.mjs"))).claude.t3Instance;

const usageFile = opt("usage-file", null);
const raw = usageFile
  ? fs.readFileSync(usageFile, "utf8")
  : execFileSync("node", [path.join(subagents, "usage.mjs"), "--json", ...(flag("cached") ? ["--cached"] : [])], { encoding: "utf8" });
const accounts = JSON.parse(raw);
const acct = accounts.find((a) => a.instance === instance);
const windows = acct?.windows ?? [];
const w = windows.find((x) => x.label === win.label) ?? windows.find((x) => x.label.startsWith(win.label));
if (!w) {
  console.error(`no ${windowName} window for ${instance}; instances: ${accounts.map((a) => a.instance).join(", ")}`);
  process.exit(2);
}

function pace({ usedPercent, resetsAt }, { hours, margin, band, now = Date.now() }) {
  const len = hours * 3600e3;
  const start = Date.parse(resetsAt) - len;
  const spendable = Math.max(len - margin * 60e3, 1);
  const elapsed = Math.min(Math.max((now - start) / spendable, 0), 1);
  const line = Math.round(elapsed * 100);
  const diff = usedPercent - line;
  const state = diff > band ? "over" : diff < -2 * band ? "under" : "on";
  return { used: usedPercent, line, diff, state, elapsedMs: Math.max(now - start, 0), lenMs: len, resetsAt };
}

const r = pace(w, { hours: win.hours, margin, band, now: Number(opt("now", Date.now())) });
const advice = {
  over: "Over pace: start at most one more heavy worker; queue the rest for later.",
  on: "On pace: start what's ready.",
  under: "Under pace: room to spare; start what's ready, unused window is lost at the reset.",
}[r.state];
if (flag("json")) {
  console.log(JSON.stringify({ instance, window: windowName, ...r, advice }));
} else {
  const hm = (ms) => `${Math.floor(ms / 3600e3)}h${String(Math.floor((ms % 3600e3) / 60e3)).padStart(2, "0")}m`;
  console.log(`${instance} ${windowName}: ${r.used}% used, ${hm(r.elapsedMs)} of ${win.hours}h gone (pace line ${r.line}%). ${advice}`);
}
