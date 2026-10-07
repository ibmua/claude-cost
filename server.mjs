#!/usr/bin/env node
// Tiny dashboard: dollar cost of every past Claude Code session.
// Scans ~/.claude/projects/**/*.jsonl, prices tokens per model, serves a page.
//   node server.mjs            -> http://localhost:8799
//   PORT=9000 node server.mjs

import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, createReadStream, realpathSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join, resolve, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";

const ROOT = join(homedir(), ".claude", "projects");
const CODEX_ROOT = join(homedir(), ".codex", "sessions");
const PORT = process.env.PORT || 8799;

// === Agent mode (how REMOTE machines are indexed) ==========================
// `node server.mjs --agent` (with the config in $CC_AGENT_B64) does NOT start a
// server. It scans the roots named in that config ON THIS HOST and prints the
// compact session rows as JSON to stdout.
//
// That is the whole mechanism for indexing another computer: the dashboard ssh's
// in, copies THIS FILE over, runs it in agent mode there, and reads back only the
// summary. Transcripts stay on the remote host to avoid duplicating large private
// datasets on the dashboard machine; see collectRemote().
const AGENT = process.argv.includes("--agent");
const AGENT_CFG = AGENT
  ? JSON.parse(Buffer.from(process.env.CC_AGENT_B64 || "", "base64").toString("utf8") || "{}")
  : null;
// In agent mode stdout IS the JSON payload, so every diagnostic has to go to
// stderr — one stray console.log ("[cache] loaded N files…") corrupts the parse
// on the dashboard side.
if (AGENT) console.log = (...a) => console.error(...a);

// `readline` uses regexp-based line splitting. Image-generation rollouts can
// contain multi-megabyte base64 JSONL records, which made V8 flatten giant
// strings and allocate gigabytes. This iterator splits UTF-8 chunks by a plain
// newline search and joins only the current line once.
async function* readLines(file) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 256 * 1024 });
  let parts = [];
  for await (const chunk of stream) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", start);
      if (nl < 0) { if (start < chunk.length) parts.push(chunk.slice(start)); break; }
      parts.push(chunk.slice(start, nl));
      yield parts.length === 1 ? parts[0] : parts.join("");
      parts = []; start = nl + 1;
    }
  }
  if (parts.length) yield parts.length === 1 ? parts[0] : parts.join("");
}

// === Session names ==========================================================
// User-given labels for sessions, keyed by the same `machine|source|id` key
// the client uses (sessionKey()). Stored locally, never synced/committed.
const NAMES_FILE = join(import.meta.dirname, "local", "session-names.json");
function loadNames() {
  try { return JSON.parse(readFileSync(NAMES_FILE, "utf8")); } catch { return {}; }
}
function saveNames(names) {
  writeFileSync(NAMES_FILE, JSON.stringify(names, null, 1));
}

// === Machines =============================================================
// Sessions are indexed per "machine". The local machine is built in; extra
// machines come from an OPTIONAL, gitignored ./machines.local.mjs:
//   export const machines = [
//     { id: "name", label: "🖥 name",
//       claudeRoot: "/abs/path/to/synced/claude/projects",
//       codexRoots: ["/abs/path/to/synced/codex/sessions"], // or legacy codexRoot
//       syncCmd: "/abs/path/to/sync-script.sh",   // optional
//       syncIntervalSec: 600 },                    // optional, default 600
//   ];
// `syncCmd` is kicked off in the background (fire-and-forget) at most once
// per interval before scanning — e.g. an rsync wrapper that pulls another
// computer's logs into a local cache dir. Host names, paths, and scripts all
// live in the gitignored file, so the repo stays free of private details.
const MACHINES = [{ id: "local", label: "💻 local", claudeRoot: ROOT, codexRoot: CODEX_ROOT }];
// Agent mode scans exactly the roots it was handed, so it must NOT load the
// dashboard's machine list (which the remote host doesn't have anyway).
if (!AGENT) {
  try {
    const ext = await import("./machines.local.mjs");
    // Host-local durable ledgers belong to the built-in local machine. This is
    // intentionally separate from `machines`: adding a local source must not
    // create a fake second machine in the UI.
    if (ext.local && typeof ext.local === "object") Object.assign(MACHINES[0], ext.local);
    for (const m of ext.machines || []) if (m && m.id) MACHINES.push(m);
  } catch {}
}

// === Live subscription usage (rate-limit buckets) ==========================
// The dollar figures on this dashboard are ESTIMATED API-equivalent cost — they
// are NOT what throttles you. On a Max subscription what actually runs out is a
// rolling 5-hour + 7-day *rate-limit bucket*, tracked per logged-in account.
// This panel shows those real buckets, queried read-only ($0) from Anthropic's
// OAuth usage endpoint (same data as `/usage` in the app).
//
// Config-driven & dynamic: we auto-discover every Claude config dir under $HOME
// that holds a `.credentials.json` (default `~/.claude`, `~/.claude-secondary`, …).
// Override the list with CLAUDE_COST_CRED_DIRS=/abs/a:/abs/b (colon-separated).
function discoverCredDirs() {
  const override = process.env.CLAUDE_COST_CRED_DIRS;
  if (override) return override.split(":").map((s) => s.trim()).filter(Boolean);
  const dirs = [];
  try {
    for (const name of readdirSync(homedir())) {
      if (name !== ".claude" && !name.startsWith(".claude-")) continue;
      const p = join(homedir(), name);
      try { statSync(join(p, ".credentials.json")); dirs.push(p); } catch {}
    }
  } catch {}
  return dirs;
}

// The local machine scans EVERY account's config dir (~/.claude, ~/.claude-secondary,
// …), not just the default — so sessions launched under a second account are
// indexed and can be attributed to it. Each root carries its config dir so the
// scan can tag sessions with the resolved account (DIR_ACCOUNT[dir]).
{
  const roots = [];
  const seen = new Set();
  // Dedupe by the RESOLVED path — several config dirs symlink their projects/ to
  // the same place (e.g. lean copies: ~/.claude-lean/projects -> ~/.claude/
  // projects), which would otherwise scan every session twice.
  const add = (dir, root) => {
    let real; try { real = realpathSync(root); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real); roots.push({ dir, root });
  };
  add(join(homedir(), ".claude"), ROOT);
  for (const d of discoverCredDirs()) add(d, join(d, "projects"));
  MACHINES[0].claudeRoots = roots;
}

