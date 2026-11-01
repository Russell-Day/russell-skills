#!/usr/bin/env node
// AGY (Gemini) out-of-quota state, shared by run.sh and t3-thread.mjs. When AGY
// is out, gemini-flash helpers run on Haiku high instead.
//
// The state lives in ~/.local/state/agent-stats/agy_state.json:
//   { checkedAt, windows: [{ label, usedPercent, resetsAt }] }
// The hourly usage probe writes it; an observed AGY quota error refreshes it.
// Missing or stale (> 2 h) state means "try Gemini": a quota error then falls
// back to Haiku in the same job. Routing never reads board posts.
//
//   node agy-state.mjs check                  prints the latest blocking reset (ISO) when AGY is out
//   node agy-state.mjs record-error <file>... parses "Resets in 34h35m30s" from the files, writes the
//                                             state, prints the reset (ISO) or nothing
//   node agy-state.mjs notice <reset-iso>     first fallback per reset: one board post (topic `limits`);
//                                             prints what happened, never fails
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STALE_MS = 2 * 3600 * 1000;
const stateDir = () => path.join(os.homedir(), ".local/state/agent-stats");
const stateFile = () => path.join(stateDir(), "agy_state.json");
const ERROR_LABEL = "Quota error";

// AGY's quota failures: exit 3 with one of these in the output.
export const agyQuotaRe = /RESOURCE_EXHAUSTED|Individual quota reached/i;

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return null; }
}

// The latest reset among windows at >= 100% that reset in the future, or null
// (also null when the state is missing or older than 2 h).
export function agyOutUntil(now = Date.now()) {
  const s = readState();
  if (!s || !(now - Date.parse(s.checkedAt) <= STALE_MS)) return null;
  const resets = (s.windows ?? [])
    .filter((w) => w.usedPercent >= 100 && Date.parse(w.resetsAt) > now)
    .map((w) => Date.parse(w.resetsAt));
  return resets.length ? new Date(Math.max(...resets)).toISOString() : null;
}

// "Resets in 111h36m58s" -> ISO time, written to the state so the next jobs skip Gemini.
export function recordQuotaError(text, now = Date.now()) {
  const m = /Resets in\s+(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(text);
  if (!m || !m.slice(1).some(Boolean)) return null;
  const [d, h, min, s] = m.slice(1).map((v) => Number(v ?? 0));
  const resetsAt = new Date(now + (((d * 24 + h) * 60 + min) * 60 + s) * 1000).toISOString();
  const old = readState();
  const windows = (old?.windows ?? []).filter((w) => w.label !== ERROR_LABEL);
  windows.push({ label: ERROR_LABEL, usedPercent: 100, resetsAt });
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...old, checkedAt: new Date(now).toISOString(), source: "quota-error", windows }, null, 2));
  fs.renameSync(tmp, stateFile());
  return resetsAt;
}

const localTime = (iso) => new Date(iso).toLocaleString("en-US", {
  weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

// One board notice per AGY reset. Probe and error resets for the same window differ by
// seconds, so a reset within 30 min of the noticed one counts as the same.
export function noticeOnce(resetIso) {
  const marker = path.join(stateDir(), "agy_notice");
  let last = NaN;
  try { last = Date.parse(fs.readFileSync(marker, "utf8").trim()); } catch {}
  if (Math.abs(last - Date.parse(resetIso)) < 30 * 60 * 1000) return "board notice already posted for this reset";
  const script = process.env.MESSAGE_BOARD_SCRIPT ?? path.join(os.homedir(), ".agents/skills/message-board/scripts/board.py");
  const body = `AGY/Gemini out until ${localTime(resetIso)} → helpers on Haiku high`;
  const r = spawnSync("python3", [script, "post", "--agent", "subagents-launcher", "--topic", "limits", "--file", "-"],
    { input: body, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return `board notice failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().split("\n").at(-1)}`;
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(marker, `${resetIso}\n`);
  return `board notice posted: ${body}`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "check") {
    const until = agyOutUntil();
    if (until) console.log(until);
  } else if (cmd === "record-error") {
    const text = args.map((f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");
    try { const at = recordQuotaError(text); if (at) console.log(at); } catch (e) { console.error(`agy state: ${e.message}`); }
  } else if (cmd === "notice" && args[0]) {
    try { console.log(noticeOnce(args[0])); } catch (e) { console.log(`board notice failed: ${e.message}`); }
  } else { console.error("usage: agy-state.mjs check | record-error <file>... | notice <reset-iso>"); process.exit(2); }
}
