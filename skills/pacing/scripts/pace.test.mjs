// node --test skills/pacing/scripts/pace.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "pace.mjs");
const reset = "2026-01-01T05:00:00.000Z"; // session window 00:00 → 05:00
const usage = (used) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pace-")), "u.json");
  fs.writeFileSync(f, JSON.stringify([{ instance: "claude", windows: [
    { label: "Session", usedPercent: used, resetsAt: reset },
    { label: "Weekly · Fable", usedPercent: 90, resetsAt: reset },
    { label: "Weekly", usedPercent: 50, resetsAt: "2026-01-04T12:00:00.000Z" }] }]));
  return f;
};
const run = (used, at, ...extra) => JSON.parse(execFileSync("node", [script, ...extra, "--json", "--instance", "claude",
  "--usage-file", usage(used), "--now", String(Date.parse(at)), "--margin", "0"], { encoding: "utf8" }));

test("halfway through the window, 50% is on pace", () => {
  const r = run(50, "2026-01-01T02:30:00Z");
  assert.equal(r.line, 50);
  assert.equal(r.state, "on");
});

test("over the line by more than the band is over", () => {
  assert.equal(run(70, "2026-01-01T02:30:00Z").state, "over");
});

test("well under the line is under", () => {
  assert.equal(run(20, "2026-01-01T02:30:00Z").state, "under");
});

test("the margin pulls the line forward", () => {
  // 10 min margin: 150 of 290 spendable minutes gone → 52%
  assert.equal(run(50, "2026-01-01T02:30:00Z", "--margin", "10").line, 52);
});

test("weekly picks the plain Weekly window, not a per-model one", () => {
  const r = run(0, "2025-12-31T00:00:00Z", "--window", "weekly");
  assert.equal(r.used, 50);
});

test("unknown instance exits 2 with the instances listed", () => {
  assert.throws(() => execFileSync("node", [script, "--instance", "nope", "--usage-file", usage(1)], { stdio: "pipe" }),
    (e) => e.status === 2 && /instances: claude/.test(String(e.stderr)));
});