const OAUTH_BETA = "anthropic-beta";
const OAUTH_BETA_VAL = "oauth-2025-04-20";
// config dir -> short account name (email prefix), resolved from /profile. Used
// to tag each session with WHICH account it was launched under (multi-account).
// The dir names lie / drift, so /profile is the only truth (see ~/CLAUDE.md).
// PERSISTED to disk: the OAuth /profile endpoint is tightly rate-limited and
// often 429s, so we remember the last-known mapping and only overwrite on a
// fresh successful resolve — otherwise attribution flickers to null on every 429.
const DIR_ACCOUNT_FILE = join(import.meta.dirname, "local", "dir-accounts.json");
const DIR_ACCOUNT = (() => { try { return JSON.parse(readFileSync(DIR_ACCOUNT_FILE, "utf8")); } catch { return {}; } })();
function saveDirAccounts() { try { writeFileSync(DIR_ACCOUNT_FILE, JSON.stringify(DIR_ACCOUNT, null, 1)); } catch {} }
async function fetchAccountUsage(dir) {
  let token;
  try {
    token = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"))
      ?.claudeAiOauth?.accessToken;
  } catch { return { dir, error: "no readable .credentials.json" }; }
  // A logged-out config dir keeps its .credentials.json but blanks the tokens
  // (accessToken:"", expiresAt:0). That is a normal state, not a broken install —
  // say so, instead of the old "no oauth access token in this dir" mystery.
  if (!token) return { dir, error: "logged out — run `claude` in this dir to sign in", loggedOut: true };
  const hdr = { Authorization: `Bearer ${token}`, [OAUTH_BETA]: OAUTH_BETA_VAL };
  const getJson = async (url) => {
    const r = await fetch(url, { headers: hdr });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  try {
    const [prof, usage] = await Promise.all([
      getJson("https://api.anthropic.com/api/oauth/profile"),
      getJson("https://api.anthropic.com/api/oauth/usage"),
    ]);
    // Normalize the rate-limit windows into a flat, forward-compatible list.
    // The `limits` array is the clean source (session=5h, weekly_all, and the
    // dynamic per-model `weekly_scoped` entries e.g. Fable). We also fold in any
    // named `seven_day_<model>` top-level buckets that carry a utilization.
    const windows = [];
    const pushWin = (key, label, pct, resets, severity) => {
      if (pct == null) return;
      windows.push({ key, label, pct, resets: resets ?? null, severity: severity ?? null });
    };
    // Prefer the structured `limits` array when present.
    const lim = Array.isArray(usage?.limits) ? usage.limits : [];
    if (lim.length) {
      for (const L of lim) {
        const model = L?.scope?.model?.display_name || null;
        let label;
        if (L.kind === "session") label = "5-hour";
        else if (L.kind === "weekly_all") label = "Weekly · all";
        else if (L.kind === "weekly_scoped") label = `Weekly · ${model || "scoped"}`;
        else label = L.kind + (model ? ` · ${model}` : "");
        pushWin(L.kind + (model ? ":" + model : ""), label, L.percent ?? null, L.resets_at, L.severity);
      }
    } else {
      // Fallback for payloads without the `limits` array.
      pushWin("session", "5-hour", usage?.five_hour?.utilization, usage?.five_hour?.resets_at);
      pushWin("weekly_all", "Weekly · all", usage?.seven_day?.utilization, usage?.seven_day?.resets_at);
    }
    // Named per-model weekly buckets that aren't already covered by weekly_scoped.
    for (const [k, v] of Object.entries(usage || {})) {
      if (!/^seven_day_(opus|sonnet|haiku|fable)$/.test(k)) continue;
      if (v?.utilization == null) continue;
      const model = k.split("_").pop();
      const label = `Weekly · ${model[0].toUpperCase() + model.slice(1)}`;
      if (windows.some((w) => w.label === label)) continue;
      pushWin(k, label, v.utilization, v.resets_at);
    }
    const shortAcct = (prof?.account?.email ?? "").split("@")[0];
    if (shortAcct && DIR_ACCOUNT[dir] !== shortAcct) { DIR_ACCOUNT[dir] = shortAcct; saveDirAccounts(); }
    return {
      dir,
      email: prof?.account?.email ?? null,
      uuid: (prof?.account?.uuid ?? "").slice(0, 8) || null,
      tier: prof?.organization?.rate_limit_tier ?? null,
      fiveHour: { pct: usage?.five_hour?.utilization ?? null, resets: usage?.five_hour?.resets_at ?? null },
      week: { pct: usage?.seven_day?.utilization ?? null, resets: usage?.seven_day?.resets_at ?? null },
      windows,
    };
  } catch (e) {
    return { dir, email: null, error: String(e.message || e) };
  }
}

// `/api/oauth/usage` is tightly rate-limited — far more so than `/profile`. Two
// things used to guarantee 429s on this panel:
//  1. Several config dirs share ONE credentials file (lean copies symlink it), so
//     every poll fired the SAME account's request 2-3× for identical data. The old
//     dedupe ran on the RESULT (by uuid), i.e. after the wasted calls. We now
//     dedupe on the resolved credentials path BEFORE fetching — one call per login.
//  2. A 90s poll from every open tab, with only a 20s server cache, kept the
//     endpoint hot all day. The buckets move slowly; 90s of staleness costs
//     nothing, and a 429 now backs off for 5 min instead of retrying immediately.
const USAGE_TTL_MS = 90_000;
const USAGE_429_BACKOFF_MS = 300_000;
let _usageCache = { at: 0, data: null };
let _usageBackoffUntil = 0;
// Last GOOD payload per credentials file, so one 429 doesn't blank the panel —
// same rationale as DIR_ACCOUNT above (a limits panel that flickers to "⚠️ HTTP
// 429" is strictly worse than one showing a 4-minute-old bucket, clearly marked).
const _lastGoodUsage = new Map(); // credentials realpath -> { at, acct }
function credKey(dir) {
  const p = join(dir, ".credentials.json");
  try { return realpathSync(p); } catch { return p; }
}
let usagePending = null;
function getUsage() {
  if (!usagePending) usagePending = fetchUsage().finally(() => { usagePending = null; });
  return usagePending;
}
async function fetchUsage() {
  const now = Date.now();
  const ttl = now < _usageBackoffUntil ? USAGE_429_BACKOFF_MS : USAGE_TTL_MS;
  if (_usageCache.data && now - _usageCache.at < ttl) return _usageCache.data;
  // dirs sharing one credentials file share one login AND one server-side bucket.
  const byCred = new Map(); // credentials realpath -> [dirs]
  for (const dir of discoverCredDirs()) {
    const k = credKey(dir);
    if (byCred.has(k)) byCred.get(k).push(dir); else byCred.set(k, [dir]);
  }
  const probed = await Promise.all([...byCred].map(async ([key, dirs]) => {
    const a = await fetchAccountUsage(dirs[0]);
    if (!a.error) {
      _lastGoodUsage.set(key, { at: Date.now(), acct: a });
      // Dirs that share this credentials file are the SAME account — tag them all.
      for (const d of dirs) if (DIR_ACCOUNT[d] !== DIR_ACCOUNT[dirs[0]] && DIR_ACCOUNT[dirs[0]]) {
        DIR_ACCOUNT[d] = DIR_ACCOUNT[dirs[0]]; saveDirAccounts();
      }
      return { ...a, dirs };
    }
    if (/HTTP 429/.test(a.error)) _usageBackoffUntil = Date.now() + USAGE_429_BACKOFF_MS;
    const good = a.loggedOut ? null : _lastGoodUsage.get(key);
    if (good) return { ...good.acct, dirs, staleAt: new Date(good.at).toISOString(), staleReason: a.error };
    return { ...a, dirs };
  }));
  const data = { accounts: probed, fetchedAt: new Date().toISOString() };
  recordLocalQuota(data);
  _usageCache = { at: now, data };
  return data;
}

const _lastSync = new Map(); // machine id -> epoch ms when sync was last kicked
function maybeSync(m) {
  if (!m.syncCmd) return;
  const iv = (m.syncIntervalSec || 600) * 1000;
  if (Date.now() - (_lastSync.get(m.id) || 0) < iv) return;
  _lastSync.set(m.id, Date.now());
  const [shell, flag] = process.platform === "win32" ? ["cmd", "/c"] : ["sh", "-c"];
  execFile(shell, [flag, m.syncCmd], { timeout: 900e3 }, (err) => {
    if (err) console.error(`[sync ${m.id}] ${err.message}`);
  });
}

// === OpenAI / Codex pricing ($ per 1M tokens) ===========================
// Source checked 2026-09-02: https://developers.openai.com/api/docs/models/gpt-5.6-sol
// OpenAI bills: uncached input, cached input (cheaper), output (incl. reasoning).
const OPENAI_PRICES = {
  // https://developers.openai.com/api/docs/models/gpt-6-astra (2026-09-06).
  "gpt-6-astra": { in: 10, cached: 1, out: 50, longContext: { above: 272000, in: 20, cached: 2, out: 75 } },
  // Current GPT-5.6 pricing checked 2026-09-02 from the official Sol/Terra/Luna model pages.
  // Rollouts expose cached_input_tokens, but not a distinct
  // cache-write counter, so the 1.25x explicit cache-write charge cannot yet be separated.
  "gpt-5.6-sol":       { in: 4.00, cached: 0.40,  out: 20.00 },
  "gpt-5.6-terra":     { in: 2.00, cached: 0.20,  out: 12.00 },
  "gpt-5.6-luna":      { in: 0.20, cached: 0.02,  out: 1.20 },
  "gpt-5.5":           { in: 5.00, cached: 0.50,  out: 30.00 },
  "gpt-5.4":           { in: 2.50, cached: 0.25,  out: 15.00 },
  "gpt-5.4-mini":      { in: 0.75, cached: 0.075, out: 4.50 },
  "gpt-5.3-codex":     { in: 2.50, cached: 0.25,  out: 15.00 },
  "gpt-5.2-codex":     { in: 2.50, cached: 0.25,  out: 15.00 },
  "gpt-5":             { in: 1.25, cached: 0.125, out: 10.00 },
  "codex-auto-review": { in: 0.75, cached: 0.075, out: 4.50 },
};
function openaiPrice(m) {
  return OPENAI_PRICES[m] || OPENAI_PRICES[(m || "").replace(/-20\d{6}.*$/, "")] || null;
}

// OpenCode Go / Zen (opencode.ai/zen) models — direct-API calls from configured
// per-call usage ledgers. Like the Claude-Max / ChatGPT-Plus tables here, these are accounting-style
// ESTIMATES at the published pay-as-you-go **OpenCode Zen** rates ($/1,000,000 tokens) — which is what
// the Go dashboard's per-request "Go ($x)" figure is computed from. Sources (fetched 2026-07-18):
// https://opencode.ai/docs/zen/ (most models) and https://opencode.ai/data/moonshot/kimi-k3 (kimi-k3
// $3/$15). This is the ONE place to edit rates — set a model's fields to null to show it TOKENS-ONLY.
// Keys must match ocgoNorm(responseModel): provider prefixes, ":free" tags, -YYYYMMDD suffixes, and the
// Fireworks "5p2"→"5.2" spelling are normalized away (so kimi-k2.6 covers
// "moonshotai/kimi-k2.6-20260420" and glm-5.2 covers "accounts/fireworks/models/glm-5p2").
const OCGO_PRICES = {
  // https://opencode.ai/docs/go/ and /docs/zen/ (2026-09-06); owner Go samples agree.
  "muse-spark-1.3-contributor": { in: 0.10, out: 0.20, cached: 0.002 },
  "muse-spark-1.3-contributor-free": { in: 0, out: 0, cached: 0 },
  "kimi-k3":           { in: 3.00, out: 15.00, cached: 0.30 }, // cached est. (0.1x; not published)
  "kimi-k2.7-code":    { in: 0.95, out: 4.00,  cached: 0.19 },
  "kimi-k2.6":         { in: 0.95, out: 4.00,  cached: 0.16 },
  "kimi-k2.5":         { in: 0.60, out: 3.00,  cached: 0.10 },
  "glm-5.2":           { in: 1.40, out: 4.40,  cached: 0.26 },
  "glm-5.1":           { in: 1.40, out: 4.40,  cached: 0.26 },
  "glm-5":             { in: 1.00, out: 3.20,  cached: 0.20 },
  "deepseek-v4-pro":   { in: 1.74, out: 3.48,  cached: 0.145 },
  "deepseek-v4-flash": { in: 0.14, out: 0.28,  cached: 0.028 },
  "minimax-m3":        { in: 0.30, out: 1.20,  cached: 0.06 },
  "minimax-m2.7":      { in: 0.30, out: 1.20,  cached: 0.06 },
  "minimax-m2.5":      { in: 0.30, out: 1.20,  cached: 0.06 },
  "qwen3.7-max":       { in: 2.50, out: 7.50,  cached: 0.50 },
  "qwen3.7-plus":      { in: 0.40, out: 1.60,  cached: 0.04 },
  "qwen3.6-plus":      { in: 0.50, out: 3.00,  cached: 0.05 },
  "grok-4.5":          { in: 2.00, out: 6.00,  cached: 0.50 }, // ≤200K-token tier
  "hy3":               { in: 0,    out: 0,     cached: 0 },    // tencent/hy3:free — free tier
  // mimo-v2.5-pro / mimo-v2-* are not on the published Zen table → left unpriced (tokens-only).
};
// Normalize a ledger model string to a price-map key: drop provider prefix (moonshotai/…,
// accounts/fireworks/models/…), a ":free"/":tag" suffix, a -YYYYMMDD date/version tail, and the
// Fireworks "5p2"→"5.2" version spelling. NOTE: the ledger stores the UPSTREAM response model, which
// can differ from the endpoint id (e.g. endpoint "hy3-preview" answers as "tencent/hy3:free" → "hy3").
function ocgoNorm(m) {
  return (m || "").toLowerCase().split("/").pop().split(":")[0]
    .replace(/-20\d{6}.*$/, "")
    .replace(/(\d)p(\d)/, "$1.$2");
}
function ocgoPrice(m) {
  const p = OCGO_PRICES[ocgoNorm(m)];
  return p && p.in != null ? p : null;
}

function codexSubagentName(source) {
  const subagent = source?.subagent;
  if (!subagent) return "subagent";
  if (typeof subagent === "string") return subagent;
  if (typeof subagent.other === "string") return subagent.other;
  const spawn = subagent.thread_spawn;
  if (spawn) return spawn.agent_nickname || spawn.agent_role || "thread-spawn";
  for (const value of Object.values(subagent)) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      return value.agent_nickname || value.agent_role || value.kind || "subagent";
    }
  }
  return "subagent";
}

// $ per 1,000,000 tokens. cache read = 0.1x input, cache write(5m) = 1.25x input.
// Fable 5.1 exception checked 2026-09-02: https://platform.claude.com/docs/en/models/fable-5-1/overview
// Its cache reads are 0.025x input; Fable 5 retains the standard 0.1x rate.
// Family prices are the SSOT. PRICES enumerates known IDs for the UI, while
// priceFor() falls back by family so a newly versioned Claude model does not
// silently become a $0 / "?" row before this list is refreshed.
const CLAUDE_FAMILY_PRICES = {
  opus:  { in: 5,  out: 25, cw: 6.25, cr: 0.5 },
  fable: { in: 10, out: 50, cw: 12.5, cr: 0.25 },
  fable5:{ in: 10, out: 50, cw: 12.5, cr: 1.0 },
  sonnet:{ in: 3,  out: 15, cw: 3.75, cr: 0.3 },
  haiku: { in: 1,  out: 5,  cw: 1.25, cr: 0.1 },
};
const PRICES = {
  "claude-opus-5":     CLAUDE_FAMILY_PRICES.opus,
  "claude-opus-4-8":   CLAUDE_FAMILY_PRICES.opus,
  "claude-opus-4-7":   CLAUDE_FAMILY_PRICES.opus,
  "claude-opus-4-6":   CLAUDE_FAMILY_PRICES.opus,
  "claude-opus-4-5":   CLAUDE_FAMILY_PRICES.opus,
  "claude-fable-5-1":  CLAUDE_FAMILY_PRICES.fable,
  "claude-fable-5":    CLAUDE_FAMILY_PRICES.fable5,
  "claude-sonnet-5":   CLAUDE_FAMILY_PRICES.sonnet,
  "claude-sonnet-4-6": CLAUDE_FAMILY_PRICES.sonnet,
  "claude-sonnet-4-5": CLAUDE_FAMILY_PRICES.sonnet,
  "claude-haiku-4-5":  CLAUDE_FAMILY_PRICES.haiku,
  sonnet:                CLAUDE_FAMILY_PRICES.sonnet,
};

// Paths are normalized to forward slashes so the "/subagents/"-style parsing
// below works on Windows too (node's fs APIs accept / on every platform).
// Iterative on purpose. The recursive version did `out.push(...walk(p))`, and
// spreading a large array into push() passes one argument per element, which can
// overflow the stack on large transcript roots and lose an entire machine's rows.
// statSync (not Dirent.isDirectory) is kept deliberately: it FOLLOWS symlinks,
// and lean config dirs symlink their projects/ elsewhere. `seenDirs` keeps that
// from looping forever on a symlink cycle, and an unreadable entry is skipped
// rather than aborting the entire root.
function walk(dir) {
  const out = [];
  const stack = [dir];
  const seenDirs = new Set();
  while (stack.length) {
    const d = stack.pop();
    let names;
    try { names = readdirSync(d); } catch { continue; }
    for (const name of names) {
      const p = join(d, name).replaceAll("\\", "/");
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) {
        let real; try { real = realpathSync(p); } catch { real = p; }
        if (seenDirs.has(real)) continue;
        seenDirs.add(real);
        stack.push(p);
      } else if (name.endsWith(".jsonl")) out.push(p);
    }
  }
  return out;
}

function priceFor(model) {
  const normalized = (model || "").replace(/-\d{8}$/, "");
  const exact = PRICES[model] || PRICES[normalized];
  if (exact) return exact;
  const family = normalized.match(/^claude-(opus|fable|sonnet|haiku)(?:-|$)/)?.[1];
  return family ? CLAUDE_FAMILY_PRICES[family] : null;
}
function costOf(model, b) {
  const p = priceFor(model);
  if (!p) return null;
  return (b.in * p.in + b.out * p.out + b.cw * p.cw + b.cr * p.cr) / 1e6;
}

// Char counts of the EXPLICIT (visible) content blocks in one assistant-message
// jsonl line: prose (text blocks) and json (tool_use inputs). Reasoning is NOT
// here — Claude strips the thinking plaintext (thinking:"" + encrypted signature),
// so the reasoning ("hidden") portion of billed output_tokens can only be a
// residual: hidden ≈ output_tokens − estExplicitOut(prose,json).
//
// NB: one assistant message is often written across SEVERAL jsonl lines — either
// streaming snapshots (same id, growing content + growing output_tokens) OR one
// line per content block (same id, same final output_tokens, DISJOINT blocks:
// thinking on one line, text on another). Callers must therefore take the MAX
// prose/json chars per category across all lines of a message id — summing would
// double-count snapshots, and reading only the token-winning copy misses the
// sibling line's text (which showed a message as 100% reasoning). See scanSession.
function outChars(content) {
  let prose = 0, json = 0;
  if (Array.isArray(content)) for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") prose += (b.text || "").length;
    else if (b.type === "tool_use") json += JSON.stringify(b.input || {}).length;
  }
  return { prose, json };
}
function estExplicitOut(prose, json) {
  return Math.round(prose / 3.9 + json / 3.1); // prose denser than tool-call JSON
}

