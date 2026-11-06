// A temp HOME wired to the fake T3 (fake-t3.mjs) for running the real CLIs in a subprocess.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claude } from "../accounts.mjs";

const preload = path.join(path.dirname(new URL(import.meta.url).pathname), "fake-t3.mjs");
export const PROJECT = "/fake/project";
export const opus = (instanceId = claude.t3Instance) => JSON.stringify({ instanceId, model: "claude-opus-5-5" });
export const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

// The pacer's night rule reads the wall clock (a window resetting 00:00–10:00 his time, Detroit
// with no zone.json, is a night window), so a test run late in the evening saw night. The fake
// pins day: a night window only at the one minute 12 h off the default reset. A test that wants
// night passes config.night or a sleep file.
const dayPin = (resetsAt) => {
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Detroit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(resetsAt + 12 * 3600e3));
  return { resetFrom: hhmm, resetTo: hhmm };
};

export function fakeHome({ threads = [], runs = [], messages = [], usedPercent = 50, resetsInMin = 150, state, config = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fake-t3-"));
  const db = path.join(home, "t3.json");
  const stateDir = path.join(home, "pacer");
  fs.mkdirSync(path.join(home, ".t3/userdata"), { recursive: true });
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(home, ".t3/userdata/server-runtime.json"), JSON.stringify({ port: 1 }));
  fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ night: dayPin(Date.now() + resetsInMin * 60000), ...config }));
  if (state) fs.writeFileSync(path.join(stateDir, "queue.json"), JSON.stringify(state));
  const row = (t) => ({ project_id: "proj-1", model_selection_json: opus(), pending_user_input_count: 0, pending_approval_count: 0, pinned_at: null, ...t });
  fs.writeFileSync(db, JSON.stringify({
    projects: [{ project_id: "proj-1", workspace_root: PROJECT }], threads: threads.map(row), runs, messages, commands: [],
    usage: [{ instance: claude.t3Instance, windows: [{ label: "Session (5h)", usedPercent, resetsAt: new Date(Date.now() + resetsInMin * 60000).toISOString() }] }],
  }));
  const env = { ...process.env, HOME: home, FAKE_T3: db, PACER_STATE_DIR: stateDir, AGENT_JOBS_DIR: path.join(home, "jobs") };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "PROJECT_ROOT", "TITLE", "JOB", "ATTACH", "CONTINUE"]) delete env[k];
  return {
    home, stateDir,
    run: (script, args, extra = {}) => spawnSync(process.execPath, ["--import", preload, script, ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 60000 }),
    db: () => JSON.parse(fs.readFileSync(db, "utf8")),
    sent: (type) => JSON.parse(fs.readFileSync(db, "utf8")).commands.filter((c) => !type || c.type === type),
    state: () => JSON.parse(fs.readFileSync(path.join(stateDir, "queue.json"), "utf8")),
  };
}
