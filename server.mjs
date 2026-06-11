#!/usr/bin/env node
// Tiny dashboard: dollar cost of every past Claude Code session.
// Scans ~/.claude/projects/**/*.jsonl, prices tokens per model, serves a page.
//   node server.mjs            -> http://localhost:8799
//   PORT=9000 node server.mjs

import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(homedir(), ".claude", "projects");
const CODEX_ROOT = join(homedir(), ".codex", "sessions");
const PORT = process.env.PORT || 8799;

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
  "claude-sonnet-4-6": { in: 3, out: 15, cw: 3.75, cr: 0.3 },
  "claude-sonnet-4-5": { in: 3, out: 15, cw: 3.75, cr: 0.3 },
  "claude-haiku-4-5":  { in: 1, out: 5,  cw: 1.25, cr: 0.1 },
  sonnet:              { in: 3, out: 15, cw: 3.75, cr: 0.3 },
};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
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
  let cwd = null, first = null, last = null, msgs = 0;
  let subagentName = isSubagentFile
    ? file.split("/").pop().replace(".jsonl", "").replace(/^agent-/, "")
    : null;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!cwd && o.cwd) cwd = o.cwd;
    subagentName = o.attributionAgent || o.agentId || subagentName;
    if (o.timestamp) { first = first || o.timestamp; last = o.timestamp; }
    const u = o?.message?.usage;
    if (!u) continue;
    msgs++;
    const model = o?.message?.model || "unknown";
    const lane = (o.isSidechain || isSubagentFile) ? "sub" : "main";
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
    cwd: displayCwd,
    mainModels,
    first, last, msgs, usd, tokens, unpriced, breakdown, lane, cat,
    realCwd: cwd,
    parentSessionId: isSubagentFile ? file.split("/").at(-3) : null,
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
  let model = null, first = null, last = null, msgs = 0, total = null;
  let cwd = null, threadId = null, parentThreadId = null;
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
          // Subagent rollouts replay the parent's whole history and inherit its
          // cumulative total_token_usage counter — summing them double-counts the
          // parent's work once per subagent (~7.7x inflation measured). The parent
          // main session's final total already includes all subagent usage, so
          // skip these files entirely (also saves streaming GBs of replayed log).
          rl.close();
          return { codexSubagentOf: parentThreadId, name: codexSubagentName(meta.source) };
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
      const m = line.match(/"total_token_usage":\{([^}]*)\}/);
      if (m) { total = m[1]; msgs++; }
    }
  }
  if (!total) return null;
  const num = (k) => { const m = total.match(new RegExp(`"${k}":(\\d+)`)); return m ? +m[1] : 0; };
  const inputTot = num("input_tokens");          // includes cached
  const cached = num("cached_input_tokens");
  const out = num("output_tokens");               // includes reasoning
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
  // total_token_usage on a main thread is cumulative across the whole
  // parent+subagent tree, so this single number already covers subagent work.
  return {
    source: "codex",
    id: file.split("/").pop().replace("rollout-", "").replace(".jsonl", "").slice(0, 33),
    threadId,
    cwd: "codex/" + (model || "?"),
    first, last, msgs, usd, tokens, unpriced,
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

async function collect() {
  const claudeRaw = walk(ROOT).map((f) => { const s = scanSession(f); if (s) s.source = "claude"; return s; }).filter(Boolean);
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
  try { codexFiles = walk(CODEX_ROOT); } catch {}
  const codex = [];
  const codexSubCount = new Map(); // parent threadId -> spawned subagent threads
  for (const f of codexFiles) {
    try {
      const r = await cachedScan(f, scanCodex);
      if (!r) continue;
      if (r.codexSubagentOf !== undefined) {
        if (r.codexSubagentOf)
          codexSubCount.set(r.codexSubagentOf, (codexSubCount.get(r.codexSubagentOf) || 0) + 1);
        continue;
      }
      codex.push(r);
    } catch {}
  }
  for (const s of codex) {
    if (codexSubCount.has(s.threadId)) s.subagentCount = codexSubCount.get(s.threadId);
  }
  const sessions = [...claude, ...codex].filter((s) => s && s.tokens > 0);
  sessions.sort((a, b) => (b.last || "").localeCompare(a.last || ""));
  return sessions;
}

const PAGE = `<!doctype html><html><head><meta charset=utf8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>💸 Claude Code session costs</title>
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
 .warn{color:#f59e0b} .big{color:#f87171;font-weight:600}
 .cr{color:#fbbf24} td.cr{color:#fbbf24}
 .pill.cdx{background:#10b98122;color:#34d399} .pill.cld{background:#6366f122;color:#a5b4fc}
 tr.month td{background:#141927;color:#a8b0c2;font-size:12px;border-top:1px solid #2a3147;border-bottom:1px solid #2a3147;padding:9px 12px}
 tr.month b{color:#e6e6e6}
 .detail{padding:8px 0 14px}
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
  <label class=plansel title="Anthropic plan (plan price ÷ max possible monthly API spend)">🟠 <select id=selClaude></select></label>
  <label class=plansel title="OpenAI / ChatGPT plan (plan price ÷ max possible monthly API spend)">🟢 <select id=selCodex></select></label>
  <span class=mult id=multNote></span>
  <input class=search id=q placeholder="🔍 filter projects…">
 </div>
 <div class=sub id=subNote></div>
</header>
<div class=totals id=totals></div>
<div class=wrap><table id=t><thead><tr>
 <th class=l data-k=when>When</th><th class=l data-k=proj>Project</th>
 <th data-k=msgs>Msgs</th><th data-k=dur>Dur</th><th data-k=tokens>Tokens</th>
 <th data-k=din>$ in</th><th data-k=dout>$ out</th>
 <th data-k=dcw>$ cache&#8209;wr</th><th data-k=dcr>$ cache&#8209;rd</th>
 <th data-k=sub>$ subwork</th><th data-k=usd>$ Total</th><th data-k=cacheshare>cache%</th>
</tr></thead><tbody></tbody></table></div>
<script>
let data=[], sortK='when', desc=true, q='';
const MONEYK={din:1,dout:1,dcw:1,dcr:1,sub:1,usd:1};
// [id, plan $/mo, max possible API-value spend $/mo] — effective rate = price/max
const PLANS={
 claude:[['claude-pro',20,400],['claude-max-5x',100,2000],['claude-max-20x',200,8000]],
 codex:[['chatgpt-plus',20,700],['chatgpt-pro-5x',100,3500],['chatgpt-pro-20x',200,14000]]
};
let st=Object.assign({mode:'plan',claude:'claude-max-20x',codex:'chatgpt-pro-20x'},
 JSON.parse(localStorage.getItem('cc-pricing')||'{}'));
// URL params override saved state (shareable links): ?mode=api|plan&claude=<plan>&codex=<plan>&expand=<n>
const urlQ=new URLSearchParams(location.search);
for(const k of ['mode','claude','codex']) if(urlQ.get(k)) st[k]=urlQ.get(k);
const $=id=>document.getElementById(id);
const fmt=n=>n.toLocaleString();
const money=n=>n?'$'+n.toFixed(n<1?4:2):'<span class=dim>$0</span>';
function planOf(src){return PLANS[src].find(p=>p[0]===st[src])||PLANS[src][PLANS[src].length-1];}
function ratio(src){if(st.mode!=='plan')return 1;const p=planOf(src);return p[1]/p[2];}
function fac(s){return ratio(s.source==='codex'?'codex':'claude');}
function enrich(s){
 s.din=s.cat.in;s.dout=s.cat.out;s.dcw=s.cat.cw;s.dcr=s.cat.cr;
 s.sub=s.lane.sub;
 s.cacheshare=s.usd?((s.cat.cw+s.cat.cr)/s.usd*100):0;
 s.dur=(s.first&&s.last)?(new Date(s.last)-new Date(s.first))/6e4:0; // minutes
 return s;
}
function durStr(m){if(!m)return '';if(m<60)return Math.round(m)+'m';return (m/60).toFixed(1)+'h';}
function when(s){return (s.last||'').replace('T',' ').slice(0,16);}
function shortModel(model){return (model||'?').replace(/^claude-/,'');}
function displayName(s){
 let name=(s.cwd||'').replace('/home/i','~');
 if(s.source==='codex') name=name.replace(/^codex\\//,'');
 if(s.source==='claude') name=name.replace(/^claude-/,'');
 return name;
}
function modelSwitch(s){
 if(!s.mainModels||s.mainModels.length<2)return '';
 return ' <span class=pill title="model switched mid-session: '+s.mainModels.map(shortModel).join(' → ')+'">🔀</span>';
}
function subCount(s){
 if(s.source!=='codex'||!s.subagentCount)return '';
 return ' <span class=pill title="spawned '+s.subagentCount+' subagent thread(s); their usage is already included in this session\'s totals">🤖×'+s.subagentCount+'</span>';
}
function subworkerModels(s){
 const models=[...new Set((s.breakdown||[]).filter(b=>(b.sub||0)>0).map(b=>shortModel(b.model)))];
 if(!models.length)return '';
 const title=models.join(', ');
 const shown=models.slice(0,3).join(', ')+(models.length>3?' +'+(models.length-3):'');
 return ' <span class="pill sub" title="subworker models: '+title+'">sub '+shown+'</span>';
}
function visible(){
 if(!q) return data.slice();
 return data.filter(s=>displayName(s).toLowerCase().includes(q));
}
function render(){
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
  const tr=document.createElement('tr');tr.style.cursor='pointer';tr.className='s';
  const badge=s.source==='codex'?'<span class="pill cdx">codex</span> ':'<span class="pill cld">claude</span> ';
  tr.innerHTML=
   '<td class="l mono dim">'+when(s)+'</td>'+
   '<td class="l proj mono">'+badge+displayName(s)+modelSwitch(s)+subCount(s)+subworkerModels(s)+'</td>'+
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
  const det=document.createElement('tr');det.style.display='none';
  det.innerHTML='<td colspan=12 class=l><div class=detail></div></td>';
  det.querySelector('.detail').innerHTML=detailHTML(s,f);
  tr.onclick=()=>{det.style.display=det.style.display==='none'?'':'none';};
  tb.appendChild(tr);tb.appendChild(det);
 }
 renderTotals(rows);
 markSort();
}
function monthRow(mk,g){
 const tr=document.createElement('tr');tr.className='month';
 const name=mk?new Date(mk+'-15T00:00:00').toLocaleString('en',{month:'long',year:'numeric'}):'(no date)';
 tr.innerHTML='<td colspan=12 class=l>📅 <b>'+name+'</b> · '+g.n+' sessions · <b>'+money(g.usd)+'</b>'+
  (st.mode==='plan'?' <span class=dim>(🧾 '+money(g.api)+' API value)</span>':'')+
  ' · 🟠 '+money(g.cld)+' · 🟢 '+money(g.cdx)+' · '+fmt(g.tok)+' tok';
 return tr;
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
 return '<div class=mono dim style="margin:4px 0">'+s.id+'</div>'+cat+
  '<table class=inner><thead><tr><th class=l>model</th><th>input</th><th>output</th>'+
  '<th>cache write</th><th>cache read</th><th>$</th></tr></thead><tbody>'+rows+'</tbody></table>';
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
    planOf('codex')[0]+' $'+planOf('codex')[1]+'/mo ÷ $'+fmt(planOf('codex')[2])+'. Click a column to sort.'
  : '🧾 API list prices · Opus $5/$25 · Sonnet $3/$15 · Fable $10/$50 per Mtok · cache-read 0.1× · cache-write 1.25× · GPT-5.5 $5/$0.50/$30 · GPT-5.4 $2.50/$0.25/$15 (checked 2026-06-11). Click a column to sort.';
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
fetch('/api').then(r=>r.json()).then(d=>{
 data=d.sessions.map(enrich);
 render();
 const n=+urlQ.get('expand')||0;
 document.querySelectorAll('#t > tbody > tr.s').forEach((tr,i)=>{if(i<n)tr.click();});
});
</script></body></html>`;

createServer(async (req, res) => {
  if (req.url === "/api") {
    const sessions = await collect();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions }));
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  }
}).listen(PORT, () => {
  console.log(`claude-cost dashboard → http://localhost:${PORT}`);
});