async function scanSession(file, cutoffMs = null) {
  const cells = new Map(); // `${model}|${lane}` -> {in,out,cw,cr}
  const isSubagentFile = file.includes("/subagents/");
  // Parent session = the dir segment immediately above `subagents`. This is the
  // same for a plain subagent (<sid>/subagents/agent.jsonl) AND for a Workflow
  // agent nested deeper (<sid>/subagents/workflows/<wf>/agent.jsonl), so workflow
  // sub-sessions fold into their mother session instead of listing standalone.
  const parts0 = file.split("/");
  const si = parts0.lastIndexOf("subagents");
  const parentSessionId = isSubagentFile && si > 0 ? parts0[si - 1] : null;
  // Workflow agents live at <sid>/subagents/workflows/<wf_id>/agent-*.jsonl —
  // capture the workflow id so the parent can report distinct workflow runs.
  const workflowId = (si >= 0 && parts0[si + 1] === "workflows") ? parts0[si + 2] : null;
  let cwd = null, first = null, last = null;
  let subagentName = isSubagentFile
    ? file.split("/").pop().replace(".jsonl", "").replace(/^agent-/, "")
    : null;
  // One API response is logged as several jsonl lines (one per content block /
  // streaming snapshot): input+cache tokens identical on each copy, output_tokens
  // growing (1 -> final). Summing every line double-bills the cache tokens, so
  // count each message.id once, keeping the copy with the largest output_tokens.
  const byMsg = new Map(); // message id -> {model, lane, u}
  let anon = 0;
  let autoName = null; // best-effort title: first genuine typed user message
  // Stream instead of readFileSync(...).split("\n"). A single transcript can be
  // 100MB+, and materializing the source string + split strings + parsed lines
  // made V8 retain a multi-GB heap after one dashboard load.
  for await (const line of readLines(file)) {
    if (!line || line === "\r") continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!cwd && o.cwd) cwd = o.cwd;
    subagentName = o.attributionAgent || o.agentId || subagentName;
    const recordMs = Date.parse(o.timestamp || "");
    const inWindow = !cutoffMs || (Number.isFinite(recordMs) && recordMs >= cutoffMs);
    if (o.timestamp && inWindow) { first = first || o.timestamp; last = o.timestamp; }
    if (autoName === null && o.type === "user" && typeof o.message?.content === "string" && o.message.content.length < 1_000_000) {
      const t = o.message.content.trim();
      // Skip synthetic/injected "user" turns: XML-ish wrapper tags, and
      // agent/subagent reports fed back as a user-role message (they read
      // like a completion report, not a request).
      if (t && !t.startsWith("<") && !/^(Done|Completed|Summary|I've|I have|✅|✓|●)\b/.test(t)) {
        autoName = t.split("\n")[0].slice(0, 140);
      }
    }
    const u = o?.message?.usage;
    if (!u || !inWindow) continue;
    const model = o?.message?.model || "unknown";
    const lane = (o.isSidechain || isSubagentFile) ? "sub" : "main";
    const id = o?.message?.id || o?.requestId || `anon-${anon++}`;
    const prev = byMsg.get(id);
    const ch = outChars(o?.message?.content);
    if (!prev) {
      byMsg.set(id, { model, lane, u, ts: o.timestamp || last, pmax: ch.prose, jmax: ch.json });
    } else {
      // token billing: keep the copy with the largest output_tokens.
      if ((u.output_tokens || 0) > (prev.u.output_tokens || 0)) {
        prev.u = u; prev.model = model; prev.lane = lane; prev.ts = o.timestamp || prev.ts;
      }
      // visible-output estimate: max chars per category across every line of this id.
      prev.pmax = Math.max(prev.pmax, ch.prose);
      prev.jmax = Math.max(prev.jmax, ch.json);
    }
  }
  // per-message [epochMs, rawApiUsd] points for the cumulative-spend chart
  const series = [];
  for (const { model, u, ts } of byMsg.values()) {
    const c = costOf(model, {
      in: u.input_tokens || 0, out: u.output_tokens || 0,
      cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0,
    });
    if (c && ts) series.push([new Date(ts).getTime(), c, model]);
  }
  const msgs = byMsg.size;
  for (const { model, lane, u, pmax, jmax } of byMsg.values()) {
    const k = `${model}|${lane}`;
    const b = cells.get(k) || { in: 0, out: 0, cw: 0, cr: 0, oExpl: 0 };
    b.in += u.input_tokens || 0;
    b.out += u.output_tokens || 0;
    b.cw += u.cache_creation_input_tokens || 0;
    b.cr += u.cache_read_input_tokens || 0;
    // explicit visible output, capped at billed output so hidden never goes negative
    b.oExpl += Math.min(estExplicitOut(pmax, jmax), u.output_tokens || 0);
    cells.set(k, b);
  }
  // aggregate: per-model breakdown, per-lane, per-category $ (priced precisely)
  let usd = 0, tokens = 0, unpriced = false;
  const models = new Map();
  const lane = { main: 0, sub: 0 };
  const cat = { in: 0, out: 0, cw: 0, cr: 0 }; // dollars per category
  for (const [k, b] of cells) {
    const [model, ln] = k.split("|");
    const p = priceFor(model);
    const tok = b.in + b.out + b.cw + b.cr;
    tokens += tok;
    // Synthetic bookkeeping messages legitimately carry no billable tokens and
    // must not put a needless "?" on an otherwise fully priced session.
    if (!p) { if (tok > 0) unpriced = true; }
    else {
      const c = (b.in * p.in + b.out * p.out + b.cw * p.cw + b.cr * p.cr) / 1e6;
      usd += c; lane[ln] += c;
      cat.in += b.in * p.in / 1e6; cat.out += b.out * p.out / 1e6;
      cat.cw += b.cw * p.cw / 1e6; cat.cr += b.cr * p.cr / 1e6;
    }
    const m = models.get(model) || { model, in: 0, out: 0, cw: 0, cr: 0, usd: 0, main: 0, sub: 0, outR: 0, rEst: true };
    m.in += b.in; m.out += b.out; m.cw += b.cw; m.cr += b.cr;
    m.outR += Math.max(0, b.out - (b.oExpl || 0)); // hidden reasoning = billed − visible (estimated)
    if (p) {
      const c = (b.in * p.in + b.out * p.out + b.cw * p.cw + b.cr * p.cr) / 1e6;
      m.usd += c;
      if (ln === "sub") m.sub += c;
      else m.main += c;
    }
    models.set(model, m);
  }
  const breakdown = [...models.values()].sort((a, b) => b.usd - a.usd);
  const mainModel = [...models.values()].sort((a, b) => (b.main || 0) - (a.main || 0))[0]?.model || "unknown";
  // model can be switched mid-session (/model); cells preserves first-seen order per main-lane model
  const mainModels = [...cells.keys()]
    .filter((k) => k.endsWith("|main"))
    .map((k) => k.split("|")[0])
    .filter((m) => m !== "unknown" && m !== "<synthetic>");
  const chain = (mainModels.length ? mainModels : [mainModel]).map((m) => m.replace(/^claude-/, ""));
  const chainLabel = chain.length > 3
    ? chain.slice(0, 3).join("→") + "→+" + (chain.length - 3)
    : chain.join("→");
  const displayCwd = isSubagentFile
    ? `claude/subagent/${subagentName || "subagent"}/${cwd || "(unknown)"}`
    : `${chainLabel} ${cwd || "(unknown)"}`;
  return {
    id: file.split("/").pop().replace(".jsonl", ""),
    file,
    cwd: displayCwd,
    mainModels,
    first, last, msgs, usd, tokens, unpriced, breakdown, lane, cat, series,
    realCwd: cwd,
    parentSessionId,
    workflowId,
    isSubagentFile,
    autoName: isSubagentFile ? null : autoName,
  };
}

function mergeClaudeSubagent(parent, sub) {
  parent.usd += sub.usd;
  parent.tokens += sub.tokens;
  parent.msgs += sub.msgs;
  parent.unpriced = parent.unpriced || sub.unpriced;
  parent.first = [parent.first, sub.first].filter(Boolean).sort()[0] || parent.first;
  parent.last = [parent.last, sub.last].filter(Boolean).sort().at(-1) || parent.last;
  parent.lane.sub += sub.usd;
  parent.cat.in += sub.cat.in;
  parent.cat.out += sub.cat.out;
  parent.cat.cw += sub.cat.cw;
  parent.cat.cr += sub.cat.cr;
  parent.subagentCount = (parent.subagentCount || 0) + 1;
  if (sub.workflowId) {
    (parent._wf = parent._wf || new Set()).add(sub.workflowId);
  }
  if (sub.series && sub.series.length) {
    parent.series = (parent.series || []).concat(sub.series);
  }

  const byModel = new Map(parent.breakdown.map((b) => [b.model, { ...b }]));
  for (const b of sub.breakdown) {
    const existing = byModel.get(b.model) || {
      model: b.model,
      in: 0,
      out: 0,
      cw: 0,
      cr: 0,
      usd: 0,
      main: 0,
      sub: 0,
      outR: 0,
      rEst: b.rEst,
    };
    existing.in += b.in;
    existing.out += b.out;
    existing.cw += b.cw;
    existing.cr += b.cr;
    existing.usd += b.usd;
    existing.main += b.main || 0;
    existing.sub += b.usd;
    existing.outR += b.outR || 0;
    if (b.rEst) existing.rEst = true;
    byModel.set(b.model, existing);
  }
  parent.breakdown = [...byModel.values()].sort((a, b) => b.usd - a.usd);
}

