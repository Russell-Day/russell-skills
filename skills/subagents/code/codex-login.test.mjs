import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// codex-login.mjs: the sign-out mark and its clearing (this copy sends no text).
const here = path.dirname(new URL(import.meta.url).pathname);
const script = path.join(here, "codex-login.mjs");

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-login-"));
  fs.mkdirSync(path.join(dir, ".codex"));
  const env = { ...process.env, HOME: dir };
  delete env.CODEX_LOGIN_STATE_DIR;
  const cli = (args) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 30000 });
  const file = (name) => path.join(dir, ".local/state/agent-stats/codex_signed_out", `${name}.json`);
  return {
    dir, cli,
    mark: (name) => { try { return JSON.parse(fs.readFileSync(file(name), "utf8")); } catch { return null; } },
    list: () => JSON.parse(cli(["list"]).stdout),
  };
}
const ERR = "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.\nmore detail";

test("mark: first line of the error; a second mark keeps the first", () => {
  const h = home();
  const r = h.cli(["mark", "main", path.join(h.dir, ".codex"), ERR]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex account main marked signed out at /);
  const m = h.mark("main");
  assert.deepEqual(Object.keys(m).sort(), ["at", "error", "home"]);
  assert.equal(m.error, ERR.split("\n")[0]);
  h.cli(["mark", "main", path.join(h.dir, ".codex"), "not logged in"]);
  assert.deepEqual(h.mark("main"), m);
  assert.deepEqual(Object.keys(h.list()), ["main"]);
});

test("a login (auth.json newer than the mark) ends it; `ok` ends it", () => {
  const h = home();
  h.cli(["mark", "main", path.join(h.dir, ".codex"), ERR]);
  const auth = path.join(h.dir, ".codex/auth.json");
  fs.writeFileSync(auth, "{}");
  fs.utimesSync(auth, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  assert.deepEqual(Object.keys(h.list()), ["main"], "an older auth.json (the failed refresh didn't touch it) keeps the mark");
  fs.utimesSync(auth, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.deepEqual(h.list(), {});
  assert.equal(h.mark("main"), null, "removed on read");
  h.cli(["mark", "second", path.join(h.dir, ".codex_second"), ERR]);
  assert.match(h.cli(["ok", "second"]).stdout, /mark cleared/);
  assert.match(h.cli(["ok", "second"]).stdout, /no mark/);
});

test("bad input: usage exit 2; a name with a slash is refused, not written", () => {
  const h = home();
  assert.equal(h.cli(["mark", "main"]).status, 2);
  assert.match(h.cli(["mark", "../x", h.dir, ERR]).stdout, /bad Codex account name/);
  assert.equal(fs.existsSync(path.join(h.dir, ".local/state/agent-stats/x.json")), false);
});

test("codexLoginRe: the login phrases, not limits, network errors or timeouts", async () => {
  const { codexLoginRe } = await import(script);
  for (const t of [ERR, "Your refresh token expired",
    "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
    "Your authentication session could not be refreshed automatically."]) assert.ok(codexLoginRe.test(t), t);
  for (const t of ["You've hit your usage limit.", "stream disconnected before completion: error sending request", "401 Unauthorized", "Timed out after 600 s",
    "MCP server tedi: not logged in to Canvas", "gh: You are not logged in to any GitHub hosts",
    "the token could not be refreshed: error sending request"]) assert.ok(!codexLoginRe.test(t), t);
});
