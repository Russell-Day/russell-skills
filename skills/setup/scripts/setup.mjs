#!/usr/bin/env node
// Set up russell-skills on this machine. The setup skill runs these steps.
//
//   node setup.mjs check            tools, T3 Code and which skills are linked
//   node setup.mjs detect           your T3 accounts, their folders, plans and limits
//   node setup.mjs draft            accounts.local.json and accounts.local.md built from detect
//   node setup.mjs draft --write    write both files (never replaces one; --force does)
//
//   --json               machine-readable output
//   --no-usage           skip the plan and limit check (it needs T3 running)
//   --usage-file f.json  read usage.mjs --json output from a file (tests)
//
// detect reads only these fields of T3's settings.json: each provider instance's id,
// driver, display name, enabled flag, home folder and auto-compact window. It never
// prints API keys, passwords, launch arguments or threads.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const subagents = path.join(repo, "skills/subagents");
// Where draft --write puts the account files (SETUP_ACCOUNTS_DIR is for tests).
const accountsDir = process.env.SETUP_ACCOUNTS_DIR || subagents;
const home = os.homedir();
const t3Dir = path.join(home, ".t3/userdata");
const tilde = (p) => (p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
};

// Which skills use each tool. "required" tools stop a skill from working.
const TOOLS = [
  { bin: "git", for: "every skill", required: true },
  { bin: "node", for: "every skill", required: true, min: 22 },
  { bin: "python3", for: "message-board, go-public, council", required: true, min: 3.9 },
  { bin: "claude", for: "Claude Code, the agent that runs the skills" },
  { bin: "codex", for: "Codex, the agent that runs the skills, and Codex workers" },
  { bin: "t3", for: "subagents, orchestrate, pacing, council (workers are T3 Code threads)" },
  { bin: "gh", for: "takeover, go-public" },
  { bin: "gitleaks", for: "go-public (the leak check)" },
  { bin: "git-filter-repo", for: "go-public (history rewrites)" },
  { bin: "uv", for: "council (before-and-after images)" },
  { bin: "timeout", for: "subagents' headless workers (run.sh). On macOS: brew install coreutils, then put its gnubin folder on PATH" },
  { bin: "agy", for: "subagents, optional (cheap Gemini helpers)" },
];

