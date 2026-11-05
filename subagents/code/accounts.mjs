#!/usr/bin/env node
// This machine's account setup: Claude config dir and T3 profiles, Codex
// accounts (home, T3 instance, reserve flag), extra job roots. Read from $ACCOUNTS_FILE, else
// accounts.local.json at the repo root, else accounts.example.json.
//
//   node accounts.mjs codex-home <name>   absolute CODEX_HOME for an account
//   node accounts.mjs codex-default       account used when ACCOUNT is unset
//   node accounts.mjs codex-fallback      account auto mode uses when usage.mjs fails
//   node accounts.mjs claude-config-dir   absolute CLAUDE_CONFIG_DIR
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expand = (p) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

function load() {
  // ACCOUNTS_FILE overrides (the test suites point it at testdata/accounts.test.json).
  if (process.env.ACCOUNTS_FILE) return JSON.parse(fs.readFileSync(path.resolve(process.env.ACCOUNTS_FILE), "utf8"));
  for (const name of ["accounts.local.json", "accounts.example.json"]) {
    try { return JSON.parse(fs.readFileSync(path.join(root, name), "utf8")); }
    catch (e) { if (e.code !== "ENOENT") throw new Error(`${name}: ${e.message}`); }
  }
  throw new Error(`no accounts.local.json or accounts.example.json in ${root}`);
}

const raw = load();
export const claude = {
  configDir: expand(raw.claude.configDir),
  t3Instance: raw.claude.t3Instance,
  t3WorkerInstance: raw.claude.t3WorkerInstance ?? raw.claude.t3Instance,
};
// Extra dispatcher job roots besides AGENT_JOBS_DIR, e.g. a project's own copy of this skill.
export const extraJobRoots = (raw.jobRoots ?? []).map(expand);
export const codexAccounts = raw.codex.accounts.map((a) => ({ ...a, home: expand(a.home), reserve: !!a.reserve }));
export const codexDefault = raw.codex.default;
export const codexAccount = (name) => codexAccounts.find((a) => a.name === name);
export const codexByInstance = (instance) => codexAccounts.find((a) => a.t3Instance === instance);
// With no usage data, auto mode starts on the reserve (it has the most room), else the default.
export const codexFallback = codexAccounts.find((a) => a.reserve)?.name ?? codexDefault;

// Codex account to use: non-reserve accounts first, soonest weekly reset first,
// since their unused quota is lost first; skip any with a window at >= 90% used.
// Reserve accounts only once those are all low (a reserve may go to 95%).
// `accounts` are usage.mjs rows; `hasModel(name)` checks the account's catalog.
export function pickCodex(accounts, excluded, hasModel) {
  const weeklyReset = (a) => Date.parse(a.windows.find((w) => /weekly/i.test(w.label))?.resetsAt ?? "") || Infinity;
  const usable = (a, cap) => a.windows.every((w) => w.usedPercent < cap);
  const candidates = accounts
    .map((a) => ({ ...a, account: codexByInstance(a.instance) }))
    .filter((a) => a.account && !excluded.has(a.account.name) && hasModel(a.account.name));
  const main = candidates.filter((a) => !a.account.reserve && usable(a, 90))
    .sort((x, y) => weeklyReset(x) - weeklyReset(y));
  const reserve = candidates.filter((a) => a.account.reserve && usable(a, 95));
  return (main[0] ?? reserve[0])?.account.name ?? null;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "codex-home") {
    const a = codexAccount(arg);
    if (!a) { console.error(`unknown ACCOUNT: ${arg}`); process.exit(2); }
    console.log(a.home);
  } else if (cmd === "codex-default") console.log(codexDefault);
  else if (cmd === "codex-fallback") console.log(codexFallback);
  else if (cmd === "claude-config-dir") console.log(claude.configDir);
  else { console.error("usage: accounts.mjs codex-home <name> | codex-default | codex-fallback | claude-config-dir"); process.exit(2); }
}