async function scanCodex(file, cutoffMs = null) {
  let model = null, first = null, last = null, msgs = 0, total = null, totalCount = 0;
  let cwd = null, threadId = null, parentThreadId = null;
  let isSub = false, subName = null;
  // Per-turn usage summed over every token_count event. Subagent rollouts carry
  // their OWN fresh counters (verified June 2026: first totals ≈ first turn's
  // last_token_usage, zero replayed token_count events) and the parent thread's
  // counter does NOT include them, so their usage is real and must be counted.
  // (An earlier version skipped subagent files as "double-counted" — that was
  // wrong and undercounted Codex ~20x in subagent-heavy months.)
  const sum = { in: 0, cached: 0, out: 0, reason: 0 };
  const turns = []; // {ts, in, cached, out} per turn, priced after model is known
  // Avoid RegExp on whole JSONL lines: some Codex events embed tens of MB of
  // context, and V8 flattens the entire rope before a regexp match. All usage
  // objects are flat, so bounded index/slices are enough.
  const strField = (str, k) => {
    const mark = `"${k}":"`; const a = str.indexOf(mark);
    if (a < 0) return null;
    const from = a + mark.length, b = str.indexOf('"', from);
    return b < 0 ? null : str.slice(from, b);
  };
  const objBody = (str, k) => {
    const mark = `"${k}":{`; const a = str.indexOf(mark);
    if (a < 0) return null;
    const from = a + mark.length, b = str.indexOf("}", from);
    return b < 0 ? null : str.slice(from, b);
  };
  const num = (str, k) => {
    const mark = `"${k}":`; const a = str.indexOf(mark);
    if (a < 0) return 0;
    let i = a + mark.length, j = i;
    while (j < str.length) { const c = str.charCodeAt(j); if (c < 48 || c > 57) break; j++; }
    return j > i ? Number(str.slice(i, j)) : 0;
  };
  let autoName = null; // best-effort title: first genuine typed user message
  for await (const line of readLines(file)) {
    if (!line) continue;
    // Inspect record type only in the JSON envelope. Image/base64 payloads may
    // contain arbitrary prompt text and must never trigger parsing of a giant
    // binary event merely because that text mentions another record type.
    const head = line.length > 512 ? line.slice(0, 512) : line;
    const recordTs = strField(head, "timestamp") || (line.length <= 1_000_000 ? strField(line, "timestamp") : null);
    const recordMs = Date.parse(recordTs || "");
    const inWindow = !cutoffMs || (Number.isFinite(recordMs) && recordMs >= cutoffMs);
    if (line.length > 1_000_000) {
      // Multi-megabyte Codex records are image/base64 outputs. Billing arrives
      // separately in small token_count records, so touching the payload only
      // bloats V8. Preserve chronology from the bounded envelope and skip it.
      if (recordTs && inWindow) { first ||= recordTs; last = recordTs; }
      continue;
    }
    // Titles are human-scale first prompts. Large records are injected context /
    // batch payloads; parsing thousands of ~95KB synthetic messages created a
    // huge transient heap while never yielding a usable title.
    if (autoName === null && line.length < 8_192 && head.includes('"type":"user_message"')) {
      try {
        const msg = JSON.parse(line)?.payload?.message;
        if (typeof msg === "string" && msg.length < 1_000_000) {
          const t = msg.trim();
          if (t && !t.startsWith("<") && !t.startsWith("The following is")) {
            autoName = t.split("\n")[0].slice(0, 140);
          }
        }
      } catch {}
    }
    if (line.length < 1_000_000 && head.includes('"type":"session_meta"')) {
      try {
        const meta = JSON.parse(line).payload || {};
        cwd = meta.cwd || cwd;
        threadId = threadId || meta.id;
        parentThreadId = meta.parent_thread_id || parentThreadId;
        if (meta.thread_source === "subagent" || meta.source?.subagent) {
          isSub = true;
          subName = codexSubagentName(meta.source);
        }
      } catch {}
    }
    if (head.includes('"type":"turn_context"')) {
      try { model = JSON.parse(line)?.payload?.model || model; } catch {}
    } else if (!model && line.includes('"model":"')) {
      model = strField(line, "model") || model;
    }
    if (recordTs && inWindow) { first ||= recordTs; last = recordTs; }
    if (line.includes('"total_token_usage"')) {
      const mt = objBody(line, "total_token_usage");
      if (mt && !cutoffMs) { total = mt; totalCount++; }
      const ml = objBody(line, "last_token_usage");
      if (ml && inWindow) {
        msgs++;
        const ti = num(ml, "input_tokens");
        const tc = num(ml, "cached_input_tokens");
        const to = num(ml, "output_tokens");
        const tr = num(ml, "reasoning_output_tokens"); // exact, unlike Claude
        sum.in += ti; sum.cached += tc; sum.out += to; sum.reason += tr;
        turns.push({ ts: recordTs || last, in: ti, cached: tc, out: to, reason:tr, model });
      }
    }
  }
  // Fallback for old log formats without per-turn last_token_usage: use the
  // final cumulative counter (fine for main threads, which never reset).
  if (!cutoffMs && !sum.in && !sum.out && total) {
    sum.in = num(total, "input_tokens");
    sum.cached = num(total, "cached_input_tokens");
    sum.out = num(total, "output_tokens");
    sum.reason = num(total, "reasoning_output_tokens");
    msgs = totalCount;
  }
  // Keep a launched top-level Codex rollout even when it has no token_count yet (still running,
  // auth failure, or usage-limit rejection). `?empty=1` exists specifically to surface these;
  // returning null here made persisted zero-token Codex instances invisible while Claude empties
  // worked. A session_meta/timestamp proves this is a real launch, so give it one attempted turn.
  if (!sum.in && !sum.out && ((!cutoffMs && threadId) || first)) msgs = Math.max(msgs, 1);
  const inputTot = sum.in;                        // includes cached
  const cached = sum.cached;
  const out = sum.out;                            // includes reasoning
  const uncached = Math.max(0, inputTot - cached);
  let usd = 0, unpriced = false;
  const cat = { in: 0, out: 0, cw: 0, cr: 0 };
  // Apply tiers per request, never to the session's cumulative input total.
  const series = [];
  const byModel = new Map();
  {
    const usage = turns.length ? turns : [{ in: inputTot, cached, out, reason:sum.reason, model }];
    for (const t of usage) {
      const turnModel = t.model || model || '?';
      const b = byModel.get(turnModel) || {model:turnModel,in:0,out:0,cw:0,cr:0,usd:0,sub:0,outR:0,rEst:false};
      b.in+=Math.max(0,t.in-t.cached);b.out+=t.out;b.cr+=t.cached;b.outR+=Math.min(t.reason||0,t.out);
      byModel.set(turnModel,b);
      const p = openaiPrice(turnModel);
      if(!p){unpriced ||= t.in+t.out>0;continue;}
      // Old cumulative-only logs cannot establish individual request length: use base rates.
      const rate = turns.length && p.longContext && t.in > p.longContext.above ? p.longContext : p;
      const ci = Math.max(0, t.in - t.cached) * rate.in / 1e6;
      const cr = t.cached * rate.cached / 1e6;
      const co = t.out * rate.out / 1e6;
      cat.in += ci; cat.cr += cr; cat.out += co;
      b.usd += ci + cr + co;
      if (ci + cr + co && t.ts) series.push([new Date(t.ts).getTime(), ci + cr + co, t.model || model]);
    }
    usd = cat.in + cat.cr + cat.out;
  }
  const tokens = inputTot + out;
  return {
    source: "codex",
    id: file.split("/").pop().replace("rollout-", "").replace(".jsonl", "").slice(0, 33),
    file,
    threadId,
    codexSubagentOf: isSub ? parentThreadId || "" : undefined,
    subName,
    mainModels: [...byModel.keys()],
    cwd: "codex/" + (model || "?"),
    first, last, msgs, usd, tokens, unpriced, series,
    breakdown: [...byModel.values()],
    lane: { main: usd, sub: 0 },
    cat,
    realCwd: cwd,
    autoName: isSub ? null : autoName,
  };
}

// OpenCode Go/Zen per-call ledger (ocgo_usage.jsonl): ONE JSONL file holding every direct-API
// authoring/judging call across all arms. Unlike Claude/Codex (one file per session),
// this yields MANY rows, so the scanner returns an array (cachedScan handles that fine; the array
// is cached by the file's mtime and re-parsed per request). Each line already carries summarized
// usage, so there's no heavy per-record parsing. New producers supply a unique request_id;
// the arm|slug|ts fallback still guards older backfill+live overlap. A 0-token row
// (api-error/empty response) becomes an `empty` session → shows under ?empty=1.
async function scanOcgoLedger(file) {
  const rows = [];
  const seen = new Set();
  for await (const line of readLines(file)) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const ts = Number(r.ts) || 0;
    if (!ts) continue;
    const key = r.request_id || `${r.arm}|${r.slug}|${Math.round(ts)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Old ledgers predate the provider field and are Go. Contributor Free calls
    // explicitly identify Zen as `opencode`; keep that distinction in the UI.
    const provider = r.provider === "codex-direct" ? "codex-direct"
      : r.provider === "opencode" ? "opencode" : "opencode-go";
    const model = r.model || "?";
    const inTot = Number(r.prompt_tokens) || 0;
    const out = Number(r.completion_tokens) || 0;
    const cached = Number(r.cached_tokens) || 0;
    const reason = Number(r.reasoning_tokens) || 0;
    const uncached = Math.max(0, inTot - cached);
    const p = provider === "codex-direct" ? openaiPrice(model) : ocgoPrice(model);
    let usd = 0, unpriced = false;
    const cat = { in: 0, out: 0, cw: 0, cr: 0 };
    if (p) {
      cat.in = uncached * p.in / 1e6;
      cat.cr = cached * (p.cached ?? 0) / 1e6;
      cat.out = out * p.out / 1e6;
      usd = cat.in + cat.cr + cat.out;
    } else unpriced = true;
    const iso = new Date(ts * 1000).toISOString();
    const st = r.status && r.status !== "ok" ? ` [${r.status}]` : "";
    rows.push({
      source: provider === "codex-direct" ? "codex" : "ocgo",
      mainModels: [model],
      id: key.slice(0, 60),
      file,
      cwd: provider + "/" + model,
      first: iso, last: iso, msgs: 1,
      usd, tokens: inTot + out, unpriced,
      series: usd ? [[ts * 1000, usd, model]] : [],
      breakdown: [{
        model, in: uncached, out, cw: 0, cr: cached, usd, sub: 0,
        outR: Math.min(reason, out), rEst: false,
      }],
      lane: { main: usd, sub: 0 },
      cat,
      realCwd: provider + "/" + (r.arm || "?"),
      account: provider === "codex-direct" ? null : provider,
      autoName: `${r.arm || "?"} · ${r.slug || "?"}${st}`,
    });
  }
  return rows;
}

// Durable external-AI batch ledger. Claude entries are the accounting source
// when lean `claude -p` transcripts live in a disposable home. A producer can
// also nominate supplementalEmptyProviders: native sessions remain the source
// for successful calls while the ledger contributes only zero-token attempts
// that may die before a complete native rollout is persisted.
async function scanClaudeUsageLedger(file) {
  const calls = [];
  for await (const line of readLines(file)) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const iso = typeof r.ts === "string" ? r.ts : null;
    if (!iso || !Number.isFinite(Date.parse(iso))) continue;
    const u = r.usage && typeof r.usage === "object" ? r.usage : {};
    calls.push({
      ts: iso,
      tag: typeof r.tag === "string" ? r.tag : null,
      slug: typeof r.slug === "string" ? r.slug : null,
      provider: typeof r.provider === "string" ? r.provider : null,
      model: typeof r.model === "string" ? r.model : null,
      err: r.err || null,
      in: Number(u.input_tokens) || 0,
      out: Number(u.output_tokens) || 0,
      cw: Number(u.cache_creation_input_tokens) || 0,
      cr: Number(u.cache_read_input_tokens) || 0,
      outR: Number(u.output_tokens_details?.thinking_tokens) || 0,
    });
  }
  return calls;
}

function summarizeClaudeUsageLedger(calls, cfg, cutoffMs) {
  const groups = new Map();
  const defaultModel = cfg.defaultModel || "unknown";
  for (const call of calls || []) {
    const ms = Date.parse(call.ts || "");
    if (!Number.isFinite(ms) || (cutoffMs && ms < cutoffMs)) continue;
    const provider = ledgerCallProvider(call, cfg);
    if (!provider) continue;
    const model = call.model || defaultModel;
    // Early authoring ledgers used a per-attempt tag such as slug.v2.a1.
    // Collapse those into one clearly named legacy batch instead of producing
    // hundreds of pseudo-process rows. Current runners write an explicit slug,
    // so their stable tag (sweep-4, fable-core, ...) remains the batch identity.
    const legacyAttempt = !call.slug && /\.v\d+\.a\d+$/.test(call.tag || "");
    const tag = legacyAttempt ? "legacy-authoring" : (call.tag || "untagged");
    const day = call.ts.slice(0, 10);
    const key = `${provider}|${tag}|${model}|${day}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        provider, tag, model, day, first: call.ts, last: call.ts, calls: 0,
        emptyCalls: 0, errorCalls: 0, entities: new Set(),
        b: { in: 0, out: 0, cw: 0, cr: 0, outR: 0 }, series: [],
      };
      groups.set(key, g);
    }
    g.first = call.ts < g.first ? call.ts : g.first;
    g.last = call.ts > g.last ? call.ts : g.last;
    g.calls += 1;
    if (!(call.in + call.out + call.cw + call.cr)) g.emptyCalls += 1;
    if (call.err) g.errorCalls += 1;
    const entity = call.slug || (legacyAttempt ? call.tag.replace(/\.v\d+\.a\d+$/, "") : null);
    if (entity) g.entities.add(entity);
    for (const k of ["in", "out", "cw", "cr"]) g.b[k] += call[k];
    g.b.outR += Math.min(call.outR, call.out);
    const oneCost = costOf(model, call);
    if (oneCost) g.series.push([ms, oneCost, model]);
  }

  const rows = [];
  for (const g of groups.values()) {
    const p = priceFor(g.model);
    const usd = costOf(g.model, g.b) || 0;
    const cat = p ? {
      in: g.b.in * p.in / 1e6,
      out: g.b.out * p.out / 1e6,
      cw: g.b.cw * p.cw / 1e6,
      cr: g.b.cr * p.cr / 1e6,
    } : { in: 0, out: 0, cw: 0, cr: 0 };
    const tokens = g.b.in + g.b.out + g.b.cw + g.b.cr;
    const entityCount = g.entities.size;
    const suffix = `${g.calls.toLocaleString()} calls${entityCount ? ` · ${entityCount.toLocaleString()} pages touched` : ""}`;
    rows.push({
      source: g.provider,
      id: claudeLedgerGroupId(cfg.path, g.provider, g.tag, g.model, g.day),
      file: cfg.path,
      cwd: g.provider === "claude"
        ? `${g.model.replace(/^claude-/, "")} ${cfg.cwd || dirname(cfg.path)}`
        : `${g.provider}/${g.model}`,
      realCwd: cfg.cwd || dirname(cfg.path),
      first: g.first,
      last: g.last,
      msgs: g.calls,
      usd,
      tokens,
      unpriced: !p && tokens > 0,
      series: g.series,
      breakdown: [{
        model: g.model, in: g.b.in, out: g.b.out, cw: g.b.cw, cr: g.b.cr,
        usd, main: usd, sub: 0, outR: g.b.outR, rEst: false,
      }],
      lane: { main: usd, sub: 0 },
      cat,
      mainModels: [g.model],
      account: g.provider === "claude" ? (cfg.account || null) : null,
      autoName: `${cfg.label || "Claude batch"} · ${g.tag} · ${suffix}`,
      ledgerLabel: cfg.label || "Claude batch",
      batchTag: g.tag,
      callCount: g.calls,
      emptyCallCount: g.emptyCalls,
      errorCallCount: g.errorCalls,
      entityCount,
    });
  }
  return rows;
}

function ledgerCallProvider(call, cfg) {
  const provider = call.provider || cfg.defaultProvider || "claude";
  if (provider === "claude") return provider;
  const tokens = call.in + call.out + call.cw + call.cr;
  return tokens === 0 && (cfg.supplementalEmptyProviders || []).includes(provider) ? provider : null;
}

function claudeLedgerGroupId(path, provider, tag, model, day) {
  return `ledger-${createHash("sha1").update(`${path}|${provider}|${tag}|${model}|${day}`).digest("hex").slice(0, 12)}`;
}

