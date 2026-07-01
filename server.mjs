#!/usr/bin/env node
// Tiny dashboard: dollar cost of every past Claude Code session.
// Scans ~/.claude/projects/**/*.jsonl, prices tokens per model, serves a page.
//   node server.mjs            -> http://localhost:8799
//   PORT=9000 node server.mjs

import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";

const ROOT = join(homedir(), ".claude", "projects");
const CODEX_ROOT = join(homedir(), ".codex", "sessions");
const PORT = process.env.PORT || 8799;

// === Machines =============================================================
// Sessions are indexed per "machine". The local machine is built in; extra
// machines come from an OPTIONAL, gitignored ./machines.local.mjs:
//   export const machines = [
//     { id: "name", label: "🖥 name",
//       claudeRoot: "/abs/path/to/synced/claude/projects",
//       codexRoot:  "/abs/path/to/synced/codex/sessions",
//       syncCmd: "/abs/path/to/sync-script.sh",   // optional
//       syncIntervalSec: 600 },                    // optional, default 600
//   ];
// `syncCmd` is kicked off in the background (fire-and-forget) at most once
// per interval before scanning — e.g. an rsync wrapper that pulls another
// computer's logs into a local cache dir. Host names, paths, and scripts all
// live in the gitignored file, so the repo stays free of private details.
const MACHINES = [{ id: "local", label: "💻 local", claudeRoot: ROOT, codexRoot: CODEX_ROOT }];
try {
  const ext = await import("./machines.local.mjs");
  for (const m of ext.machines || []) if (m && m.id) MACHINES.push(m);
} catch {}

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
// Source checked 2026-06-11: https://openai.com/api/pricing/
// OpenAI bills: uncached input, cached input (cheaper), output (incl. reasoning).
const OPENAI_PRICES = {
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
const PRICES = {
  "claude-opus-4-8":   { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-opus-4-7":   { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-opus-4-6":   { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-opus-4-5":   { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-fable-5":    { in: 10, out: 50, cw: 12.5, cr: 1.0 },
  "claude-sonnet-5":   { in: 3, out: 15, cw: 3.75, cr: 0.3 },
  "claude-sonnet-4-6": { in: 3, out: 15, cw: 3.75, cr: 0.3 },
  "claude-sonnet-4-5": { in: 3, out: 15, cw: 3.75, cr: 0.3 },
  "claude-haiku-4-5":  { in: 1, out: 5,  cw: 1.25, cr: 0.1 },
  sonnet:              { in: 3, out: 15, cw: 3.75, cr: 0.3 },
};

// Paths are normalized to forward slashes so the "/subagents/"-style parsing
// below works on Windows too (node's fs APIs accept / on every platform).
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replaceAll("\\", "/");
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function priceFor(model) {
  return PRICES[model] || PRICES[(model || "").replace(/-\d{8}$/, "")] || null;
}
function costOf(model, b) {
  const p = priceFor(model);
  if (!p) return null;
  return (b.in * p.in + b.out * p.out + b.cw * p.cw + b.cr * p.cr) / 1e6;
}

function scanSession(file) {
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
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  // One API response is logged as several jsonl lines (one per content block /
  // streaming snapshot): input+cache tokens identical on each copy, output_tokens
  // growing (1 -> final). Summing every line double-bills the cache tokens, so
  // count each message.id once, keeping the copy with the largest output_tokens.
  const byMsg = new Map(); // message id -> {model, lane, u}
  let anon = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!cwd && o.cwd) cwd = o.cwd;
    subagentName = o.attributionAgent || o.agentId || subagentName;
    if (o.timestamp) { first = first || o.timestamp; last = o.timestamp; }
    const u = o?.message?.usage;
    if (!u) continue;
    const model = o?.message?.model || "unknown";
    const lane = (o.isSidechain || isSubagentFile) ? "sub" : "main";
    const id = o?.message?.id || o?.requestId || `anon-${anon++}`;
    const prev = byMsg.get(id);
    if (!prev || (u.output_tokens || 0) > (prev.u.output_tokens || 0)) {
      byMsg.set(id, { model, lane, u, ts: o.timestamp || prev?.ts || last });
    }
  }
  // per-message [epochMs, rawApiUsd] points for the cumulative-spend chart
  const series = [];
  for (const { model, u, ts } of byMsg.values()) {
    const c = costOf(model, {
      in: u.input_tokens || 0, out: u.output_tokens || 0,
      cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0,
    });
    if (c && ts) series.push([new Date(ts).getTime(), c]);
  }
  const msgs = byMsg.size;
  for (const { model, lane, u } of byMsg.values()) {
    const k = `${model}|${lane}`;
    const b = cells.get(k) || { in: 0, out: 0, cw: 0, cr: 0 };
    b.in += u.input_tokens || 0;
    b.out += u.output_tokens || 0;
    b.cw += u.cache_creation_input_tokens || 0;
    b.cr += u.cache_read_input_tokens || 0;
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
    if (!p) { unpriced = true; }
    else {
      const c = (b.in * p.in + b.out * p.out + b.cw * p.cw + b.cr * p.cr) / 1e6;
      usd += c; lane[ln] += c;
      cat.in += b.in * p.in / 1e6; cat.out += b.out * p.out / 1e6;
      cat.cw += b.cw * p.cw / 1e6; cat.cr += b.cr * p.cr / 1e6;
    }
    const m = models.get(model) || { model, in: 0, out: 0, cw: 0, cr: 0, usd: 0, main: 0, sub: 0 };
    m.in += b.in; m.out += b.out; m.cw += b.cw; m.cr += b.cr;
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
    };
    existing.in += b.in;
    existing.out += b.out;
    existing.cw += b.cw;
    existing.cr += b.cr;
    existing.usd += b.usd;
    existing.main += b.main || 0;
    existing.sub += b.usd;
    byModel.set(b.model, existing);
  }
  parent.breakdown = [...byModel.values()].sort((a, b) => b.usd - a.usd);
}

