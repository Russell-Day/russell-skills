// node --test skills/setup/scripts/setup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "setup.mjs");
const install = path.resolve(here, "../../../install.sh");

// A fake home with a T3 settings.json that holds secrets the script must not print.
function fakeHome(providerInstances) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "setup-"));
  fs.mkdirSync(path.join(home, ".t3/userdata"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude"));
  if (providerInstances) fs.writeFileSync(path.join(home, ".t3/userdata/settings.json"), JSON.stringify({ providerInstances }));
  return home;
}
const run = (home, ...args) => execFileSync("node", [script, ...args], {
  encoding: "utf8",
  env: { ...process.env, HOME: home, SETUP_ACCOUNTS_DIR: path.join(home, "accounts") },
});
const usageFile = (home, rows) => {
  const f = path.join(home, "usage.json");
  fs.writeFileSync(f, JSON.stringify(rows));
  return f;
};

const instances = {
  claudeAgent_work: { driver: "claudeAgent", enabled: true, config: { homePath: "~/.claude_work", autoCompactWindow: "300000", launchArgs: "--secret-arg" } },
  claudeAgent_work_workers: { driver: "claudeAgent", enabled: true, config: { homePath: "~/.claude_work", autoCompactWindow: "200000" } },
  codex: { driver: "codex", enabled: true, config: { homePath: "", shadowHomePath: "" } },
  codex_spare: { driver: "codex", enabled: true, config: { shadowHomePath: "~/.codex_spare" } },
  codex_old: { driver: "codex", enabled: false, config: { shadowHomePath: "~/.codex_old" } },
  antigravity: { driver: "antigravity", enabled: true, config: { apiKey: "sk-SECRET-KEY" } },
  opencode: { driver: "opencode", enabled: true, config: { serverPassword: "hunter2" } },
};

test("detect lists accounts with plans and never prints secrets", () => {
  const home = fakeHome(instances);
  const u = usageFile(home, [{ instance: "codex", plan: "ChatGPT Plus", windows: [{ label: "Weekly", usedPercent: 10, resetsAt: "2030-01-01T00:00:00Z" }] }]);
  const out = run(home, "detect", "--json", "--usage-file", u);
  for (const secret of ["sk-SECRET-KEY", "hunter2", "--secret-arg"]) assert.ok(!out.includes(secret), `printed ${secret}`);
  const d = JSON.parse(out);
  const codex = d.instances.find((i) => i.id === "codex");
  assert.equal(codex.home, "~/.codex");
  assert.equal(codex.plan, "ChatGPT Plus");
  assert.equal(d.instances.find((i) => i.id === "codex_old").enabled, false);
  assert.ok(!run(home, "detect", "--usage-file", u).includes("sk-SECRET-KEY"));
});

test("draft picks the lead, the worker profile and the Codex accounts", () => {
  const home = fakeHome(instances);
  const { json, md } = JSON.parse(run(home, "draft", "--json", "--no-usage"));
  assert.deepEqual(json.claude, { configDir: "~/.claude_work", t3Instance: "claudeAgent_work", t3WorkerInstance: "claudeAgent_work_workers" });
  assert.equal(json.codex.default, "main");
  assert.deepEqual(json.codex.accounts.map((a) => [a.name, a.home, a.t3Instance]), [["main", "~/.codex", "codex"], ["spare", "~/.codex_spare", "codex_spare"]]);
  assert.match(md, /Disabled in T3, so not used: `codex_old`/);
});

test("a fresh T3 with no instances in settings gets the built-in defaults", () => {
  const home = fakeHome(null);
  const { json } = JSON.parse(run(home, "draft", "--json", "--no-usage"));
  assert.deepEqual(json.claude, { configDir: "~/.claude", t3Instance: "claudeAgent", t3WorkerInstance: "claudeAgent" });
  assert.deepEqual(json.codex.accounts, [{ name: "main", home: "~/.codex", t3Instance: "codex", reserve: false }]);
});

test("draft --write keeps an existing file unless --force", () => {
  const home = fakeHome(instances);
  const dir = path.join(home, "accounts");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "accounts.local.json"), "{\"mine\":true}\n");
  const out = run(home, "draft", "--write", "--no-usage");
  assert.match(out, /kept .*accounts\.local\.json/);
  assert.match(out, /wrote .*accounts\.local\.md/);
  assert.equal(fs.readFileSync(path.join(dir, "accounts.local.json"), "utf8"), "{\"mine\":true}\n");
  run(home, "draft", "--write", "--force", "--no-usage");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "accounts.local.json"), "utf8")).claude.t3Instance, "claudeAgent_work");
});

test("install.sh --only links the picks, setup and subagents, and unlinks the rest", () => {
  const home = fakeHome(null);
  const sh = (...args) => execFileSync("bash", [install, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const links = () => fs.readdirSync(path.join(home, ".agents/skills")).sort();
  sh();
  assert.ok(links().includes("takeover"));
  sh("--only", "pacing");
  assert.deepEqual(links(), ["pacing", "setup", "subagents"]);
  assert.deepEqual(fs.readdirSync(path.join(home, ".claude/skills")).sort(), ["pacing", "setup", "subagents"]);
  assert.match(run(home, "check"), /Skills linked: pacing, setup, subagents/);
});

test("disabled built-in accounts are a problem, and --write refuses", () => {
  const home = fakeHome({
    claudeAgent: { driver: "claudeAgent", enabled: false, config: {} },
    codex: { driver: "codex", enabled: false, config: {} },
  });
  const { problems } = JSON.parse(run(home, "draft", "--json", "--no-usage"));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /No Claude account is on in T3 \(off: claudeAgent\)/);
  assert.throws(() => run(home, "draft", "--write", "--no-usage"), (e) => e.status === 1 && /Not written/.test(e.stdout));
  assert.ok(!fs.existsSync(path.join(home, "accounts/accounts.local.json")));
});

test("Codex account names stay unique", () => {
  const home = fakeHome({
    codex_main: { driver: "codex", enabled: true, config: { shadowHomePath: "~/.codex_main" } },
    codex: { driver: "codex", enabled: true, config: {} },
    claudeAgent: { driver: "claudeAgent", enabled: true, config: {} },
  });
  const { json } = JSON.parse(run(home, "draft", "--json", "--no-usage"));
  const names = json.codex.accounts.map((a) => a.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(json.codex.accounts.find((a) => a.t3Instance === "codex").name, "main");
});

test("install.sh keeps links and folders it doesn't own", () => {
  const home = fakeHome(null);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "other-skill-"));
  fs.mkdirSync(path.join(home, ".agents/skills"), { recursive: true });
  fs.symlinkSync(other, path.join(home, ".agents/skills/pacing"));
  fs.mkdirSync(path.join(home, ".claude/skills/subagents"), { recursive: true });
  execFileSync("bash", [install, "--only", "pacing"], { encoding: "utf8", env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(fs.readlinkSync(path.join(home, ".agents/skills/pacing")), other);
  assert.ok(fs.lstatSync(path.join(home, ".claude/skills/subagents")).isDirectory());
  assert.ok(fs.lstatSync(path.join(home, ".agents/skills/subagents")).isSymbolicLink());
  execFileSync("bash", [install, "--only", "takeover"], { env: { ...process.env, HOME: home }, stdio: "ignore" });
  assert.equal(fs.readlinkSync(path.join(home, ".agents/skills/pacing")), other);
});