function claudeLedgerCallGroup(call, cfg) {
  const provider = ledgerCallProvider(call, cfg);
  if (!provider) return null;
  const model = call.model || cfg.defaultModel || "unknown";
  const legacyAttempt = !call.slug && /\.v\d+\.a\d+$/.test(call.tag || "");
  const tag = legacyAttempt ? "legacy-authoring" : (call.tag || "untagged");
  const day = call.ts.slice(0, 10);
  return { provider, model, tag, day, id: claudeLedgerGroupId(cfg.path, provider, tag, model, day) };
}

async function ledgerCallDetails(id, cutoffMs = null) {
  for (const rawCfg of MACHINES[0].claudeUsageLedgers || []) {
    const cfg = typeof rawCfg === "string" ? { path: rawCfg } : rawCfg;
    if (!cfg?.path || !existsSync(cfg.path)) continue;
    const calls = await cachedScan(cfg.path, scanClaudeUsageLedger);
    const found = [];
    for (const call of calls || []) {
      if (cutoffMs && Date.parse(call.ts) < cutoffMs) continue;
      const group = claudeLedgerCallGroup(call, cfg);
      if (!group || group.id !== id) continue;
      const p = priceFor(group.model);
      const cost = p ? {
        in: call.in * p.in / 1e6,
        out: call.out * p.out / 1e6,
        cw: call.cw * p.cw / 1e6,
        cr: call.cr * p.cr / 1e6,
      } : { in: 0, out: 0, cw: 0, cr: 0 };
      cost.total = cost.in + cost.out + cost.cw + cost.cr;
      found.push({
        ts: call.ts,
        slug: call.slug,
        tag: call.tag,
        provider: group.provider,
        model: group.model,
        in: call.in,
        out: call.out,
        cw: call.cw,
        cr: call.cr,
        tokens: call.in + call.out + call.cw + call.cr,
        empty: !(call.in + call.out + call.cw + call.cr),
        error: call.err ? (typeof call.err === "string" ? call.err : JSON.stringify(call.err)) : null,
        cost,
      });
    }
    if (found.length) {
      found.sort((a, b) => b.ts.localeCompare(a.ts));
      return { id, calls: found };
    }
  }
  return null;
}

// mtime cache so we don't re-read several GB of logs every request. Store the
// summary as JSON, not a live object graph: 60k cached JS objects consumed
// hundreds of MB and were then cloned again for each request. Serialized rows
// are compact and JSON.parse gives callers a safe, mutable fresh value.
const _cache = new Map(); // path -> { mtime, json, touched }
// …and PERSISTED to disk, because the cache is the only thing standing between a
// restart and re-reading the whole window from disk (58GB / 100k files over the
// default 7 days → ~2 min cold vs ~2 s warm). Entries are keyed by path+mtime, so
// a stale entry can never be served: a changed file simply misses. ~25MB of JSON.
// Agent mode keeps its own cache next to the deployed copy on the remote host —
// that cache is what makes remote collection cheap: only files whose mtime moved
// are re-parsed there, and only the summary is sent back.
const SCAN_CACHE_FILE = join(import.meta.dirname, "local", "scan-cache.json");
const SCAN_CACHE_SCHEMA = 3;
// Scanner summaries contain calculated dollars, so path+mtime alone is not a
// sufficient cache key. Fingerprint every price table: adding a model or changing
// a rate automatically invalidates both local and remote pre-priced summaries.
const SCAN_CACHE_VERSION = createHash("sha256").update(JSON.stringify({
  schema: SCAN_CACHE_SCHEMA,
  claude: PRICES,
  openai: OPENAI_PRICES,
  ocgo: OCGO_PRICES,
})).digest("hex").slice(0, 16);
let _cacheDirty = false;
(() => {
  try {
    const disk = JSON.parse(readFileSync(SCAN_CACHE_FILE, "utf8"));
    if (disk.version !== SCAN_CACHE_VERSION || !disk.entries) {
      console.log(`[cache] ignored incompatible scan cache (${disk.version || "legacy"} → ${SCAN_CACHE_VERSION})`);
      return;
    }
    for (const [f, e] of Object.entries(disk.entries)) _cache.set(f, { mtime: e.m, json: e.j, touched: 0 });
    console.log(`[cache] loaded ${_cache.size} scanned files from disk`);
  } catch {}
})();
function saveScanCache() {
  if (!_cacheDirty) return;
  _cacheDirty = false;
  // Drop entries for files that vanished (rsync --delete, log rotation) so the
  // file can't grow forever; everything else round-trips as {m:mtime, j:json}.
  const out = {};
  for (const [f, e] of _cache) {
    try { if (statSync(f).mtimeMs !== e.mtime) continue; } catch { _cache.delete(f); continue; }
    out[f] = { m: e.mtime, j: e.json };
  }
  try {
    mkdirSync(dirname(SCAN_CACHE_FILE), { recursive: true });
    writeFileSync(SCAN_CACHE_FILE, JSON.stringify({ version: SCAN_CACHE_VERSION, entries: out }));
  } catch (err) { console.error(`[cache] save failed: ${err.message}`); }
}
setInterval(saveScanCache, 120e3).unref?.();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { saveScanCache(); process.exit(0); });
async function cachedScan(file, fn) {
  const st = statSync(file);
  const mt = st.mtimeMs;
  const hit = _cache.get(file);
  if (hit && hit.mtime === mt) { hit.touched = Date.now(); return JSON.parse(hit.json); }
  const val = await fn(file);
  const json = JSON.stringify(val);
  _cache.set(file, { mtime: mt, json, touched: Date.now() });
  _cacheDirty = true;
  // Return the ROUND-TRIPPED copy, never `val` itself. `scanCodex` extracts every
  // field with `line.slice(...)`, and V8 represents a slice of a long string as a
  // SlicedString that RETAINS THE WHOLE PARENT. So a row holding one 24-char
  // timestamp pinned its entire multi-hundred-KB JSONL line in the heap; across
  // large transcript sets this can exhaust the heap. JSON.parse yields flat
  // strings that retain nothing,
  // and it also makes the fresh-scan and cache-hit paths return identical shapes.
  return JSON.parse(json);
}

// Keep only transcript files modified on/after the cutoff (ms epoch). A null
// cutoff means "no window" — scan everything.
function withinWindow(files, cutoffMs) {
  if (!cutoffMs) return files;
  return files.filter((f) => {
    try { return statSync(f).mtimeMs >= cutoffMs; } catch { return false; }
  });
}

async function collectMachine(machine, cutoffMs, compact = true, exactWindow = false) {
  // A machine may scan several claude config-dir roots (one per account). Legacy
  // single-root config (machine.claudeRoot) still works. `account` on a root is
  // used verbatim (e.g. a remote root in machines.local.mjs); otherwise it's resolved
  // from that dir's /profile via DIR_ACCOUNT.
  const roots = (machine.claudeRoots && machine.claudeRoots.length)
    ? machine.claudeRoots
    : [{ dir: machine.claudeDir, root: machine.claudeRoot, account: machine.account }];
  // A machine may point at an accountsFile (JSON: { "<root path>": "account" })
  // written by its sync script — used for remote machines where we
  // can't resolve /profile locally. Re-read each scan so drift is picked up.
  // `machine.accounts` is the already-resolved map, injected by collectRemote()
  // (the agent runs on the remote host and has no copy of the accounts file).
  let acctFile = machine.accounts || {};
  if (machine.accountsFile) { try { acctFile = JSON.parse(readFileSync(machine.accountsFile, "utf8")); } catch {} }
  const claude = [];
  const claudeCompactor = compact ? makeRowCompactor() : null;
  const addClaude = (s) => { if (claudeCompactor) claudeCompactor.add(s); else claude.push(s); };
  for (const R of roots) {
    if (!R.root) continue;
    let files = [];
    // Never swallow this silently: an unreadable root used to yield zero rows and
    // look exactly like "that machine had no sessions".
    try { files = withinWindow(walk(R.root), cutoffMs); }
    catch (err) { console.error(`[scan] claude root ${R.root} unreadable: ${err.message}`); }
    if (AGENT) console.error(`[agent] claude ${R.root}: ${files.length} files in window`);
    const acct = R.account || acctFile[R.root] || (R.dir && DIR_ACCOUNT[R.dir]) || null;
    // Only parents that actually have subagent files need to stay as individual
    // live objects. Everything else can flow directly into the batch compactor.
    const neededParents = new Set();
    for (const f of files) {
      const parts = f.split("/"); const si = parts.lastIndexOf("subagents");
      if (si > 0) neededParents.add(parts[si - 1]);
    }
    const parents = new Map();
    const subs = [];
    for (const f of files) {
      try {
        const cached = exactWindow
          ? await scanSession(f, cutoffMs)
          : await cachedScan(f, async (x) => scanSession(x));
        if (!cached) continue;
        const s = cached;
        s.source = "claude";
        s.account = acct;
        if (s.parentSessionId) subs.push(s);
        else if (neededParents.has(s.id)) parents.set(s.id, s);
        else addClaude(s);
      } catch {}
    }
    for (const s of subs) {
      const parent = parents.get(s.parentSessionId);
      if (parent) mergeClaudeSubagent(parent, s); else addClaude(s);
    }
    for (const parent of parents.values()) addClaude(parent);
  }
  if (claudeCompactor) claude.push(...claudeCompactor.finish());
  let codexFiles = [];
  const codexRoots = (machine.codexRoots && machine.codexRoots.length)
    ? machine.codexRoots
    : [machine.codexRoot];
  for (const root of codexRoots) {
    if (!root) continue;
    try { codexFiles.push(...withinWindow(walk(root), cutoffMs)); } catch {}
  }
  codexFiles = [...new Set(codexFiles)];
  const codex = [];
  const codexSubs = [];
  const codexByThread = new Map(); // main threadId -> session row
  for (const f of codexFiles) {
    try {
      const cachedRow = exactWindow
        ? await scanCodex(f, cutoffMs)
        : await cachedScan(f, scanCodex);
      if (!cachedRow) continue;
      const r = cachedRow;
      if (r.codexSubagentOf !== undefined) {
        codexSubs.push(r);
        continue;
      }
      codex.push(r);
      if (r.threadId) codexByThread.set(r.threadId, r);
    } catch {}
  }
  // Fold subagent rollouts into their top-level session (same as Claude
  // sidechains), following parent links through nested subagents (e.g. a
  // guardian spawned by a thread_spawn agent); orphans are listed standalone.
  const subByThread = new Map();
  for (const s of codexSubs) if (s.threadId) subByThread.set(s.threadId, s);
  const resolveMain = (id) => {
    for (let depth = 0; id && depth < 20; depth++) {
      const main = codexByThread.get(id);
      if (main) return main;
      const sub = subByThread.get(id);
      if (!sub) return null;
      id = sub.codexSubagentOf;
    }
    return null;
  };
  for (const s of codexSubs) {
    const parent = resolveMain(s.codexSubagentOf);
    if (s.empty) {
      if (parent) parent.subagentCount = (parent.subagentCount || 0) + 1;
      continue;
    }
    if (parent) {
      mergeClaudeSubagent(parent, s);
    } else {
      s.cwd = `codex/subagent/${s.subName || "subagent"}/${s.cwd.replace(/^codex\//, "")}`;
      codex.push(s);
    }
  }
  // OpenCode Go ledgers. Pre-summarized rows; filter by the request window here
  // (the cached parse is window-independent). The singular field stays compatible
  // with older private machine configs while new producers use the plural list.
  const ocgo = [];
  const ocgoLedgers = [...new Set([
    ...(machine.ocgoLedgers || []),
    ...(machine.ocgoLedger ? [machine.ocgoLedger] : []),
  ])];
  for (const ledger of ocgoLedgers) {
    if (!existsSync(ledger)) continue;
    try {
      const rows = await cachedScan(ledger, scanOcgoLedger);
      for (const r of rows || []) {
        if (cutoffMs && new Date(r.last).getTime() < cutoffMs) continue;
        ocgo.push(r);
      }
    } catch {}
  }
  const claudeLedgers = [];
  for (const rawCfg of machine.claudeUsageLedgers || []) {
    const cfg = typeof rawCfg === "string" ? { path: rawCfg } : rawCfg;
    if (!cfg?.path || !existsSync(cfg.path)) continue;
    try {
      const calls = await cachedScan(cfg.path, scanClaudeUsageLedger);
      claudeLedgers.push(...summarizeClaudeUsageLedger(calls, cfg, cutoffMs));
    } catch (err) {
      console.error(`[scan] Claude usage ledger ${cfg.path} unreadable: ${err.message}`);
    }
  }
  // Keep token-bearing sessions AND "empty" ones — a session that recorded turns
  // but produced 0 tokens is a THROTTLED/errored call (e.g. a runaway batch
  // slamming an exhausted rate limit and getting empty responses back). These
  // used to be silently dropped, which hid exactly the sessions that pile up
  // when a limit is hit. We keep them, tagged `empty`, and split them out later.
  const sessions = [...claude, ...codex, ...ocgo, ...claudeLedgers].filter((s) => s && (s.tokens > 0 || (s.msgs || 0) > 0));
  if (AGENT) console.error(`[agent] rows: claude=${claude.length} codex=${codex.length} ocgo=${ocgo.length} ledgers=${claudeLedgers.length} → kept ${sessions.length}`);
  // Set → count (Sets don't serialize); mark sessions that ran Workflow tool(s).
  for (const s of sessions) {
    if (s._wf) { s.workflowCount = s._wf.size; delete s._wf; }
    s.machine = machine.id;
    s.empty = !(s.tokens > 0);
  }
  return sessions;
}