async function scanCodex(file) {
  let model = null, first = null, last = null, msgs = 0, total = null, totalCount = 0;
  let cwd = null, threadId = null, parentThreadId = null;
  let isSub = false, subName = null;
  // Per-turn usage summed over every token_count event. Subagent rollouts carry
  // their OWN fresh counters (verified June 2026: first totals ≈ first turn's
  // last_token_usage, zero replayed token_count events) and the parent thread's
  // counter does NOT include them, so their usage is real and must be counted.
  // (An earlier version skipped subagent files as "double-counted" — that was
  // wrong and undercounted Codex ~20x in subagent-heavy months.)
  const sum = { in: 0, cached: 0, out: 0 };
  const turns = []; // {ts, in, cached, out} per turn, priced after model is known
  const num = (str, k) => { const m = str.match(new RegExp(`"${k}":(\\d+)`)); return m ? +m[1] : 0; };
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (line.includes('"type":"session_meta"')) {
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
    if (!model && line.includes('"model":"')) {
      const m = line.match(/"model":"([^"]+)"/); if (m) model = m[1];
    }
    if (first === null && line.includes('"timestamp":"')) {
      const t = line.match(/"timestamp":"([^"]+)"/); if (t) first = t[1];
    }
    if (line.includes('"timestamp":"')) {
      const t = line.match(/"timestamp":"([^"]+)"/); if (t) last = t[1];
    }
    if (line.includes('"total_token_usage"')) {
      const mt = line.match(/"total_token_usage":\{([^}]*)\}/);
      if (mt) { total = mt[1]; totalCount++; }
      const ml = line.match(/"last_token_usage":\{([^}]*)\}/);
      if (ml) {
        msgs++;
        const ti = num(ml[1], "input_tokens");
        const tc = num(ml[1], "cached_input_tokens");
        const to = num(ml[1], "output_tokens");
        sum.in += ti; sum.cached += tc; sum.out += to;
        const tt = line.match(/"timestamp":"([^"]+)"/);
        turns.push({ ts: tt ? tt[1] : last, in: ti, cached: tc, out: to });
      }
    }
  }
  // Fallback for old log formats without per-turn last_token_usage: use the
  // final cumulative counter (fine for main threads, which never reset).
  if (!sum.in && !sum.out && total) {
    sum.in = num(total, "input_tokens");
    sum.cached = num(total, "cached_input_tokens");
    sum.out = num(total, "output_tokens");
    msgs = totalCount;
  }
  if (!sum.in && !sum.out) {
    return isSub ? { threadId, codexSubagentOf: parentThreadId || "", subName, empty: true } : null;
  }
  const inputTot = sum.in;                        // includes cached
  const cached = sum.cached;
  const out = sum.out;                            // includes reasoning
  const uncached = Math.max(0, inputTot - cached);
  const p = openaiPrice(model);
  let usd = 0, unpriced = false;
  const cat = { in: 0, out: 0, cw: 0, cr: 0 };
  if (p) {
    cat.in = uncached * p.in / 1e6;
    cat.cr = cached * p.cached / 1e6;       // cached input ≈ "cache read"
    cat.out = out * p.out / 1e6;
    usd = cat.in + cat.cr + cat.out;
  } else unpriced = true;
  const tokens = inputTot + out;
  // per-turn [epochMs, rawApiUsd] points for the cumulative-spend chart
  const series = [];
  if (p) for (const t of turns) {
    const unc = Math.max(0, t.in - t.cached);
    const c = (unc * p.in + t.cached * p.cached + t.out * p.out) / 1e6;
    if (c && t.ts) series.push([new Date(t.ts).getTime(), c]);
  }
  return {
    source: "codex",
    id: file.split("/").pop().replace("rollout-", "").replace(".jsonl", "").slice(0, 33),
    file,
    threadId,
    codexSubagentOf: isSub ? parentThreadId || "" : undefined,
    subName,
    cwd: "codex/" + (model || "?"),
    first, last, msgs, usd, tokens, unpriced, series,
    breakdown: [{
      model: model || "?",
      in: uncached,
      out,
      cw: 0,
      cr: cached,
      usd,
      sub: 0,
    }],
    lane: { main: usd, sub: 0 },
    cat,
    realCwd: cwd,
  };
}

// mtime cache so we don't re-read 3.4GB of Codex logs every request
const _cache = new Map(); // path -> { mtime, val }
async function cachedScan(file, fn) {
  const mt = statSync(file).mtimeMs;
  const hit = _cache.get(file);
  if (hit && hit.mtime === mt) return hit.val;
  const val = await fn(file);
  _cache.set(file, { mtime: mt, val });
  return val;
}

// cachedScan returns shared objects; clone before the subagent merge mutates them.
const cloneRow = (r) => ({
  ...r,
  breakdown: (r.breakdown || []).map((b) => ({ ...b })),
  lane: r.lane && { ...r.lane },
  cat: r.cat && { ...r.cat },
  series: r.series ? r.series.slice() : [],
});