function version(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10000 });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : null;
}
const found = (bin) => spawnSync("bash", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
function tooOld(bin, min, v) {
  const m = v?.match(/(\d+)\.(\d+)/);
  if (!min || !m) return false;
  const [major, minor = 0] = String(min).split(".").map(Number);
  return Number(m[1]) * 1000 + Number(m[2]) < major * 1000 + minor;
}

const skills = () => fs.readdirSync(path.join(repo, "skills")).filter((s) => fs.existsSync(path.join(repo, "skills", s, "SKILL.md"))).sort();
function linked(name) {
  try { return fs.realpathSync(path.join(home, ".agents/skills", name)) === fs.realpathSync(path.join(repo, "skills", name)); }
  catch { return false; }
}

function t3Running() {
  const rt = readJson(path.join(t3Dir, "server-runtime.json"));
  if (!rt?.port) return Promise.resolve(false);
  return new Promise((ok) => {
    const s = net.connect({ host: "127.0.0.1", port: rt.port, timeout: 1500 });
    s.on("connect", () => { s.destroy(); ok(true); });
    s.on("error", () => ok(false));
    s.on("timeout", () => { s.destroy(); ok(false); });
  });
}

async function check() {
  const tools = TOOLS.map((t) => {
    const v = found(t.bin) ? version(t.bin) ?? "found" : null;
    return { ...t, version: v, ok: !!v && !tooOld(t.bin, t.min, v) };
  });
  const settings = readJson(path.join(t3Dir, "settings.json"));
  const t3 = {
    installed: !!settings || found("t3"),
    running: await t3Running(),
    autoResumeLimitedThreads: settings?.autoResumeLimitedThreads ?? null,
    snoozeLimitedThreads: settings?.snoozeLimitedThreads ?? null,
  };
  const all = skills();
  return {
    repo: tilde(repo),
    tools,
    t3,
    skills: { linked: all.filter(linked), notLinked: all.filter((s) => !linked(s)) },
    accountsFile: fs.existsSync(path.join(accountsDir, "accounts.local.json")) ? "accounts.local.json" : "accounts.example.json",
  };
}

function printCheck(r) {
  console.log(`russell-skills at ${r.repo}\n\nTools`);
  for (const t of r.tools) {
    const mark = t.ok ? "ok     " : t.required ? "MISSING" : "missing";
    const v = t.version && !t.ok ? ` (${t.version}, need ${t.min} or later)` : t.version ? ` (${t.version})` : "";
    console.log(`  ${mark} ${t.bin}${v}: ${t.for}`);
  }
  const yn = (b) => (b === null ? "not set" : b ? "on" : "off");
  console.log(`\nT3 Code: ${r.t3.installed ? "installed" : "not installed"}, ${r.t3.running ? "running" : "not running"}`);
  if (r.t3.installed) console.log(`  auto-resume limited threads: ${yn(r.t3.autoResumeLimitedThreads)}, snooze limited threads: ${yn(r.t3.snoozeLimitedThreads)}`);
  console.log(`\nSkills linked: ${r.skills.linked.join(", ") || "none"}`);
  if (r.skills.notLinked.length) console.log(`Not linked: ${r.skills.notLinked.join(", ")}`);
  console.log(`Accounts: skills/subagents/${r.accountsFile}`);
}

// T3 provider instances, safe fields only. A fresh T3 lists no instances in
// settings.json, so the built-in ones (codex, claudeAgent) are assumed.
function instances() {
  const raw = readJson(path.join(t3Dir, "settings.json"))?.providerInstances ?? {};
  const list = Object.entries(raw).map(([id, v]) => ({
    id,
    driver: v.driver,
    name: v.displayName ?? null,
    enabled: v.enabled !== false,
    home: v.config?.homePath || v.config?.shadowHomePath || null,
    autoCompactWindow: Number(v.config?.autoCompactWindow) || null,
  }));
  for (const [id, driver, dflt] of [["claudeAgent", "claudeAgent", "~/.claude"], ["codex", "codex", "~/.codex"]]) {
    if (!list.some((i) => i.driver === driver)) list.push({ id, driver, name: null, enabled: true, home: dflt, autoCompactWindow: null, assumed: true });
  }
  for (const i of list) {
    if (!i.home && i.driver === "claudeAgent") i.home = "~/.claude";
    if (!i.home && i.driver === "codex") i.home = "~/.codex";
  }
  return list;
}

function usage() {
  if (flag("no-usage")) return { skipped: true };
  try {
    const raw = opt("usage-file")
      ? fs.readFileSync(opt("usage-file"), "utf8")
      : execFileSync("node", [path.join(subagents, "code/usage.mjs"), "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    return { accounts: JSON.parse(raw) };
  } catch (e) {
    return { error: (e.stderr?.toString() || e.message).trim().split("\n")[0] };
  }
}

function detect() {
  const list = instances();
  const u = usage();
  for (const a of u.accounts ?? []) {
    const i = list.find((x) => x.id === a.instance);
    if (i) Object.assign(i, { plan: a.plan ?? null, windows: a.windows ?? [] });
  }
  const dirs = fs.readdirSync(home).filter((d) => /^\.(claude|codex)(_.*)?$/.test(d) && fs.statSync(path.join(home, d)).isDirectory()).map((d) => "~/" + d);
  return { instances: list, usage: u.error ? { error: u.error } : u.skipped ? { skipped: true } : { ok: true }, configFolders: dirs };
}

const left = (w) => {
  const ms = Date.parse(w.resetsAt) - Date.now();
  if (!Number.isFinite(ms)) return "";
  const h = Math.floor(ms / 3600e3);
  return h >= 24 ? `, resets in ${Math.floor(h / 24)}d ${h % 24}h` : `, resets in ${h}h ${Math.floor((ms % 3600e3) / 60e3)}m`;
};
function printDetect(r) {
  console.log("T3 accounts");
  for (const i of r.instances) {
    const bits = [i.driver, i.home, i.enabled ? null : "disabled", i.autoCompactWindow ? `compacts at ${i.autoCompactWindow} tokens` : null, i.assumed ? "T3's built-in default" : null].filter(Boolean);
    console.log(`  ${i.id}${i.name ? ` "${i.name}"` : ""}: ${bits.join(", ")}`);
    if (i.plan) console.log(`    plan: ${i.plan}`);
    for (const w of i.windows ?? []) console.log(`    ${w.label}: ${Math.round(w.usedPercent)}% used${left(w)}`);
  }
  if (r.usage.error) console.log(`\nPlans and limits not read: ${r.usage.error}`);
  console.log(`\nConfig folders in your home: ${r.configFolders.join(", ") || "none"}`);
}

// accounts.local.json and accounts.local.md from detect. The agent confirms each
// choice with the user before writing.
function draft(d) {
  const on = d.instances.filter((i) => i.enabled);
  const problems = [];
  const offIds = (driver) => d.instances.filter((i) => i.driver === driver && !i.enabled).map((i) => i.id).join(", ");
  const claudes = on.filter((i) => i.driver === "claudeAgent");
  if (!claudes.length) problems.push(`No Claude account is on in T3 (off: ${offIds("claudeAgent")}). Turn one on in T3 Code and run draft again.`);
  const lead = claudes.find((i) => !/worker|haiku/i.test(i.id)) ?? claudes[0] ?? { id: "claudeAgent", home: "~/.claude" };
  const worker = claudes.find((i) => i !== lead && i.home === lead.home && /worker/i.test(i.id)) ?? lead;
  const codexes = on.filter((i) => i.driver === "codex");
  if (!codexes.length) problems.push(`No Codex account is on in T3 (off: ${offIds("codex")}). Turn one on in T3 Code and run draft again.`);
  // Account names are what ACCOUNT=<name> picks, so they must be unique: codex is
  // "main", codex_x is "x", and a name already taken falls back to the full id.
  const accounts = [];
  for (const i of codexes) {
    let name = i.id === "codex" ? "main" : i.id.replace(/^codex_?/, "") || i.id;
    if (accounts.some((a) => a.name === name) || codexes.some((c) => c !== i && c.id === "codex" && name === "main")) name = i.id;
    accounts.push({ name, home: i.home, t3Instance: i.id, reserve: false });
  }
  if (!accounts.length) accounts.push({ name: "main", home: "~/.codex", t3Instance: "codex", reserve: false });
  const json = {
    claude: { configDir: lead.home, t3Instance: lead.id, t3WorkerInstance: worker.id },
    codex: { default: accounts.find((a) => a.name === "main")?.name ?? accounts[0].name, accounts },
    jobRoots: [],
    messageBoard: { feedback: "" },
  };
  const pool = (i) => ({ claudeAgent: "Claude", codex: "Codex", antigravity: "AGY" })[i.driver] ?? i.driver;
  const limits = (i) => (i.windows ?? []).map((w) => w.label).join(", ") || "unknown";
  const rows = on.filter((i) => ["claudeAgent", "codex", "antigravity"].includes(i.driver))
    .map((i) => `| ${pool(i)} | ${i.plan ?? "unknown plan"} | ${limits(i)} | \`${i.id}\`${i.home ? `: \`${i.home}\`` : ""} |`);
  const off = d.instances.filter((i) => !i.enabled).map((i) => `\`${i.id}\``);
  const md = `# Accounts and capacity (this machine)

Agents read this before they pick an account. The setup skill wrote this file. Edit it freely.

| Pool | Plan | Limit windows | T3 account: folder |
|---|---|---|---|
${rows.join("\n")}

Claude orchestrators use \`${json.claude.t3Instance}\`. Claude workers use \`${json.claude.t3WorkerInstance}\`.
${off.length ? `\nDisabled in T3, so not used: ${off.join(", ")}.\n` : ""}
## Notes

- Account to use first:
- Reserve account (used only when the others run low):
- Plans that cost extra money when you go over:
`;
  return { json, md, problems };
}

function writeDrafts({ json, md, problems }) {
  if (problems.length && !flag("force")) return ["Not written:", ...problems.map((p) => `  ${p}`), "Or write anyway with --force and edit the file."];
  const out = [];
  for (const [name, body] of [["accounts.local.json", JSON.stringify(json, null, 2) + "\n"], ["accounts.local.md", md]]) {
    const f = path.join(accountsDir, name);
    if (fs.existsSync(f) && !flag("force")) { out.push(`kept ${tilde(f)} (exists; --force replaces it)`); continue; }
    fs.writeFileSync(f, body);
    out.push(`wrote ${tilde(f)}`);
  }
  return out;
}

if (cmd === "check") {
  const r = await check();
  flag("json") ? console.log(JSON.stringify(r, null, 2)) : printCheck(r);
} else if (cmd === "detect") {
  const r = detect();
  flag("json") ? console.log(JSON.stringify(r, null, 2)) : printDetect(r);
} else if (cmd === "draft") {
  const d = draft(detect());
  if (flag("write")) {
    const out = writeDrafts(d);
    console.log(out.join("\n"));
    if (out[0] === "Not written:") process.exit(1);
  }
  else if (flag("json")) console.log(JSON.stringify(d, null, 2));
  else console.log(`${d.problems.map((p) => `PROBLEM: ${p}\n`).join("")}accounts.local.json\n\n${JSON.stringify(d.json, null, 2)}\n\naccounts.local.md\n\n${d.md}`);
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(cmd && cmd !== "--help" && cmd !== "help" ? 2 : 0);
}
