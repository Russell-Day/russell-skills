#!/usr/bin/env node
// Codex sign-out marks. A Codex account whose login expired
// ("refresh token has expired") fails every turn at once; the launcher marks it here and the
// picker (usage.mjs --pick-codex) skips it until you sign it in again. This copy sends no text
// (a project copy may add one); the launcher logs each sign-out in run.log and limits.log.
//
// One file per account in ~/.local/state/agent-stats/codex_signed_out/<name>.json:
//   { at, home, error }
// created with a hard link, so racing jobs share the first job's mark.
// A mark clears when <home>/auth.json is newer than `at` (`codex login` rewrites it; a failed
// refresh doesn't), checked on every read, or when a Codex run on the account ends rc 0 (`ok`).
//
//   node codex-login.mjs mark <name> <home> <error...>   mark it signed out; prints what happened, never fails
//   node codex-login.mjs ok <name>                       it ran: clear the mark
//   node codex-login.mjs list                            JSON {name: mark} of the marks still in force
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The provider's own error text for a dead login, never a usage limit or a network error. Match
// only thread.lastError (a reply can quote anything).
// Only the provider's own sentences: a bare "not logged in" or "could not be refreshed" is also
// what an MCP server or a network error can say.
export const codexLoginRe = /refresh token (has )?expired|(access token|authentication session) could not be refreshed|log out and sign in again/i;

const stateDir = () => process.env.CODEX_LOGIN_STATE_DIR ?? path.join(os.homedir(), ".local/state/agent-stats/codex_signed_out");
const markFile = (name) => {
  if (!/^[\w.-]+$/.test(name ?? "")) throw new Error(`bad Codex account name: ${name}`);
  return path.join(stateDir(), `${name}.json`);
};
const firstLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? "";

function readMark(name) {
  try { return JSON.parse(fs.readFileSync(markFile(name), "utf8")); } catch { return null; }
}
// A login after the mark (auth.json rewritten) ends it.
function stale(mark) {
  try { return fs.statSync(path.join(mark.home, "auth.json")).mtimeMs > Date.parse(mark.at); } catch { return false; }
}

// The mark still in force for `name`, or null; a stale one is removed.
export function signedOut(name) {
  const mark = readMark(name);
  if (!mark) return null;
  if (!stale(mark)) return mark;
  fs.rmSync(markFile(name), { force: true });
  return null;
}

export function listMarks() {
  let names = [];
  try { names = fs.readdirSync(stateDir()).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)); } catch { return {}; }
  return Object.fromEntries(names.map((n) => [n, signedOut(n)]).filter(([, m]) => m));
}

// It ran (rc 0): the next sign-out marks and texts again. True when a mark was removed.
export function loginOk(name) {
  const file = markFile(name);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export const loginHint = (name, home) => `codex account ${name} is signed out: run CODEX_HOME=${home} codex login`;

// Mark `name` signed out (the first job's mark wins). Returns what happened.
export function markSignedOut(name, home, error, now = Date.now()) {
  const file = markFile(name);
  // An account the caller can't place: a mark would test a relative auth.json (S2 review F6).
  if (!path.isAbsolute(home ?? "")) return `codex account ${name}: no home known, not marked`;
  fs.mkdirSync(stateDir(), { recursive: true });
  let mark = signedOut(name);
  if (!mark) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date(now).toISOString(), home, error: firstLine(error) }));
    try { fs.linkSync(tmp, file); } catch (e) { if (e.code !== "EEXIST") throw e; } finally { fs.rmSync(tmp, { force: true }); }
    mark = readMark(name);
    if (!mark) return `codex account ${name}: mark cleared while writing it`;
  }
  return `codex account ${name} marked signed out at ${mark.at}`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, name, home, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "mark" && name && home) console.log(markSignedOut(name, home, rest.join(" ")));
    else if (cmd === "ok" && name) console.log(loginOk(name) ? `codex account ${name}: sign-out mark cleared` : `codex account ${name}: no mark`);
    else if (cmd === "list") console.log(JSON.stringify(listMarks(), null, 2));
    else { console.error("usage: codex-login.mjs mark <name> <home> <error...> | ok <name> | list"); process.exit(2); }
  } catch (e) { console.log(`codex login state: ${e.message}`); }
}
