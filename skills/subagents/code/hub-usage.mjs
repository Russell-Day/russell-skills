// Claude logins pooled in a CLIProxyAPI hub. A Claude Code instance that runs through the hub
// (its config home's settings.json sets env.ANTHROPIC_BASE_URL to the hub) signs in with the
// hub's client key, so T3's usage probe and the thread logs can't read its account any more.
// The hub can: its management API lists each login (auth-files) and calls Anthropic's usage
// endpoint with that login (api-call), the same calls T3's "CLIProxyAPI hub" usage source makes.
//
// accounts.local.json `hub`: { "url": "http://127.0.0.1:8317", "managementKeyFile": "<file holding
// the hub's management key>" }. No `hub` entry: nothing changes.
//
// Each hub Claude login becomes a row "hub:<email>"; each instance that runs through the hub gets
// the windows of the hub's primary login (highest priority, then the first listed), which is the
// one the hub answers with while it has room.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expand = (p) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const normal = (url) => String(url ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");

// The `hub` entry of $ACCOUNTS_FILE or accounts.local.json, or null.
export function hubConfig() {
  const files = process.env.ACCOUNTS_FILE ? [path.resolve(process.env.ACCOUNTS_FILE)] : [path.join(root, "accounts.local.json")];
  for (const file of files) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")).hub ?? null; } catch { /* no file: no hub */ }
  }
  return null;
}

// Instances whose config home points Claude Code at the hub. `homes`: instance -> home (claudeHomes()).
export function hubInstances(homes, hubUrl, read = (f) => fs.readFileSync(f, "utf8")) {
  const want = normal(hubUrl);
  return Object.entries(homes).filter(([, home]) => {
    try { return normal(JSON.parse(read(path.join(expand(home), "settings.json"))).env?.ANTHROPIC_BASE_URL) === want; }
    catch { return false; }
  }).map(([instance]) => instance);
}

// Anthropic's usage body -> T3-style windows (percent used).
export function usageWindows(body) {
  const out = [];
  const add = (label, w) => { if (typeof w?.utilization === "number") out.push({ label, usedPercent: Math.round(w.utilization), resetsAt: w.resets_at ?? null }); };
  add("Session", body.five_hour);
  add("Weekly", body.seven_day);
  for (const l of body.limits ?? []) {
    const name = l.scope?.model?.display_name;
    if (l.kind === "weekly_scoped" && name && typeof l.percent === "number") out.push({ label: `Weekly · ${name}`, usedPercent: Math.round(l.percent), resetsAt: l.resets_at ?? null });
  }
  return out;
}

// The hub's Claude logins with their windows, primary first:
// [{ email, priority, windows }]; a login whose read failed has windows [] and an error.
export async function hubClaudeAccounts(hub, fetchImpl = fetch) {
  const key = fs.readFileSync(expand(hub.managementKeyFile), "utf8").trim();
  const base = `${normal(hub.url)}/v0/management`;
  const call = async (route, body) => {
    const r = await fetchImpl(`${base}/${route}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`hub ${route}: HTTP ${r.status}`);
    return r.json();
  };
  const files = ((await call("auth-files")).files ?? []).filter((f) => f.provider === "claude" && !f.disabled);
  const rows = await Promise.all(files.map(async (f, i) => {
    const row = { email: f.email ?? f.id, priority: Number(f.priority ?? 0) || 0, order: i, windows: [] };
    try {
      const res = await call("api-call", {
        auth_index: f.auth_index,
        method: "GET",
        url: USAGE_URL,
        header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.273" },
      });
      if (res.status_code < 200 || res.status_code >= 300) throw new Error(`usage: HTTP ${res.status_code}`);
      row.windows = usageWindows(JSON.parse(res.body));
    } catch (err) { row.error = err.message; }
    return row;
  }));
  return rows.sort((a, b) => b.priority - a.priority || a.order - b.order).map(({ order, ...r }) => r);
}

// Adds the hub rows to `accounts` and gives each hub instance the primary login's windows.
export function applyHub(accounts, hubRows, instances, now = new Date().toISOString()) {
  const primary = hubRows.find((r) => r.windows.length);
  for (const r of hubRows) {
    if (!r.windows.length) continue;
    accounts.push({ instance: `hub:${r.email}`, plan: `Claude via hub${r === primary ? ", primary" : ""}`, checkedAt: now, windows: r.windows, resetCredits: 0, source: "hub" });
  }
  if (!primary) return;
  for (const instance of instances) {
    const row = { instance, plan: `Claude via hub (${primary.email})`, checkedAt: now, windows: primary.windows, resetCredits: 0, source: "hub" };
    const at = accounts.findIndex((a) => a.instance === instance);
    if (at === -1) accounts.push(row); else accounts[at] = row;
  }
}

// usage.mjs entry: read the hub when accounts.local.json has one; a failure is reported, not fatal.
export async function addHubUsage(accounts, homes) {
  const hub = hubConfig();
  if (!hub?.url || !hub?.managementKeyFile) return;
  try {
    applyHub(accounts, await hubClaudeAccounts(hub), hubInstances(homes, hub.url));
  } catch (err) {
    console.error(`hub: could not read Claude usage (${err.message})`);
  }
}
