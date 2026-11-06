#!/usr/bin/env node
// Show plan usage (session / weekly windows) for every Codex, Claude, and AGY
// account, so the lead can pick an account pool before dispatching.
//
//   code/usage.mjs          table
//   code/usage.mjs --json   raw windows per account
//   code/usage.mjs --cached skip the refresh and show T3's last probe
//   code/usage.mjs --no-agy skip AGY (it reads AGY's saved Google login and asks Google)
//   code/usage.mjs --pick-codex gpt-6-sol [--exclude personal]   Codex account to use
//
// Codex/Claude come from T3's internal RPC (server.refreshProviders + getConfig);
// Claude windows come from T3's thread logs (claude-logs.mjs), T3's probe only as fallback;
// AGY comes from Google's Cloud Code quota API. Both undocumented, verified
// 2026-09-27 (T3 server 0.0.43-nightly); the T3 connection is t3-api.mjs's (0.1.0).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { applyClaudeLogs, latestClaudeWindows } from "./claude-logs.mjs";
import { codexAccount, pickCodex } from "./accounts.mjs";
import { t3Connect } from "./t3-api.mjs";

let conn;
try {
  conn = await t3Connect("subagents usage");
} catch (e) {
  if (!e.notRunning) throw e;
  console.error(e.message);
  process.exit(1);
}
// getConfig serves T3's cached probe; refresh first so the numbers are current.
if (!process.argv.includes("--cached")) {
  await conn.request("server.refreshProviders", {}, { timeoutMs: 60000 }).catch((e) => console.error(`refresh failed, showing cached: ${e.message}`));
}
const config = await conn.request("server.getConfig", {}, { timeoutMs: 15000 });
conn.close();

// Claude providers stay in even with no probe windows, or no probe at all (the
// probe can fail, "probeFailed", 2026-10-17; or be missing, 2026-10-22): the
// thread logs below fill them in.
const accounts = config.providers
  .filter((p) => p.usageLimits?.windows?.length || p.instanceId.startsWith("claudeAgent"))
  .map((p) => ({
    instance: p.instanceId,
    plan: p.auth?.label ?? null,
    checkedAt: p.usageLimits?.checkedAt,
    windows: (p.usageLimits?.windows ?? []).map(({ label, usedPercent, resetsAt }) => ({ label, usedPercent, resetsAt: resetsAt ?? null })),
    resetCredits: p.usageLimits?.resetCredits?.availableCount ?? 0,
  }));
// T3's Claude probe goes stale (0%, no reset time); the thread logs carry the live numbers.
applyClaudeLogs(accounts, latestClaudeWindows());
for (let i = accounts.length - 1; i >= 0; i--) if (!accounts[i].windows.length) accounts.splice(i, 1);

// --pick-codex <model-id> [--exclude a,b]: print the Codex account to use
// (rules in accounts.mjs pickCodex). Accounts that already hit a limit this
// run are excluded.
const pickAt = process.argv.indexOf("--pick-codex");
if (pickAt !== -1) {
  const modelId = process.argv[pickAt + 1];
  const exAt = process.argv.indexOf("--exclude");
  const excluded = new Set(exAt === -1 ? [] : (process.argv[exAt + 1] ?? "").split(",").filter(Boolean));
  const hasModel = (name) => {
    try {
      const data = JSON.parse(fs.readFileSync(`${codexAccount(name).home}/models_cache.json`, "utf8"));
      const models = Array.isArray(data) ? data : data.models ?? [];
      return !modelId || models.some((m) => m.slug === modelId);
    } catch { return false; }
  };
  const pick = pickCodex(accounts, excluded, hasModel);
  if (!pick) { console.error(`no Codex account has room for ${modelId ?? "any model"}`); process.exit(3); }
  console.log(pick);
  process.exit(0);
}

// AGY isn't in T3's limits, so ask Google's Cloud Code API directly with AGY's
// own cached OAuth token (the same retrieveUserQuotaSummary call AGY's /usage makes).
async function agyUsage() {
  const tokenFile = `${os.homedir()}/.gemini/antigravity-cli/antigravity-oauth-token`;
  const read = () => JSON.parse(fs.readFileSync(tokenFile, "utf8")).token;
  let tok = read();
  if (Date.parse(tok.expiry) < Date.now() + 60000) {
    // Any authenticated agy call refreshes and rewrites the token file.
    execFileSync("agy", ["models"], { stdio: "ignore", timeout: 60000 });
    tok = read();
  }
  const post = async (method, body) => {
    const r = await fetch(`https://cloudcode-pa.googleapis.com/v1internal:${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", "user-agent": "antigravity" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    return r.json();
  };
  const assist = await post("loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } });
  const project = assist.cloudaicompanionProject?.id ?? assist.cloudaicompanionProject;
  const summary = await post("retrieveUserQuotaSummary", { project });
  return {
    instance: "antigravity",
    plan: assist.paidTier?.name ?? assist.currentTier?.name ?? null,
    checkedAt: new Date().toISOString(),
    windows: summary.groups.filter((g) => /gemini/i.test(g.displayName)).flatMap((g) => g.buckets.map((b) => ({
      label: `${b.window === "5h" ? "Session" : "Weekly"} · ${g.displayName.replace(/ models$/i, "")}`,
      order: b.window === "5h" ? 0 : 1,
      usedPercent: Math.round((1 - b.remainingFraction) * 100),
      resetsAt: b.resetTime ?? null,
    })).sort((x, y) => x.order - y.order)).map(({ order, ...w }) => w),
    resetCredits: 0,
  };
}
if (!process.argv.includes("--no-agy")) {
  try {
    accounts.push(await agyUsage());
  } catch (err) {
    console.error(`antigravity: could not read limits (${err.message})`);
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(accounts, null, 2));
  process.exit(0);
}

const until = (iso) => {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  return mins >= 1440 ? `resets in ${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
    : `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
};
const width = Math.max(...accounts.flatMap((a) => a.windows.map((w) => w.label.length)));
for (const a of accounts) {
  const credits = a.resetCredits ? `, ${a.resetCredits} reset credit${a.resetCredits > 1 ? "s" : ""}` : "";
  console.log(`${a.instance} (${a.plan ?? "unknown plan"}${credits}; checked ${new Date(a.checkedAt).toLocaleTimeString()}${a.source ? ` · from ${a.source}` : ""})`);
  for (const w of a.windows) {
    console.log(`  ${w.label.padEnd(width)} ${String(w.usedPercent).padStart(3)}% used  ${String(100 - w.usedPercent).padStart(3)}% left  ${until(w.resetsAt)}`);
  }
}