async function collectMachine(machine) {
  let claudeFiles = [];
  try { claudeFiles = walk(machine.claudeRoot); } catch {}
  const claudeRaw = [];
  for (const f of claudeFiles) {
    try {
      const cached = await cachedScan(f, async (x) => scanSession(x));
      if (!cached) continue;
      const s = cloneRow(cached);
      s.source = "claude";
      claudeRaw.push(s);
    } catch {}
  }
  const claudeById = new Map(claudeRaw.filter((s) => !s.parentSessionId).map((s) => [s.id, s]));
  const claude = [];
  for (const s of claudeRaw) {
    if (!s.parentSessionId) {
      claude.push(s);
      continue;
    }
    const parent = claudeById.get(s.parentSessionId);
    if (parent) mergeClaudeSubagent(parent, s);
    else claude.push(s);
  }
  let codexFiles = [];
  try { codexFiles = walk(machine.codexRoot); } catch {}
  const codex = [];
  const codexSubs = [];
  const codexByThread = new Map(); // main threadId -> session row
  for (const f of codexFiles) {
    try {
      const cachedRow = await cachedScan(f, scanCodex);
      if (!cachedRow) continue;
      const r = cachedRow.empty ? { ...cachedRow } : cloneRow(cachedRow);
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
  const sessions = [...claude, ...codex].filter((s) => s && s.tokens > 0);
  // Set → count (Sets don't serialize); mark sessions that ran Workflow tool(s).
  for (const s of sessions) {
    if (s._wf) { s.workflowCount = s._wf.size; delete s._wf; }
    s.machine = machine.id;
  }
  return sessions;
}

async function collect() {
  const all = [];
  for (const m of MACHINES) {
    maybeSync(m);
    all.push(...await collectMachine(m));
  }
  all.sort((a, b) => (b.last || "").localeCompare(a.last || ""));
  return all;
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
 .loading{display:flex;align-items:center;gap:12px;color:#8b93a7;font-size:13px}
 .pbar{width:180px;height:7px;background:#262b38;border-radius:5px;overflow:hidden;position:relative}
 .pbar>div{position:absolute;height:100%;width:40%;border-radius:5px;background:linear-gradient(90deg,#34d399,#7dd3fc);animation:slide 1.1s ease-in-out infinite}
 @keyframes slide{0%{left:-40%}100%{left:100%}}
 .loaderr{color:#f87171;font-size:13px}
 .loaderr button{background:#26304a;color:#fff;border:0;border-radius:6px;padding:4px 10px;margin-left:8px;cursor:pointer;font-size:12px}
 .card{background:#161a23;border:1px solid #262b38;border-radius:10px;padding:10px 16px;min-width:104px}
 .card .n{font-size:21px;font-weight:600}
 .card .l{color:#8b93a7;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-top:1px}
 .card .x{color:#6b7280;font-size:11px;margin-top:1px}
 table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
 th,td{padding:7px 12px;text-align:right;border-bottom:1px solid #20242f}
 th{position:sticky;top:0;background:#161a23;cursor:pointer;color:#a8b0c2;font-size:12px;z-index:2;user-select:none;white-space:nowrap}
 th.on{color:#7dd3fc}
 td.l,th.l{text-align:left} tbody tr:hover{background:#171b25}
 .proj{color:#7dd3fc} .dim{color:#6b7280} .mono{font-family:ui-monospace,monospace;font-size:12px}
 .pill{display:inline-block;background:#1e2430;border-radius:6px;padding:1px 7px;margin:1px;font-size:11px}
 .sid{color:#6b7280;font-size:11px;font-family:ui-monospace,monospace}
 .pill.wf{background:#7c3aed26;color:#c4b5fd;border:1px solid #7c3aed66;font-weight:600}
 .chartbox{position:relative;margin:10px 0 4px 8px;width:max-content}
 .chartbox h4{margin:0 0 4px;font-size:12px;color:#a8b0c2;font-weight:600}
 .chartbox svg{display:block;background:#11151d;border:1px solid #262b38;border-radius:8px}
 .chartbox .axl{fill:#6b7280;font-size:10px;font-family:ui-monospace,monospace}
 .charttip{position:absolute;pointer-events:none;background:#0b0d13;border:1px solid #3b4664;border-radius:6px;padding:4px 8px;font-size:11px;color:#e6e6e6;white-space:nowrap;transform:translate(-50%,-120%);opacity:0;transition:opacity .08s;z-index:5}
 .charttip b{color:#34d399}
 .warn{color:#f59e0b} .big{color:#f87171;font-weight:600}
 .cr{color:#fbbf24} td.cr{color:#fbbf24}
 .pill.cdx{background:#10b98122;color:#34d399} .pill.cld{background:#6366f122;color:#a5b4fc}
 .pill.mach{background:#f59e0b1f;color:#fbbf24;border:1px solid #f59e0b44}
 .warm{cursor:help;display:inline-block;min-width:4.8em;margin-left:4px;color:#fbbf24;text-align:left}
 .warm:empty{display:none}
 tr.month td{background:#141927;color:#a8b0c2;font-size:12px;border-top:1px solid #2a3147;border-bottom:1px solid #2a3147;padding:9px 12px}
 tr.month b{color:#e6e6e6}
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
 table.inner th{position:static;background:#11151d}
 .wrap{padding:0 24px 60px}
</style></head><body>
<header>
 <div class=bar>
  <h1>💸 Session costs</h1>
  <div class=seg id=modeSeg title="Switch between raw API list prices and your subscription plans' effective rates">
   <button data-m=api>🧾 API</button>
   <button data-m=plan>📦 Plan</button>
  </div>
  <div class=seg id=machSeg style="display:none" title="Which computer's sessions to show"></div>
  <label class=plansel title="Anthropic plan (plan price ÷ max possible monthly API spend)">🟠 <select id=selClaude></select></label>
  <label class=plansel title="OpenAI / ChatGPT plan (plan price ÷ max possible monthly API spend)">🟢 <select id=selCodex></select></label>
  <span class=mult id=multNote></span>
  <input class=search id=q placeholder="🔍 filter projects…">
 </div>
 <div class=sub id=subNote></div>
</header>
<div class=totals id=totals><div class=loading id=loading>⏳ Scanning Claude &amp; Codex session logs… <div class=pbar><div></div></div></div></div>
<details class=prices id=pricesPanel><summary id=pricesSummary>💲 Model prices (per 1M tokens)</summary><div class=priceGrid id=priceGrid></div></details>
<div class=wrap><table id=t><thead><tr>
 <th class=l data-k=when>When</th><th class=l data-k=proj>Project</th>
 <th data-k=msgs>Msgs</th><th data-k=dur>Dur</th><th data-k=tokens>Tokens</th>
 <th data-k=din>$ in</th><th data-k=dout>$ out</th>
 <th data-k=dcw>$ cache&#8209;wr</th><th data-k=dcr>$ cache&#8209;rd</th>
 <th data-k=sub>$ subwork</th><th data-k=usd>$ Total</th><th data-k=cacheshare>cache%</th>
</tr></thead><tbody></tbody></table></div>
<script>
const HOME=${JSON.stringify(homedir().replaceAll("\\", "/"))};
let data=[], sortK='when', desc=true, q='', prices={claude:{},openai:{}}, machines=[];
let loadingData=false, firstLoad=true;
const expanded=new Set();
const MONEYK={din:1,dout:1,dcw:1,dcr:1,sub:1,usd:1};
// [id, plan $/mo, max possible API-value spend $/mo] — effective rate = price/max
// The max-spend figures are rough guesses and real usage can blow past them.
// Claude plan-mode dollars are additionally capped per month at the plan price
// (prorated for the in-progress month). Codex is intentionally uncapped.
const PLANS={
 claude:[['claude-pro',20,400],['claude-max-5x',100,2000],['claude-max-20x',200,8000]],
 codex:[['chatgpt-plus',20,700],['chatgpt-pro-5x',100,3500],['chatgpt-pro-20x',200,14000]]
};
let st=Object.assign({mode:'plan',claude:'claude-max-20x',codex:'chatgpt-pro-20x',machine:'all'},
 JSON.parse(localStorage.getItem('cc-pricing')||'{}'));
// URL params override saved state (shareable links): ?mode=api|plan&claude=<plan>&codex=<plan>&machine=<id|all>&expand=<n>
const urlQ=new URLSearchParams(location.search);
for(const k of ['mode','claude','codex','machine']) if(urlQ.get(k)) st[k]=urlQ.get(k);
const $=id=>document.getElementById(id);
const fmt=n=>n.toLocaleString();
const money=n=>n?'$'+n.toFixed(n<1?4:2):'<span class=dim>$0</span>';
function planOf(src){return PLANS[src].find(p=>p[0]===st[src])||PLANS[src][PLANS[src].length-1];}
function ratio(src){if(st.mode!=='plan')return 1;const p=planOf(src);return p[1]/p[2];}
// Monthly cap: Claude plan-$ for a calendar month can't exceed the plan price
// (prorated for the current month). capF['claude|2026-06']=0.15 means that
// month blew past the cap and every session in it is scaled down by 0.15.
let capF={};
function srcOf(s){return s.source==='codex'?'codex':'claude';}
function computeCaps(){
 capF={};
 if(st.mode!=='plan')return;
 const sums=new Map(); // 'src|YYYY-MM' -> raw API value
 for(const s of data){
  const src=srcOf(s);
  if(src==='codex')continue;
  const k=src+'|'+(s.last||'').slice(0,7);
  sums.set(k,(sums.get(k)||0)+s.usd);
 }
 const now=new Date(), curMk=now.toISOString().slice(0,7);
 for(const [k,api] of sums){
  const [src,mk]=k.split('|');
  const p=planOf(src);
  const raw=api*p[1]/p[2];
  let frac=1;
  if(mk===curMk){
   const dim=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
   frac=Math.min(1,now.getDate()/dim);
  }
  const cap=p[1]*frac;
  if(raw>cap)capF[k]=cap/raw;
 }
}
function fac(s){
 const src=srcOf(s), f=ratio(src);
 if(st.mode!=='plan')return f;
 return f*(capF[src+'|'+(s.last||'').slice(0,7)]||1);
}
function enrich(s){
 s.din=s.cat.in;s.dout=s.cat.out;s.dcw=s.cat.cw;s.dcr=s.cat.cr;
 s.sub=s.lane.sub;
 s.cacheshare=s.usd?((s.cat.cw+s.cat.cr)/s.usd*100):0;
 s.dur=(s.first&&s.last)?(new Date(s.last)-new Date(s.first))/6e4:0; // minutes
 return s;
}
function durStr(m){if(!m)return '';if(m<60)return Math.round(m)+'m';return (m/60).toFixed(1)+'h';}
// Cache warmth: can a resumed session still hit the provider's prompt cache?
// Anthropic: ~5-min TTL, refreshed on every request — predictable.
// OpenAI: prefixes may live longer, but eviction is unpredictable. Only show a
// visible countdown for the likely first 5 minutes; do not present the possible
// 60-minute tail as "hot cache" time.
const fmtAge=m=>m<1?'<1 min':Math.round(m)+' min';
function fmtCountdown(ms){
 const s=Math.max(0,Math.ceil(ms/1000));
 const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
 return h ? h+':'+String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0')
          : m+':'+String(sec).padStart(2,'0');
}
function warmInfo(last,src){
 if(!last)return null;
 const t=new Date(last).getTime();
 const now=Date.now();
 const age=(now-t)/6e4; // minutes since last activity
 if(age<0)return null;
 if(src==='claude'){
  const remaining=t+5*60e3-now;
  if(remaining>0)return ['♨️ '+fmtCountdown(remaining),'Prompt cache warm for about '+fmtCountdown(remaining)+' more — last activity '+fmtAge(age)+' ago. Anthropic keeps the cache ~5 minutes from last use (refreshed on every request), so resuming this session now will reuse the cached context. Claude cache lifetime is predictable.'];
 }else{
  const likely=t+5*60e3-now;
  if(likely>0)return ['♨️ '+fmtCountdown(likely),'Prompt cache probably warm for about '+fmtCountdown(likely)+' more — last activity '+fmtAge(age)+' ago. OpenAI caches prompt prefixes for roughly 5–60 minutes, but eviction is unpredictable — treat this as a good guess, not a guarantee (unlike Claude\\'s firm ~5-minute TTL).'];
 }
 return null;
}
function warmSpan(s){
 return '<span class=warm data-last="'+(s.last||'')+'" data-src="'+srcOf(s)+'"></span>';
}
function updateWarmth(){
 document.querySelectorAll('span.warm').forEach(el=>{
  const w=warmInfo(el.dataset.last,el.dataset.src);
  if(w){el.textContent=w[0];el.title=w[1];}
  else if(el.textContent){el.textContent='';el.title='';}
 });
}
setInterval(updateWarmth,1e3);
// Browser's local time zone (override with ?tz=Area/City) — DST-correct via
// Intl, formatted YYYY-MM-DD HH:MM
const TZ=urlQ.get('tz')||Intl.DateTimeFormat().resolvedOptions().timeZone;
const _kf=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function tzfmt(iso){if(!iso)return '';const d=(typeof iso==='number')?new Date(iso):new Date(iso);if(isNaN(d))return '';
 const p={};for(const x of _kf.formatToParts(d))p[x.type]=x.value;
 return p.year+'-'+p.month+'-'+p.day+' '+p.hour+':'+p.minute;}
function when(s){return tzfmt(s.last);}
function shortId(s){const id=s.id||'';const base=id.replace(/^agent-/,'');return base.slice(0,8);}
function esc(t){return String(t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function shortModel(model){return (model||'?').replace(/^claude-/,'');}
function displayName(s){
 let name=(s.cwd||'').replaceAll('\\\\','/').replace(HOME,'~');
 if(s.source==='codex') name=name.replace(/^codex\\//,'');
 if(s.source==='claude') name=name.replace(/^claude-/,'');
 return name;
}
function modelSwitch(s){
 if(!s.mainModels||s.mainModels.length<2)return '';
 return ' <span class=pill title="model switched mid-session: '+s.mainModels.map(shortModel).join(' → ')+'">🔀</span>';
}
function subCount(s){
 const a=s.subagentCount||0, w=s.workflowCount||0;
 if(!a&&!w)return '';
 const ag='🤖×'+a;
 if(w){
  const t='⚙️ included '+w+' Workflow run'+(w>1?'s':'')+' that spawned '+a+' agent thread'+(a>1?'s':'')+' — all usage merged into this session';
  return ' <span class="pill wf" title="'+t+'">⚙️ '+w+' workflow'+(w>1?'s':'')+' · '+ag+'</span>';
 }
 const t='spawned '+a+' subagent thread'+(a>1?'s':'')+' — usage merged into this session';
 return ' <span class=pill title="'+t+'">'+ag+'</span>';
}
function subworkerModels(s){
 const models=[...new Set((s.breakdown||[]).filter(b=>(b.sub||0)>0).map(b=>shortModel(b.model)))];
 if(!models.length)return '';
 const title=models.join(', ');
 const shown=models.slice(0,3).join(', ')+(models.length>3?' +'+(models.length-3):'');
 return ' <span class="pill sub" title="subworker models: '+title+'">sub '+shown+'</span>';
}
function sessionKey(s){return [(s.machine||'local'),(s.source||'claude'),(s.id||s.file||'')].join('|');}
function captureViewportAnchor(){
 const rows=[...document.querySelectorAll('#t > tbody > tr.s')];
 for(const tr of rows){
  const r=tr.getBoundingClientRect();
  if(r.bottom>0)return {key:tr.dataset.key,dy:r.top};
 }
 return null;
}
function restoreViewportAnchor(anchor){
 if(!anchor||!anchor.key)return;
 const tr=document.querySelector('#t > tbody > tr.s[data-key="'+CSS.escape(anchor.key)+'"]');
 if(!tr)return;
 const dy=tr.getBoundingClientRect().top-anchor.dy;
 if(dy)scrollBy(0,dy);
}
function visible(){
 let rows=data;
 if(st.machine!=='all') rows=rows.filter(s=>(s.machine||'local')===st.machine);
 if(q) rows=rows.filter(s=>displayName(s).toLowerCase().includes(q));
 return rows.slice();
}
function render(opts={}){
 const anchor=opts.preserveViewport?captureViewportAnchor():null;
 computeCaps();
 const rows=visible();
 rows.sort((a,b)=>{let x,y;
  if(sortK==='when'){x=a.last||'';y=b.last||'';}
  else if(sortK==='proj'){x=a.cwd;y=b.cwd;}
  else if(MONEYK[sortK]){x=a[sortK]*fac(a);y=b[sortK]*fac(b);}
  else {x=a[sortK];y=b[sortK];}
  return (x<y?-1:x>y?1:0)*(desc?-1:1);});
 const tb=document.querySelector('#t tbody');tb.innerHTML='';
 const bigCut=st.mode==='plan'?3*Math.min(ratio('claude'),ratio('codex')):3;
 // monthly summary rows (only when sorted chronologically)
 const byMonth=new Map();
 if(sortK==='when')for(const s of rows){
  const mk=(s.last||'').slice(0,7);
  const g=byMonth.get(mk)||{n:0,usd:0,api:0,cld:0,cdx:0,tok:0};
  g.n++;g.usd+=s.usd*fac(s);g.api+=s.usd;g.tok+=s.tokens;
  if(s.source==='codex')g.cdx+=s.usd*fac(s);else g.cld+=s.usd*fac(s);
  byMonth.set(mk,g);
 }
 let curMonth=null;
 for(const s of rows){
  if(sortK==='when'){
   const mk=(s.last||'').slice(0,7);
   if(mk!==curMonth){curMonth=mk;tb.appendChild(monthRow(mk,byMonth.get(mk)));}
 }
  const f=fac(s);
  const key=sessionKey(s);
  const tr=document.createElement('tr');tr.style.cursor='pointer';tr.className='s';
  tr.dataset.key=key;
  const badge=s.source==='codex'?'<span class="pill cdx">codex</span> ':'<span class="pill cld">claude</span> ';
  const machBadge=(machines.length>1&&st.machine==='all'&&(s.machine||'local')!=='local')
    ?'<span class="pill mach" title="machine: '+s.machine+'">'+machLabel(s.machine)+'</span> ':'';
  tr.innerHTML=
   '<td class="l mono dim">'+when(s)+' '+warmSpan(s)+'</td>'+
   '<td class="l proj mono">'+machBadge+badge+displayName(s)+
     ' <span class="sid" title="session id: '+(s.id||'')+'">#'+shortId(s)+'</span>'+
     modelSwitch(s)+subCount(s)+subworkerModels(s)+'</td>'+
   '<td>'+fmt(s.msgs)+'</td>'+
   '<td class=dim>'+durStr(s.dur)+'</td>'+
   '<td>'+fmt(s.tokens)+'</td>'+
   '<td class=dim>'+money(s.din*f)+'</td>'+
   '<td>'+money(s.dout*f)+'</td>'+
   '<td>'+money(s.dcw*f)+'</td>'+
   '<td class=cr>'+money(s.dcr*f)+'</td>'+
   '<td class=sub>'+money(s.sub*f)+'</td>'+
   '<td class="'+(s.usd*f>bigCut?'big':'')+'">'+money(s.usd*f)+(s.unpriced?' <span class=warn>?</span>':'')+'</td>'+
   '<td class=dim>'+s.cacheshare.toFixed(0)+'%</td>';
  const det=document.createElement('tr');det.dataset.key=key;det.style.display=expanded.has(key)?'':'none';
  det.innerHTML='<td colspan=12 class=l><div class=detail></div></td>';
  det.querySelector('.detail').innerHTML=detailHTML(s,f);
  wireChart(det.querySelector('.chartbox'),s,f);
  wireOpen(det,s);
  tr.onclick=()=>{
   const open=det.style.display==='none';
   det.style.display=open?'':'none';
   if(open)expanded.add(key);else expanded.delete(key);
  };
  tb.appendChild(tr);tb.appendChild(det);
 }
 renderTotals(rows);
 renderPrices();
 markSort();
 updateWarmth();
 restoreViewportAnchor(anchor);
}
function monthRow(mk,g){
 const tr=document.createElement('tr');tr.className='month';
 const name=mk?new Date(mk+'-15T00:00:00').toLocaleString('en',{month:'long',year:'numeric'}):'(no date)';
 tr.innerHTML='<td colspan=12 class=l>📅 <b>'+name+'</b> · '+g.n+' sessions · <b>'+money(g.usd)+'</b>'+
  (st.mode==='plan'?' <span class=dim>(🧾 '+money(g.api)+' API value)</span>':'')+
  ' · 🟠 '+money(g.cld)+' · 🟢 '+money(g.cdx)+' · '+fmt(g.tok)+' tok'+capNote(mk);
 return tr;
}
function capNote(mk){
 if(st.mode!=='plan')return '';
 const hit=['claude'].filter(src=>capF[src+'|'+mk]!==undefined);
 if(!hit.length)return '';
 const parts=hit.map(src=>(src==='claude'?'🟠':'🟢')+'×'+capF[src+'|'+mk].toFixed(3));
 return ' <span class=warn title="Claude API value × effective rate exceeded the plan price for this month — Claude plan-$ capped at the subscription cost (prorated for the current month); sessions scaled by the shown factor">⛔ capped '+parts.join(' ')+'</span>';
}
function detailHTML(s,f){
 const rows=s.breakdown.map(b=>
   '<tr><td class=l>'+shortModel(b.model)+(b.sub?' <span class=sub>(subwork $'+(b.sub*f).toFixed(2)+')</span>':'')+'</td>'+
   '<td>'+fmt(b.in)+'</td><td>'+fmt(b.out)+'</td><td>'+fmt(b.cw)+'</td>'+
   '<td class=cr>'+fmt(b.cr)+'</td><td class=big>'+money((b.usd||0)*f)+'</td></tr>').join('');
 const planNote=st.mode==='plan'
   ? '<span class=pill title="raw API list-price value of this session">🧾 API value '+money(s.usd)+'</span>'
   : '';
 const cat='<div style="margin:6px 0 2px">spend by category: '+
   '<span class=pill>input '+money(s.cat.in*f)+'</span>'+
   '<span class=pill>output '+money(s.cat.out*f)+'</span>'+
   '<span class=pill>cache write '+money(s.cat.cw*f)+'</span>'+
   '<span class="pill cr">cache read '+money(s.cat.cr*f)+'</span>'+
   '<span class=pill>main '+money(s.lane.main*f)+'</span>'+
   '<span class="pill sub">subworkers '+money(s.lane.sub*f)+'</span>'+planNote+'</div>';
 const spawn=(s.workflowCount||s.subagentCount)
   ? '<div class=mono style="margin:3px 0;color:#c4b5fd">'+
     (s.workflowCount?('⚙️ <b>'+s.workflowCount+'</b> Workflow run'+(s.workflowCount>1?'s':'')+' · '):'')+
     '🤖 <b>'+(s.subagentCount||0)+'</b> agent thread'+((s.subagentCount||0)>1?'s':'')+' spawned'+
     ' <span class=dim>(usage merged in)</span></div>'
   : '';
 const open=s.file
   ? '<div class=openbar>'+
     '<button class="obtn open-file" title="Open this transcript (.jsonl) in your default app">📄 Open transcript</button>'+
     '<button class="obtn open-dir" title="Open the folder that contains this transcript">📁 Show in folder</button>'+
     '<button class="obtn copy-path" title="Copy the full transcript path to the clipboard">📋 Copy path</button>'+
     '<code class=opath title="'+esc(s.file)+'">'+esc(s.file)+'</code>'+
     '<span class=ostat></span></div>'
   : '';
 return '<div class=mono dim style="margin:4px 0">'+s.id+'</div>'+open+spawn+cat+
  '<div class=chartbox></div>'+
  '<table class=inner><thead><tr><th class=l>model</th><th>input</th><th>output</th>'+
  '<th>cache write</th><th>cache read</th><th>$</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
// Wire the transcript open/reveal/copy buttons in a session's detail panel.
// Stopping propagation keeps a button click from toggling the row closed.
function wireOpen(det,s){
 const bar=det.querySelector('.openbar'); if(!bar||!s.file)return;
 const stat=bar.querySelector('.ostat');
 const flash=(msg,bad)=>{stat.textContent=msg;stat.style.color=bad?'#f87171':'#34d399';
  clearTimeout(stat._t);stat._t=setTimeout(()=>{stat.textContent='';},2500);};
 const hit=async(reveal)=>{
  try{
   const r=await fetch('/open?file='+encodeURIComponent(s.file)+(reveal?'&reveal=1':''));
   flash(r.ok?(reveal?'📁 opened folder':'📄 opened'):'⚠️ '+(await r.text()),!r.ok);
  }catch(e){flash('⚠️ '+e.message,true);}
 };
 bar.querySelector('.open-file').onclick=e=>{e.stopPropagation();hit(false);};
 bar.querySelector('.open-dir').onclick=e=>{e.stopPropagation();hit(true);};
 bar.querySelector('.copy-path').onclick=async e=>{e.stopPropagation();
  try{await navigator.clipboard.writeText(s.file);flash('📋 copied');}
  catch{flash('⚠️ copy blocked',true);}};
 bar.onclick=e=>e.stopPropagation();
}
// Cumulative-spend line chart with hover tooltip ($ spent by local time).
function wireChart(box,s,f){
 if(!box)return;
 const pts=(s.series||[]).slice().sort((a,b)=>a[0]-b[0]);
 if(pts.length<2){box.innerHTML='<h4>💵 Spend over time</h4>'+
  '<div class=dim style="font-size:11px">not enough per-message timing data</div>';return;}
 let acc=0;const cum=pts.map(([t,u])=>{acc+=u*f;return [t,acc];});
 const total=acc||1, t0=cum[0][0], t1=cum[cum.length-1][0]>t0?cum[cum.length-1][0]:t0+1;
 const W=560,H=150,padL=10,padR=10,padT=10,padB=20,iw=W-padL-padR,ih=H-padT-padB;
 const X=t=>padL+(t-t0)/(t1-t0)*iw, Y=v=>padT+ih-(v/total)*ih;
 let d='M';for(const [t,v] of cum)d+=' '+X(t).toFixed(1)+','+Y(v).toFixed(1)+' L';
 d=d.replace(/ L$/,'');
 const area=d+' L'+X(t1).toFixed(1)+','+(padT+ih)+' L'+X(t0).toFixed(1)+','+(padT+ih)+' Z';
 box.innerHTML='<h4>💵 Spend over time — total '+money(total)+
   ' <span class=dim style="font-weight:400">(hover for $ at a time)</span></h4>'+
  '<svg width='+W+' height='+H+'>'+
   '<path d="'+area+'" fill="#34d39914"/>'+
   '<path d="'+d+'" fill="none" stroke="#34d399" stroke-width="1.6"/>'+
   '<line class=guide x1=0 y1='+padT+' x2=0 y2='+(padT+ih)+' stroke="#7dd3fc" stroke-width=1 opacity=0/>'+
   '<circle class=dot r=3.2 fill="#7dd3fc" stroke="#0b0d13" opacity=0/>'+
   '<text class=axl x='+X(t0).toFixed(1)+' y='+(H-6)+' text-anchor=start>'+tzfmt(t0)+'</text>'+
   '<text class=axl x='+X(t1).toFixed(1)+' y='+(H-6)+' text-anchor=end>'+tzfmt(t1)+'</text>'+
   '<rect class=hit x=0 y=0 width='+W+' height='+H+' fill=transparent/>'+
  '</svg><div class=charttip></div>';
 const svg=box.querySelector('svg'),guide=box.querySelector('.guide'),
   dot=box.querySelector('.dot'),tip=box.querySelector('.charttip'),hit=box.querySelector('.hit');
 hit.onmousemove=e=>{
  const r=svg.getBoundingClientRect();
  const frac=Math.max(0,Math.min(1,(e.clientX-r.left-padL)/iw)), tt=t0+frac*(t1-t0);
  let lo=0,hi=cum.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(cum[mid][0]<tt)lo=mid+1;else hi=mid;}
  if(lo>0&&Math.abs(cum[lo-1][0]-tt)<Math.abs(cum[lo][0]-tt))lo--;
  const cx=X(cum[lo][0]),cy=Y(cum[lo][1]);
  guide.setAttribute('x1',cx);guide.setAttribute('x2',cx);guide.setAttribute('opacity',0.5);
  dot.setAttribute('cx',cx);dot.setAttribute('cy',cy);dot.setAttribute('opacity',1);
  tip.innerHTML='<b>'+money(cum[lo][1])+'</b> · '+tzfmt(cum[lo][0]);
  // SVG has no offsetLeft/offsetTop — derive the svg's offset within the box from
  // bounding rects, then clamp the center-anchored tooltip to the chart edges.
  const br=box.getBoundingClientRect(),sr2=svg.getBoundingClientRect();
  const ox=sr2.left-br.left,oy=sr2.top-br.top,half=(tip.offsetWidth||120)/2+2;
  tip.style.left=Math.max(ox+half,Math.min(ox+cx,ox+W-half))+'px';
  tip.style.top=(oy+cy)+'px';tip.style.opacity=1;
 };
 hit.onmouseleave=()=>{guide.setAttribute('opacity',0);dot.setAttribute('opacity',0);tip.style.opacity=0;};
}
function card(n,l,x){return '<div class=card><div class=n>'+n+'</div><div class=l>'+l+'</div>'+(x?'<div class=x>'+x+'</div>':'')+'</div>';}
function renderTotals(rows){
 const sum=f=>rows.reduce((a,s)=>a+f(s),0);
 const tot=sum(s=>s.usd*fac(s));
 const apiTot=sum(s=>s.usd);
 const c={in:sum(s=>s.cat.in*fac(s)),out:sum(s=>s.cat.out*fac(s)),
  cw:sum(s=>s.cat.cw*fac(s)),cr:sum(s=>s.cat.cr*fac(s)),sub:sum(s=>s.lane.sub*fac(s))};
 const cld=rows.filter(s=>s.source==='claude'), cdx=rows.filter(s=>s.source==='codex');
 const cldUsd=cld.reduce((a,s)=>a+s.usd*fac(s),0), cdxUsd=cdx.reduce((a,s)=>a+s.usd*fac(s),0);
 const pct=v=>tot?'<span class=dim style=font-size:12px> '+(v/tot*100).toFixed(0)+'%</span>':'';
 const plan=st.mode==='plan';
 $('totals').innerHTML=
  card(money(tot),plan?'plan-equivalent total':'total billable',plan?'🧾 '+money(apiTot)+' API value':'')+
  card(money(cldUsd),'🟠 claude ('+cld.length+')',plan?planOf('claude')[0]:'')+
  card(money(cdxUsd),'🟢 codex ('+cdx.length+')',plan?planOf('codex')[0]:'')+
  card(money(c.in)+pct(c.in),'input')+card(money(c.out)+pct(c.out),'output')+
  card(money(c.cw)+pct(c.cw),'cache write')+card(money(c.cr)+pct(c.cr),'cache read')+
  card(money(c.sub)+pct(c.sub),'subworkers');
}
function priceCell(raw,f){
 if(raw==null)return '<td class=dim>—</td>';
 const eff=raw*f;
 const main='$'+(eff<1?eff.toFixed(eff<0.1?3:2):eff.toFixed(2));
 if(f===1)return '<td>'+main+'</td>';
 return '<td>'+main+'<div class=raw title="API list price">$'+raw+'</div></td>';
}
function renderPrices(){
 const plan=st.mode==='plan';
 const fC=ratio('claude'), fO=ratio('codex');
 // Claude models: input / output / cache-write / cache-read per 1M tok
 const cRows=Object.entries(prices.claude).map(([m,p])=>
  '<tr><td class=l>'+shortModel(m)+'</td>'+priceCell(p.in,fC)+priceCell(p.out,fC)+
  priceCell(p.cw,fC)+priceCell(p.cr,fC)+'</tr>').join('');
 // OpenAI/Codex models: input / cached input / output per 1M tok
 const oRows=Object.entries(prices.openai).map(([m,p])=>
  '<tr><td class=l>'+m+'</td>'+priceCell(p.in,fO)+priceCell(p.cached,fO)+
  priceCell(p.out,fO)+'</tr>').join('');
 const note=plan?' <span class=raw style=font-size:11px>(effective rate; API list price below)</span>':'';
 $('pricesSummary').innerHTML='💲 Model prices (per 1M tokens) — '+
  (plan?'📦 '+planOf('claude')[0]+' / '+planOf('codex')[0]+' effective rates':'🧾 API list prices');
 $('priceGrid').innerHTML=
  '<div><h3>🟠 Claude'+(plan?' '+ratioStr('claude'):'')+note+'</h3>'+
  '<table class=price><thead><tr><th class=l>model</th><th>input</th><th>output</th>'+
  '<th>cache&nbsp;write</th><th>cache&nbsp;read</th></tr></thead><tbody>'+cRows+'</tbody></table></div>'+
  '<div><h3>🟢 OpenAI / Codex'+(plan?' '+ratioStr('codex'):'')+'</h3>'+
  '<table class=price><thead><tr><th class=l>model</th><th>input</th><th>cached&nbsp;in</th>'+
  '<th>output</th></tr></thead><tbody>'+oRows+'</tbody></table></div>';
}
function markSort(){
 document.querySelectorAll('#t thead th').forEach(th=>{
  const on=th.dataset.k===sortK;
  th.classList.toggle('on',on);
  th.innerHTML=th.innerHTML.replace(/ [▾▴]$/,'')+(on?(desc?' ▾':' ▴'):'');
 });
}
function saveSt(){localStorage.setItem('cc-pricing',JSON.stringify(st));}
function ratioStr(src){const p=planOf(src);return '×'+(p[1]/p[2]).toFixed(4).replace(/0+$/,'').replace(/\\.$/,'');}
function syncControls(){
 document.querySelectorAll('#modeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.m===st.mode));
 $('selClaude').value=st.claude; $('selCodex').value=st.codex;
 $('selClaude').disabled=$('selCodex').disabled=(st.mode!=='plan');
 $('multNote').textContent=st.mode==='plan'?('claude '+ratioStr('claude')+' · codex '+ratioStr('codex')):'';
 $('subNote').innerHTML=st.mode==='plan'
  ? '📦 Plan mode: every $ = API list cost × (plan price ÷ max possible monthly API spend). '+
    planOf('claude')[0]+' $'+planOf('claude')[1]+'/mo ÷ $'+fmt(planOf('claude')[2])+' · '+
    planOf('codex')[0]+' $'+planOf('codex')[1]+'/mo ÷ $'+fmt(planOf('codex')[2])+
    '. Claude months are capped at the plan price ⛔ (prorated for the current month); Codex stays uncapped. Click a column to sort.'
  : '🧾 API list prices · Opus $5/$25 · Sonnet $3/$15 · Fable $10/$50 per Mtok · cache-read 0.1× · cache-write 1.25× · GPT-5.5 $5/$0.50/$30 · GPT-5.4 $2.50/$0.25/$15 (checked 2026-06-11). Click a column to sort.';
}
function machLabel(id){const m=machines.find(m=>m.id===id);return m?m.label:id;}
function buildMachSeg(){
 const seg=$('machSeg');
 if(machines.length<2){seg.style.display='none';return;}
 if(!machines.some(m=>m.id===st.machine)&&st.machine!=='all')st.machine='all';
 seg.style.display='';
 seg.innerHTML='<button data-m=all>🌐 All</button>'+
  machines.map(m=>'<button data-m="'+m.id+'">'+m.label+'</button>').join('');
 seg.querySelectorAll('button').forEach(b=>{
  b.classList.toggle('on',b.dataset.m===st.machine);
  b.onclick=()=>{st.machine=b.dataset.m;saveSt();buildMachSeg();render();};
 });
}
function initControls(){
 for(const [src,sel] of [['claude','selClaude'],['codex','selCodex']]){
  $(sel).innerHTML=PLANS[src].map(p=>
   '<option value="'+p[0]+'">'+p[0]+' · $'+p[1]+'/mo (≤$'+fmt(p[2])+')</option>').join('');
  $(sel).onchange=e=>{st[src]=e.target.value;saveSt();syncControls();render();};
 }
 document.querySelectorAll('#modeSeg button').forEach(b=>b.onclick=()=>{
  st.mode=b.dataset.m;saveSt();syncControls();render();});
 $('q').oninput=e=>{q=e.target.value.trim().toLowerCase();render();};
 document.querySelectorAll('#t thead th').forEach(th=>th.onclick=()=>{
  const k=th.dataset.k; if(k===sortK)desc=!desc; else{sortK=k;desc=true;} render();});
 syncControls();
}
initControls();
function loadData(opts={}){
 if(loadingData)return;
 loadingData=true;
 const background=opts.background===true;
 const lo=$('loading');
 if(!background&&lo)lo.innerHTML='⏳ Scanning Claude &amp; Codex session logs… <div class=pbar><div></div></div>';
 fetch('/api').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(d=>{
  data=d.sessions.map(enrich);
  if(d.prices)prices=d.prices;
  machines=d.machines||[];
  buildMachSeg();
  render({preserveViewport:background});
  if(firstLoad){
   const n=+urlQ.get('expand')||0;
   document.querySelectorAll('#t > tbody > tr.s').forEach((tr,i)=>{if(i<n)tr.click();});
  }
  firstLoad=false;
 }).catch(err=>{
  if(!background)$('totals').innerHTML='<div class=loaderr>⚠️ Failed to load session data: '+err.message+
   '<button onclick="loadData()">↻ Retry</button></div>';
 }).finally(()=>{
  loadingData=false;
 });
}
loadData();
// Refetch often enough that a freshly-active session's "♨️ warm" countdown
// appears well inside the ~5-min cache window (also picks up new remote syncs).
setInterval(()=>loadData({background:true}),30e3);
</script></body></html>`;

// Every directory a transcript could legitimately live in — the built-in
// Claude/Codex roots plus any per-machine synced cache dirs. `/open` only
// honours paths under one of these so the endpoint can't be turned into an
// arbitrary-file opener.
function allowedRoots() {
  const roots = [ROOT, CODEX_ROOT];
  for (const m of MACHINES) {
    if (m.claudeRoot) roots.push(m.claudeRoot);
    if (m.codexRoot) roots.push(m.codexRoot);
  }
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

createServer(async (req, res) => {
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
  if (req.url === "/api") {
    const sessions = await collect();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      sessions,
      machines: MACHINES.map(({ id, label }) => ({ id, label })),
      prices: { claude: PRICES, openai: OPENAI_PRICES },
    }));
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  }
}).listen(PORT, () => {
  console.log(`claude-cost dashboard → http://localhost:${PORT}`);
});