// === Remote machines: run the collector THERE, ship back only the summary ===
// A machine declaring `remote: { host, fallbackHost, dir }` is never mirrored.
// We copy THIS FILE to `dir` on that host (once per content hash), run it with
// --agent, and parse the rows it prints. The remote keeps its own scan cache in
// `dir/local/`, so steady-state runs re-parse only files whose mtime moved.
//
// Compact summaries avoid filling the dashboard machine with duplicate private
// transcripts. Parsing happens on the machine that already owns the files.
const _remoteDeployed = new Map(); // machine id -> sha256 of the deployed file
const _remoteHost = new Map();     // machine id -> ssh argv that actually works
const _remoteLast = new Map();     // `${id}|${cutoff}|${compact}` -> last good rows
const SELF = new URL(import.meta.url).pathname;

// ssh argv for a machine, preferring `host` and falling back to `fallbackHost`
// when the preferred SSH configuration is unavailable.
async function sshArgs(machine) {
  const r = machine.remote;
  const cached = _remoteHost.get(machine.id);
  if (cached) return cached;
  const base = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-C"];
  const tryHost = (extra, host) => new Promise((res) => {
    execFile("ssh", [...extra, ...base, host, "true"], { timeout: 15e3 }, (err) => res(err ? null : [...extra, ...base, host]));
  });
  const argv = (await tryHost([], r.host))
    || (r.fallbackHost ? await tryHost(["-F", "/dev/null"], r.fallbackHost) : null);
  if (!argv) throw new Error(`ssh to ${r.host} failed`);
  _remoteHost.set(machine.id, argv);
  return argv;
}

// Run one ssh command. `stdin` is written to the remote command; stdout is
// returned. maxBuffer is generous because a full-history scan returns a few MB.
function sshExec(argv, cmd, stdin = null, maxBuffer = 512 * 1024 * 1024, timeout = 900e3) {
  return new Promise((resolve_, reject) => {
    const child = execFile("ssh", [...argv, cmd], { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) { err.message += ` :: ${String(stderr).slice(0, 400)}`; reject(err); }
      else resolve_(stdout);
    });
    if (stdin !== null) { child.stdin.end(stdin); } else { child.stdin.end(); }
  });
}

async function collectRemote(machine, cutoffMs, compact, exactWindow = false) {
  const r = machine.remote;
  const argv = await sshArgs(machine);
  const src = readFileSync(SELF, "utf8");
  const sha = createHash("sha256").update(src).digest("hex");
  if (_remoteDeployed.get(machine.id) !== sha) {
    // Write via a temp name + mv so a half-copied file can never be executed.
    await sshExec(argv, `mkdir -p ${r.dir}/local && cat > ${r.dir}/.server.mjs.tmp && mv ${r.dir}/.server.mjs.tmp ${r.dir}/server.mjs`, src);
    _remoteDeployed.set(machine.id, sha);
    console.log(`[remote ${machine.id}] agent deployed (${sha.slice(0, 12)})`);
  }
  // Accounts are resolved locally (the /profile lookup needs this machine's
  // network path) and handed to the agent so it can tag rows the same way.
  let accounts = {};
  if (machine.accountsFile) { try { accounts = JSON.parse(readFileSync(machine.accountsFile, "utf8")); } catch {} }
  const cfg = {
    machine: {
      id: machine.id,
      claudeRoots: machine.claudeRoots || [],
      codexRoots: machine.codexRoots || [],
      ocgoLedger: machine.ocgoLedger || null,
      ocgoLedgers: machine.ocgoLedgers || [],
      claudeUsageLedgers: machine.claudeUsageLedgers || [],
      accounts,
    },
    cutoffMs, compact, exactWindow,
  };
  const b64 = Buffer.from(JSON.stringify(cfg), "utf8").toString("base64");
  const t0 = Date.now();
  const out = await sshExec(argv, `CC_AGENT_B64=${b64} ${r.node || "node"} --max-old-space-size=${r.heapMB || 3072} ${r.dir}/server.mjs --agent`);
  const rows = JSON.parse(out);
  console.log(`[remote ${machine.id}] ${rows.length} rows, ${(out.length / 1048576).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return rows;
}

// windowDays: only scan transcript files modified within this many days.
// 0/null → scan everything (the "load all" path).
// Concurrent /api requests during a COLD scan must share ONE collect() run —
// N parallel cold scans each hold a full session graph (~1.4GB+) and OOM the
// 128GB-agnostic V8 heap cap (observed 2026-07-16: browser tab + curl → 2.6GB
// peak → abort). Results are read-only downstream (handlers copy before
// mutating), so sharing the resolved array between requests is safe.
const _inflightCollect = new Map(); // `${days}|${compact}` -> Promise
function collectShared(windowDays, compact = true) {
  const k = windowDays + "|" + compact;
  let p = _inflightCollect.get(k);
  if (!p) {
    p = collect(windowDays, compact).finally(() => _inflightCollect.delete(k));
    _inflightCollect.set(k, p);
  }
  return p;
}
async function collect(windowDays, compact = true) {
  const cutoffMs = windowDays ? Date.now() - windowDays * 864e5 : null;
  const exactWindow = windowDays > 0 && windowDays < 1;
  const raw = [];
  for (const m of MACHINES) {
    maybeSync(m);
    if (m.remote) {
      // A remote round-trip can fail (host down, ssh hiccup) long after it last
      // succeeded. Serve the previous rows rather than silently dropping a whole
      // machine's spend from the totals — and say so in the log.
      const k = `${m.id}|${cutoffMs}|${compact}`;
      try {
        const rows = await collectRemote(m, cutoffMs, compact, exactWindow);
        _remoteLast.set(k, rows);
        raw.push(...rows);
      } catch (err) {
        const stale = _remoteLast.get(k);
        console.error(`[remote ${m.id}] ${err.message}${stale ? ` — serving ${stale.length} cached rows` : ""}`);
        if (stale) raw.push(...stale);
      }
      continue;
    }
    raw.push(...await collectMachine(m, cutoffMs, compact, exactWindow));
  }
  // Safety dedupe by machine|source|id — guards against a session surfacing from
  // two overlapping scan roots (also prevents duplicate React keys in the table).
  const seen = new Set();
  const all = [];
  for (const s of raw) {
    const k = (s.machine || "") + "|" + (s.source || "") + "|" + (s.id || s.file || "");
    if (seen.has(k)) continue;
    seen.add(k); all.push(s);
  }
  all.sort((a, b) => (b.last || "").localeCompare(a.last || ""));
  return all;
}

// Keep exact totals without shipping tens of thousands of nearly identical
// one-shot batch rows to the browser. Large cohorts retain their newest rows;
// the older tail becomes one exact aggregate row per machine/source/account/
// cwd/day/model-chain. `/api?...&raw=1` bypasses this for diagnostics/exports.
const BATCH_GROUP_MIN = 100;
const BATCH_KEEP_NEWEST = 20;
const rowWeight = (s) => s.groupCount || 1;
function aggregateRows(rows, key) {
  const sample = rows[0];
  const byModel = new Map();
  const cat = { in: 0, out: 0, cw: 0, cr: 0 };
  const lane = { main: 0, sub: 0 };
  let usd = 0, tokens = 0, msgs = 0, unpriced = false, subagentCount = 0, workflowCount = 0;
  let first = null, last = null;
  const mainModels = new Set();
  const hourly = new Map();
  for (const s of rows) {
    const w = rowWeight(s);
    usd += s.usd || 0; tokens += s.tokens || 0; msgs += s.msgs || 0;
    unpriced ||= !!s.unpriced;
    subagentCount += s.subagentCount || 0; workflowCount += s.workflowCount || 0;
    first = !first || (s.first && s.first < first) ? s.first : first;
    last = !last || (s.last && s.last > last) ? s.last : last;
    for (const m of s.mainModels || []) mainModels.add(m);
    for (const k of Object.keys(cat)) cat[k] += s.cat?.[k] || 0;
    for (const k of Object.keys(lane)) lane[k] += s.lane?.[k] || 0;
    for (const b of s.breakdown || []) {
      const g = byModel.get(b.model) || { model: b.model, in: 0, out: 0, cw: 0, cr: 0, usd: 0, main: 0, sub: 0, outR: 0, rEst: false, sessions: 0 };
      for (const k of ["in", "out", "cw", "cr", "usd", "main", "sub", "outR"]) g[k] += b[k] || 0;
      g.rEst ||= !!b.rEst; g.sessions += b.sessions || w;
      byModel.set(b.model, g);
    }
    // Preserve call hours even when compacting an aggregate again.
    for (const [ts, cost, recordedModel] of s.series || []) {
      if (!Number.isFinite(ts) || !Number.isFinite(cost)) continue;
      const hour = Math.floor(ts / 3600000) * 3600000;
      const model = recordedModel || (s.breakdown?.length === 1 ? s.breakdown[0].model : 'unattributed');
      const key = hour + '|' + model;
      const point = hourly.get(key) || [hour, 0, model];
      point[1] += cost;
      hourly.set(key, point);
    }
  }
  const digest = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return {
    source: sample.source, id: `batch-${digest}`, file: null,
    cwd: sample.cwd, realCwd: sample.realCwd, account: sample.account,
    first, last, msgs, usd, tokens, unpriced,
    series: [...hourly.values()].sort((a,b) => a[0]-b[0]),
    breakdown: [...byModel.values()].sort((a, b) => b.usd - a.usd),
    lane, cat, mainModels: [...mainModels],
    subagentCount, workflowCount, machine: sample.machine, empty: !!sample.empty,
    groupCount: rows.reduce((n, s) => n + rowWeight(s), 0),
    autoName: `${rows.reduce((n, s) => n + rowWeight(s), 0).toLocaleString()} older ${sample.empty ? "throttled/empty" : "batch"} sessions`,
  };
}
function batchKey(s) {
  const day = (s.last || s.first || "unknown").slice(0, 10);
  const cwd = s.realCwd || s.cwd || "";
  const models = (s.mainModels || []).join(",");
  return [s.machine, s.source, s.account || "", cwd, day, models, s.empty ? "E" : ""].join("|");
}
function makeRowCompactor() {
  const groups = new Map();
  const passthrough = [];
  return {
    add(s) {
      if (s.empty || !(s.tokens > 0)) { passthrough.push(s); return; }
      const key = batchKey(s);
      let g = groups.get(key);
      if (!g) { g = { pending: [], newest: null, tail: null }; groups.set(key, g); }
      if (!g.newest) {
        g.pending.push(s);
        if (g.pending.length < BATCH_GROUP_MIN) return;
        g.pending.sort((a, b) => (b.last || "").localeCompare(a.last || ""));
        g.newest = g.pending.slice(0, BATCH_KEEP_NEWEST);
        g.tail = aggregateRows(g.pending.slice(BATCH_KEEP_NEWEST), key);
        g.pending = null;
        return;
      }
      const oldestKept = g.newest[g.newest.length - 1];
      if ((s.last || "") > (oldestKept.last || "")) {
        g.newest.push(s);
        g.newest.sort((a, b) => (b.last || "").localeCompare(a.last || ""));
        const displaced = g.newest.pop();
        g.tail = aggregateRows([g.tail, displaced], key);
      } else {
        g.tail = aggregateRows([g.tail, s], key);
      }
    },
    finish() {
      const out = passthrough.slice();
      for (const g of groups.values()) {
        if (g.newest) out.push(...g.newest, g.tail);
        else out.push(...g.pending);
      }
      return out;
    },
  };
}
function compactBatchRows(sessions) {
  const groups = new Map();
  const passthrough = [];
  for (const s of sessions) {
    if (s.empty) { passthrough.push(s); continue; }
    const key = batchKey(s);
    const g = groups.get(key) || [];
    g.push(s); groups.set(key, g);
  }
  let groupedSessions = 0;
  for (const [key, rows] of groups) {
    if (rows.length < BATCH_GROUP_MIN) { passthrough.push(...rows); continue; }
    rows.sort((a, b) => (b.last || "").localeCompare(a.last || ""));
    passthrough.push(...rows.slice(0, BATCH_KEEP_NEWEST));
    const tail = rows.slice(BATCH_KEEP_NEWEST);
    passthrough.push(aggregateRows(tail, key));
    groupedSessions += tail.length;
  }
  passthrough.sort((a, b) => (b.last || "").localeCompare(a.last || ""));
  return { sessions: passthrough, groupedSessions };
}

function sendJson(req, res, value) {
  const raw = Buffer.from(JSON.stringify(value));
  const wasLarge = raw.length > 1024 * 1024;
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "") && raw.length > 1024) {
    const body = gzipSync(raw, { level: 5 });
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "vary": "Accept-Encoding" });
    res.end(body);
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(raw);
  }
  // Production starts Node with --expose-gc. A cold scan may transiently decode
  // very large transcript lines; reclaim that heap immediately instead of V8
  // reserving several GB until it happens to feel memory pressure later.
  if (wasLarge && global.gc) setImmediate(() => global.gc());
}

const PAGE = `<!doctype html><html><head><meta charset=utf8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>💸 Claude Code session costs</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2334d399'><circle cx='12' cy='12' r='10' stroke='%2334d399' stroke-width='2' fill='none'/><circle cx='12' cy='12' r='4' fill='%2334d399'/><path d='M12 2v4M12 18v4M2 12h4m10 0h4' stroke='%2334d399' stroke-width='2'/></svg>">
<style>
 body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#0f1117;color:#e6e6e6}
 header{padding:14px 24px 12px;background:#161a23;border-bottom:1px solid #262b38}
 .bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
 h1{margin:0;font-size:17px;white-space:nowrap}
 .sub{color:#8b93a7;font-size:11px;margin-top:8px}
 .seg{display:inline-flex;background:#0f1117;border:1px solid #262b38;border-radius:8px;overflow:hidden}
 .seg button{background:none;border:0;color:#8b93a7;padding:6px 13px;cursor:pointer;font-size:13px;line-height:1.2}
 .seg button.on{background:#26304a;color:#fff}
 .seg button:hover:not(.on){color:#cdd3e0}
 select{background:#0f1117;color:#e6e6e6;border:1px solid #262b38;border-radius:8px;padding:5px 8px;font-size:12px}
 select:disabled{opacity:.35}
 label.plansel{display:inline-flex;align-items:center;gap:5px;font-size:13px}
 .mult{font-size:11px;color:#34d399;font-family:ui-monospace,monospace}
 input.search{background:#0f1117;color:#e6e6e6;border:1px solid #262b38;border-radius:8px;padding:6px 10px;font-size:13px;width:190px;margin-left:auto}
 input.search:focus{outline:none;border-color:#3b4664}
 .totals{display:flex;gap:14px;padding:14px 24px;flex-wrap:wrap}
 .compactnote{margin:10px 24px 0;padding:9px 12px;border:1px solid #334155;border-radius:8px;background:#111827;color:#a7b0c3;font-size:12px}
 .compactnote code{color:#6ee7b7}
 .loading{display:flex;align-items:center;gap:12px;color:#8b93a7;font-size:13px}
 .limits{padding:12px 24px 4px;display:flex;flex-direction:column;gap:9px}
 .limits .lhead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
 .limits .lhead b{font-size:13px;color:#e6e9ef}
 .limits .lnote{color:#8b93a7;font-size:11px;line-height:1.45}
 .accts{display:flex;gap:12px;flex-wrap:wrap}
 .acct{flex:1 1 340px;min-width:300px;background:#161a23;border:1px solid #262b38;border-radius:10px;padding:11px 13px}
 .acct.hot{border-color:#7f1d1d;box-shadow:0 0 0 1px #7f1d1d55}
 .acct .ahd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px}
 .acct .aem{font-size:12.5px;font-weight:600;color:#e6e9ef}
 .acct .atier{font-size:10px;color:#8b93a7;background:#0f1219;border:1px solid #262b38;border-radius:5px;padding:1px 6px}
 .acct .adir{font-size:10px;color:#5f6b82}
 .win{margin:7px 0}
 .win .wl{display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:3px}
 .win .wl .wlab{color:#c3c9d6}.win .wl .wpct{font-variant-numeric:tabular-nums;font-weight:600}
 .win .track{height:7px;background:#0f1219;border-radius:4px;overflow:hidden}
 .win .fill{height:100%;border-radius:4px;transition:width .4s}
 .win .wreset{font-size:10px;color:#6b7590;margin-top:2px}
 .lvl-ok{color:#34d399}.bar-ok{background:#34d399}
 .lvl-warn{color:#fbbf24}.bar-warn{background:#fbbf24}
 .lvl-crit{color:#f87171}.bar-crit{background:#f87171}
 .acct .aerr{font-size:11px;color:#f87171}
 .acct.stale{opacity:.82}
 .acct .astale{font-size:10px;color:#fbbf24;border:1px solid #4a3f21;border-radius:4px;padding:0 4px;cursor:help}
 .pbar{width:180px;height:7px;background:#262b38;border-radius:5px;overflow:hidden;position:relative}
 .pbar>div{position:absolute;height:100%;width:40%;border-radius:5px;background:linear-gradient(90deg,#34d399,#7dd3fc);animation:slide 1.1s ease-in-out infinite}
 @keyframes slide{0%{left:-40%}100%{left:100%}}
 .loaderr{color:#f87171;font-size:13px}
 .loaderr button{background:#26304a;color:#fff;border:0;border-radius:6px;padding:4px 10px;margin-left:8px;cursor:pointer;font-size:12px}
 .card{background:#161a23;border:1px solid #262b38;border-radius:10px;padding:10px 16px;min-width:104px}
 .card .n{font-size:21px;font-weight:600}
 .card .l{color:#8b93a7;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-top:1px}
 .card .x{color:#6b7280;font-size:11px;margin-top:1px}
 .card.throttle{cursor:pointer;border-color:#7f5f1d}
 .card.throttle:hover{border-color:#b8860b}
 .card.throttle .n{color:#fbbf24}
 .card.throttle.on{background:#241f13;border-color:#b8860b}
 .rsub{color:#a78bfa;font-size:10px;line-height:1.2;margin-top:1px;white-space:nowrap}
 .proj{color:#7dd3fc} .dim{color:#6b7280} .mono{font-family:ui-monospace,monospace;font-size:12px}
 .pill{display:inline-block;background:#1e2430;border-radius:6px;padding:1px 7px;margin:1px;font-size:11px}
 .sid{color:#6b7280;font-size:11px;font-family:ui-monospace,monospace}
 .sname{color:#fbbf24;font-size:12px;cursor:text;border-bottom:1px dashed transparent}
 .sname:hover{border-bottom-color:#fbbf24}
 .snameauto{color:#9ca3af;font-style:italic}
 .snameinp{background:#1e2430;color:#e5e7eb;border:1px solid #fbbf24;border-radius:4px;font-size:12px;padding:0 4px;width:140px;font-family:inherit}
 .pill.wf{background:#7c3aed26;color:#c4b5fd;border:1px solid #7c3aed66;font-weight:600}
 .chartbox{position:relative;margin:10px 0 4px 8px;width:max-content}
 .chartbox h4{margin:0 0 4px;font-size:12px;color:#a8b0c2;font-weight:600}
 .chartbox svg{display:block;background:#11151d;border:1px solid #262b38;border-radius:8px}
 .chartbox .axl{fill:#6b7280;font-size:10px;font-family:ui-monospace,monospace}
 .charttip{position:absolute;pointer-events:none;background:#0b0d13;border:1px solid #3b4664;border-radius:6px;padding:4px 8px;font-size:11px;color:#e6e6e6;white-space:nowrap;transform:translate(-50%,-120%);opacity:0;transition:opacity .08s;z-index:5}
 .charttip b{color:#34d399}
 .warn{color:#f59e0b} .big{color:#f87171;font-weight:600}
 .cr{color:#fbbf24}
 .pill.cdx{background:#10b98122;color:#34d399} .pill.cld{background:#6366f122;color:#a5b4fc}
 .pill.ocg{background:#f43f5e22;color:#fb7185;border:1px solid #f43f5e44}
 .pill.mach{background:#f59e0b1f;color:#fbbf24;border:1px solid #f59e0b44}
 .acctdot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle;flex:none}
 .warm{cursor:help;display:inline-block;min-width:4.8em;margin-left:4px;color:#fbbf24;text-align:left}
 .warm:empty{display:none}
 details.prices{margin:0 24px 8px;background:#161a23;border:1px solid #262b38;border-radius:10px}
 details.prices>summary{cursor:pointer;padding:10px 16px;font-size:13px;color:#a8b0c2;user-select:none;list-style:none}
 details.prices>summary::-webkit-details-marker{display:none}
 details.prices>summary:hover{color:#cdd3e0}
 details.prices[open]>summary{border-bottom:1px solid #262b38}
 .priceGrid{display:flex;gap:18px;flex-wrap:wrap;padding:12px 16px 14px}
 .priceGrid h3{margin:0 0 6px;font-size:12px;color:#a8b0c2;font-weight:600}
 table.price{border-collapse:collapse;font-variant-numeric:tabular-nums}
 table.price th,table.price td{padding:4px 12px;text-align:right;border-bottom:1px solid #20242f;font-size:12px}
 table.price th{position:static;background:none;color:#8b93a7;cursor:default;font-weight:500;white-space:nowrap}
 table.price td.l,table.price th.l{text-align:left}
 table.price td.l{color:#7dd3fc;font-family:ui-monospace,monospace}
 table.price .raw{color:#5b6373;font-size:10px}
 .detail{padding:8px 0 14px}
 .openbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:2px 0 8px}
 .obtn{background:#1e2430;border:1px solid #2c3342;color:#cdd3e0;border-radius:7px;padding:4px 9px;font-size:12px;cursor:pointer}
 .obtn:hover{background:#262d3b;border-color:#3a4356}
 .opath{font-size:11px;color:#8b93a7;background:#11151d;border:1px solid #20242f;border-radius:6px;padding:2px 7px;max-width:100%;overflow-wrap:anywhere;word-break:break-all}
 .ostat{font-size:11px;font-weight:600}
 table.inner{width:auto;margin:2px 0 2px 8px;border:1px solid #262b38;border-radius:8px;overflow:hidden}
 table.inner th,table.inner td{border-bottom:1px solid #20242f;padding:5px 14px;font-size:12px}
 table.inner th{position:static;background:#11151d;color:#8b93a7;text-align:right}
 table.inner td.l,table.inner th.l{text-align:left}
 table.inner td{text-align:right;font-variant-numeric:tabular-nums}
 .cr,td.cr{color:#fbbf24}
 /* --- virtualized grid table --- */
 .wrap{padding:0 24px 60px}
 .cc-head{display:grid;position:sticky;top:0;z-index:2;background:#161a23;border-bottom:1px solid #262b38}
 .cc-th{padding:7px 12px;text-align:right;color:#a8b0c2;font-size:12px;cursor:pointer;user-select:none;white-space:nowrap}
 .cc-th.l{text-align:left}
 .cc-th.on{color:#7dd3fc}
 .cc-body{position:relative}
 .cc-abs{position:absolute;left:0;right:0}
 .ccrow{display:grid;align-items:center;cursor:pointer;border-bottom:1px solid #20242f}
 .ccrow:hover{background:#171b25}
 .ccrow.open{background:#141a26}
 .cc-td{padding:7px 12px;text-align:right;font-variant-numeric:tabular-nums;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
 .cc-td.l{text-align:left}
 .ccrow.empty .cc-td{opacity:.55}
 .ccrow.empty .cc-td.proj::after{content:" ⚠️ throttled/empty";color:#fbbf24;font-size:10px}
 .cc-month{background:#141927;color:#a8b0c2;font-size:12px;border-top:1px solid #2a3147;border-bottom:1px solid #2a3147;padding:9px 12px}
 .cc-month b{color:#e6e6e6}
 .cc-detail{padding:0 12px 4px;border-bottom:1px solid #20242f;background:#0f131b}
 .ledger-calls{margin:0 0 14px 8px}
 .ledger-toggle{display:flex;align-items:center;gap:6px;background:#1e2430;border:1px solid #3b465b;color:#f0ab72;border-radius:7px;padding:6px 10px;font:600 12px ui-monospace,monospace;cursor:pointer}
 .ledger-toggle:hover,.ledger-toggle.open{background:#292f3d;border-color:#66738e}
 .ledger-state{margin:8px 2px;color:#9ca3af;font:12px ui-monospace,monospace}
 .ledger-state button{margin-left:6px}
 .ledger-call-wrap{max-height:520px;max-width:100%;overflow:auto;margin-top:8px;border:1px solid #293142;border-radius:8px;background:#0b0f16}
 table.ledger-call-table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}
 table.ledger-call-table th{position:sticky;top:0;z-index:1;background:#151a24;color:#8b93a7;text-align:right;padding:7px 10px;border-bottom:1px solid #323b4e}
 table.ledger-call-table td{text-align:right;padding:6px 10px;border-bottom:1px solid #1d2430;font-variant-numeric:tabular-nums}
 table.ledger-call-table th.l,table.ledger-call-table td.l{text-align:left}
 table.ledger-call-table tr:hover td{background:#151b26}
 table.ledger-call-table tr.empty-call td{color:#7d8492;background:#10141b}
 .call-slug{max-width:320px;white-space:normal;overflow-wrap:anywhere}
 .call-ok{color:#75c995}.call-empty{color:#d5a14c}.call-error{color:#f07474}
</style></head><body>
<div id=root></div>
<script>window.__CC={HOME:${JSON.stringify(homedir().replaceAll("\\","/"))}};</script>
<script src="/vendor/react.production.min.js"></script>
<script src="/vendor/react-dom.production.min.js"></script>
<script src="/vendor/htm.umd.js"></script>
<script src="/components.js"></script>
<script src="/history.js"></script>
<script src="/studio.js?v=sole-desk-20261007"></script>
<script src="/app.js?v=sole-desk-20261007"></script>
</body></html>`;

// Every path a transcript could legitimately live under — the built-in
// Claude/Codex roots plus EVERY absolute path found anywhere in the machine
// configs. Derived generically (deep-walk of machines.local.mjs values) so that
// adding a new data-source field (claudeRoots, ocgoLedger, whatever comes next)
// can never be forgotten here again — twice this function lagged the scanner and
// rows 403'd as "not under a known root". All machine paths are our own synced
// cache/config files, so over-whitelisting them for xdg-open is harmless; the
// check still exists to keep `/open` from being an arbitrary-file opener.
function allowedRoots() {
  const roots = [ROOT, CODEX_ROOT];
  const walk = (v) => {
    if (typeof v === "string") {
      if (v.startsWith("/")) roots.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(MACHINES);
  return roots.filter(Boolean).map((r) => resolve(r));
}
// Reveal-in-file-manager vs open-with-default-app, per platform.
function openCmd(target, reveal) {
  if (process.platform === "darwin") return ["open", reveal ? ["-R", target] : [target]];
  if (process.platform === "win32") {
    return reveal ? ["explorer", ["/select,", target]] : ["cmd", ["/c", "start", "", target]];
  }
  // Linux: no portable "reveal" — open the file, or its parent dir when revealing.
  return ["xdg-open", [reveal ? dirname(target) : target]];
}

// Static assets: vendored React/htm + the React app bundle. Served from disk so
// the app code lives in a real .js file (no template-literal escaping) and the
// browser can cache the big vendor files.
const STATIC = {
  "/vendor/react.production.min.js": ["vendor/react.production.min.js", "text/javascript"],
  "/vendor/react-dom.production.min.js": ["vendor/react-dom.production.min.js", "text/javascript"],
  "/vendor/htm.umd.js": ["vendor/htm.umd.js", "text/javascript"],
  "/app.js": ["public/app.js", "text/javascript"],
  "/studio.js": ["public/studio.js", "text/javascript"],
  "/history.js": ["public/history.js", "text/javascript"],
  "/components.js": ["public/components.js", "text/javascript"],
  "/studio.css": ["public/studio.css", "text/css"],
};
// === Agent mode entry point ================================================
// Everything above is shared with the dashboard; this is the only thing agent
// mode does. One canonical collector, two ways to invoke it.
if (AGENT) {
  const rows = await collectMachine(
    AGENT_CFG.machine || {},
    AGENT_CFG.cutoffMs ?? null,
    AGENT_CFG.compact !== false,
    AGENT_CFG.exactWindow === true,
  );
  saveScanCache();
  // Exit only once stdout has actually FLUSHED. A multi-MB payload does not fit
  // one pipe buffer, so process.exit() right after write() truncates the JSON
  // mid-object. (writeFileSync(fd 1) is not the answer either: ssh hands us a
  // NON-BLOCKING pipe and it throws EAGAIN.) The server below is skipped in this
  // mode, so nothing else can keep the process alive.
  process.stdout.write(JSON.stringify(rows), () => process.exit(0));
}

// Reuse the live account reader: no second credential reader or provider request.
const localQuotaFile = join(import.meta.dirname, 'local', 'claude-quota-history.jsonl');
function localQuotaRows() {
  try { return readFileSync(localQuotaFile,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}); }
  catch(e) { if(e.code==='ENOENT')return []; throw e; }
}
function recordLocalQuota(data) {
  const ts=Date.parse(data.fetchedAt), hour=Math.floor(ts/3600000);
  try {
    const previous=localQuotaRows().filter(r=>Math.floor(r.ts/3600000)===hour);
    for(const a of data.accounts||[]) {
      if(a.staleAt)continue; // Cached failures must never become new observations.
      const account=(a.email||'').split('@')[0]||DIR_ACCOUNT[a.dir]||null;
      const sourceId='local:'+a.dir, accountId=account||sourceId;
      const windows=(a.windows||[]).filter(w=>Number.isFinite(w.pct)).map(w=>({key:w.key,label:w.label,used:w.pct,remaining:Math.max(0,Math.min(100,100-w.pct)),resets:w.resets}));
      const status=!a.error&&windows.length?'ok':'error';
      if(previous.some(r=>(status==='ok'?r.accountId===accountId&&r.status==='ok':r.sourceId===sourceId&&r.status===status)))continue;
      const row={ts,machine:'local',sourceId,provider:'claude',account,accountId,status,windows:status==='ok'?windows:[],...(status==='error'?{error:a.loggedOut?'Logged out — sign in to this Claude account':a.error||'No quota windows returned'}:{})};
      mkdirSync(dirname(localQuotaFile),{recursive:true,mode:0o700});
      appendFileSync(localQuotaFile,JSON.stringify(row)+'\n',{mode:0o600});previous.push(row);
    }
  } catch(e) { console.error('[quota history] Local persistence failed: '+e.message); }
}
const quotaHistoryCache = new Map();
const shellQuote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";
async function quotaHistory() {
  const results = await Promise.all(MACHINES.filter(m => m.quotaHistory).map(async m => {
    const cached = quotaHistoryCache.get(m.id);
    if(cached && Date.now()-cached.at < 60000) return cached.result;
    try {
      const q = m.quotaHistory;
      const after = Date.now()-366*864e5;
      const cmd = `python3 ${shellQuote(q.script)} --config ${shellQuote(q.config)} --history --after ${after}`;
      const out = m.remote
        ? await sshExec(await sshArgs(m), cmd, null, 32*1024*1024, 20000)
        : await new Promise((resolve,reject)=>execFile('python3',[q.script,'--config',q.config,'--history','--after',String(after)],{timeout:15000,maxBuffer:32*1024*1024},(e,stdout)=>e?reject(e):resolve(stdout)));
      const result = {machine:m.id, samples:JSON.parse(out)};
      quotaHistoryCache.set(m.id,{at:Date.now(),result});
      return result;
    } catch {
      return {machine:m.id,samples:cached?.result.samples||[],error:'Quota history unavailable',stale:!!cached};
    }
  }));
  try { results.push({machine:'local',samples:localQuotaRows().filter(r=>r.ts>=Date.now()-366*864e5)}); }
  catch { results.push({machine:'local',samples:[],error:'Local quota history unavailable'}); }
  return {sources:results.map(({samples,...source})=>source), samples:results.flatMap(r=>r.samples), fetchedAt:Date.now()};
}

if (!AGENT) createServer(async (req, res) => {
  {
    const path0 = req.url.split("?")[0];
    const st0 = STATIC[path0];
    if (st0) {
      try {
        const body = readFileSync(join(import.meta.dirname, st0[0]));
        res.writeHead(200, { "content-type": st0[1] + "; charset=utf-8", "cache-control": "no-cache" });
        return res.end(body);
      } catch { res.writeHead(404); return res.end("not found"); }
    }
  }
  if (req.url.startsWith("/open?")) {
    const q = new URL(req.url, "http://localhost").searchParams;
    const want = resolve(q.get("file") || "");
    const reveal = q.get("reveal") === "1";
    const ok = allowedRoots().some((r) => want === r || want.startsWith(r + sep));
    const send = (code, msg) => {
      res.writeHead(code, { "content-type": "text/plain" });
      res.end(msg);
    };
    if (!ok) return send(403, "path not under a known transcript root");
    try { statSync(want); } catch { return send(404, "file not found on this machine"); }
    const [cmd, cmdArgs] = openCmd(want, reveal);
    execFile(cmd, cmdArgs, (err) => {
      if (err) console.error(`[open] ${err.message}`);
    });
    return send(200, "opening");
  }
  if (req.url === "/api/quota-history") {
    return sendJson(req,res,await quotaHistory());
  }
  if (req.url === "/api/usage") {
    try {
      const data = await getUsage();
      sendJson(req, res, data);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (req.url.startsWith("/api/ledger-calls?")) {
    const params = new URL(req.url, "http://localhost").searchParams;
    const id = params.get("id") || "";
    const after = Math.max(0, Number(params.get("after")) || 0);
    const cutoffMs = after || null;
    if (!/^ledger-[a-f0-9]{12}$/.test(id)) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid ledger row id" }));
    }
    try {
      const detail = await ledgerCallDetails(id, cutoffMs);
      if (!detail) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "ledger row not found" }));
      }
      sendJson(req, res, detail);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (req.url === "/api/name" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (code, msg) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(msg); };
    let key, name;
    try { ({ key, name } = JSON.parse(body)); } catch { return send(400, "bad json"); }
    if (!key) return send(400, "missing key");
    const names = loadNames();
    if (name) names[key] = name; else delete names[key];
    saveNames(names);
    return send(200, "ok");
  }
  if (req.url.startsWith("/api")) {
    const q = new URL(req.url, "http://localhost").searchParams;
    // Default to a 7-day scan window so first load stays fast; ?all=1 (or
    // ?days=0) scans every session, ?days=N narrows to N days, and ?hours=N
    // supplies an exact rolling sub-day window (used by the 5h control).
    const all = q.get("all") === "1";
    const hours = all ? 0 : (q.has("hours") ? Math.max(0, +q.get("hours") || 0) : 0);
    const days = all || hours ? 0 : (q.has("days") ? Math.max(0, +q.get("days") || 0) : 7);
    const windowDays = hours ? hours / 24 : days;
    // Sub-day views stay ungrouped until after the timestamp cutoff. Files can
    // acquire a fresh mtime from a reindex/touch even when their last message is
    // old; pre-compacting those rows could mix out-of-window usage into a group
    // whose newest row is in-window. mtime remains the cheap scan prefilter, but
    // the session's own `last` timestamp is the accounting truth.
    const rawMode = q.get("raw") === "1" || !!hours;
    const scanned = await collectShared(windowDays, !rawMode);
    const cutoffMs = windowDays ? Date.now() - windowDays * 864e5 : null;
    const collected = cutoffMs
      ? scanned.filter((s) => Date.parse(s.last || "") >= cutoffMs)
      : scanned;
    // Split throttled/empty (0-token) sessions out of the priced table. They are
    // summarized always (so a runaway-retry burst is visible), and included as
    // real rows only when ?empty=1 — otherwise thousands of empty retries would
    // flood the table. Both share the same window/machine filtering downstream.
    const throttledRows = collected.filter((s) => s.empty);
    const byMachine = {};
    for (const s of throttledRows) byMachine[s.machine] = (byMachine[s.machine] || 0) + 1;
    // ?empty=1 can pull tens of thousands of 0-token rows (36MB+). Keep the
    // newest EMPTY_CAP as individual rows (series stripped — a 0-token session
    // has no meaningful spend chart; that array is the bulk of the payload) and
    // fold the OLDER tail into exact aggregate rows per batchKey cohort, so
    // month/session COUNTS stay exact — nothing is dropped, only collapsed.
    const EMPTY_CAP = 2000;
    let sessions, emptyShown = 0;
    if (q.get("empty") === "1") {
      const real = collected.filter((s) => !s.empty);
      const sortedEmpty = throttledRows
        .slice().sort((a, b) => (b.last || "").localeCompare(a.last || ""));
      const shown = sortedEmpty.slice(0, EMPTY_CAP).map((s) => ({ ...s, series: [] }));
      const tail = sortedEmpty.slice(EMPTY_CAP);
      const tailGroups = new Map();
      for (const s of tail) {
        const k = batchKey(s);
        let g = tailGroups.get(k);
        if (!g) { g = []; tailGroups.set(k, g); }
        g.push(s);
      }
      const tailAgg = [...tailGroups].map(([k, rows]) => ({ ...aggregateRows(rows, k), series: [] }));
      emptyShown = shown.length;
      sessions = [...real, ...shown, ...tailAgg];
    } else {
      sessions = collected.filter((s) => !s.empty);
    }
    const compacted = rawMode
      ? { sessions, groupedSessions: 0 }
      : compactBatchRows(sessions);
    const rawCount = compacted.sessions.reduce((n, s) => n + rowWeight(s), 0);
    sendJson(req, res, {
      sessions: compacted.sessions,
      compaction: {
        rawCount,
        shownRows: compacted.sessions.length,
        groupedSessions: rawCount - compacted.sessions.filter((s) => !s.groupCount).length,
      },
      throttled: {
        count: throttledRows.length,
        shown: emptyShown,
        capped: emptyShown > 0 && emptyShown < throttledRows.length,
        byMachine,
        newest: throttledRows.reduce((mx, s) => (s.last > mx ? s.last : mx), ""),
      },
      windowHours: hours || null,
      windowDays: days || null,
      windowCutoff: cutoffMs,
      machines: MACHINES.map(({ id, label }) => ({ id, label })),
      prices: { claude: PRICES, openai: OPENAI_PRICES, ocgo: OCGO_PRICES },
      names: loadNames(),
    });
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`claude-cost dashboard → http://localhost:${PORT}`);
  // Warm DIR_ACCOUNT so the first scan can already attribute sessions to accounts.
  getUsage().catch(() => {});
  setInterval(()=>getUsage().catch(()=>{}), 5*60_000).unref();
});
