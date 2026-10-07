/* React 18 + htm. All UI, charts and interactions render through React.
 * App owns shared state/data; components.js owns reusable presentation. */
const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } = React;
const html = htm.bind(React.createElement);
const $ = (id) => document.getElementById(id);

// ── module globals the reused helpers read (kept in sync from React state) ──
const HOME = (window.__CC && window.__CC.HOME) || "";
let data = [], prices = { claude: {}, openai: {} }, names = {}, machines = [];
let throttled = { count: 0, byMachine: {}, newest: "" }, curWindowDays = 7, curWindowHours = 0, curWindowCutoff = 0, capF = {};
let compaction = { rawCount: 0, shownRows: 0, groupedSessions: 0 };
let ACCOUNTS = []; // distinct account labels present in the loaded data (multi-account)
let MODELS = []; // distinct main models present in the loaded data (for the model filter)
let st, sortK = "when", desc = true, q = "", showEmpty = false; // mirrored from state each render

// ── pure helpers (ported verbatim) ─────────────────────────────────────────
function scanWindowFor(days){ if(days===0||days>30)return 0; if(days>7)return 30; return 7; }
function winRank(w){ return w===0?Infinity:w; }
const MONEYK={din:1,dout:1,dcw:1,dcr:1,sub:1,usd:1};
const PLANS={
 claude:[['claude-pro',20,300],['claude-max-5x',100,1500],['claude-max-20x',200,6000]],
 codex:[['chatgpt-plus',20,350],['chatgpt-pro-5x',100,1750],['chatgpt-pro-20x',200,7000]]
};
// [state key, label, client-filter days, exact server-scan hours (optional)].
// The explicit hour field keeps 5h a true rolling window rather than rounding
// it to a calendar day or fetching a misleading 24-hour API total.
const TIMEFRAMES=[['5h','5h',5/24,5],['24h','24h',1],['7d','7d',7],['30d','30d',30],['90d','90d',90],['all','All',0]];
function tfEntry(id=st.tf){return TIMEFRAMES.find(t=>t[0]===id)||TIMEFRAMES.find(t=>t[0]==='7d');}
function tfDays(){return tfEntry()[2];}
function tfCutoffISO(){const d=tfDays();return d?new Date(Date.now()-d*864e5).toISOString():null;}
const fmt=n=>n.toLocaleString();
function planOf(src){return PLANS[src].find(p=>p[0]===st[src])||PLANS[src][PLANS[src].length-1];}
// OpenCode Go is a flat subscription with no plan-vs-API ratio, so it has no PLANS entry:
// treat it as factor 1 in plan mode rather than crashing on planOf(undefined).
function ratio(src){if(st.mode!=='plan')return 1;if(!PLANS[src])return 1;const p=planOf(src);return p[1]/p[2];}
function srcOf(s){return s.source==='codex'?'codex':s.source==='ocgo'?'ocgo':'claude';}
function computeCaps(){
 capF={};
 if(st.mode!=='plan')return;
 const sums=new Map();
 for(const s of data){
  const src=srcOf(s);
  if(src!=='claude')continue;   // caps are Claude-plan only; codex + ocgo have no such cap
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
 s.dur=(s.first&&s.last)?(new Date(s.last)-new Date(s.first))/6e4:0;
 return s;
}
function durStr(m){if(!m)return '';if(m<60)return Math.round(m)+'m';return (m/60).toFixed(1)+'h';}
const CLAUDE_TTL_MS=60*60e3;
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
 const age=(now-t)/6e4;
 if(age<0)return null;
 if(src==='claude'){
  const remaining=t+CLAUDE_TTL_MS-now;
  if(remaining>0)return ['♨️ '+fmtCountdown(remaining),'Prompt cache warm for about '+fmtCountdown(remaining)+' more — last activity '+fmtAge(age)+' ago. On a Claude subscription the main conversation keeps its prompt cache ~1 HOUR from last use (Claude Code auto-requests the 1h TTL, refreshed on every request), so resuming this session now reuses the cached context. Note: subagents, over-usage-limit, and API-key sessions drop back to a ~5-minute TTL.'];
 }else{
  const likely=t+5*60e3-now;
  if(likely>0)return ['♨️ '+fmtCountdown(likely),'Prompt cache probably warm for about '+fmtCountdown(likely)+' more — last activity '+fmtAge(age)+' ago. OpenAI caches prompt prefixes for roughly 5–60 minutes, but eviction is unpredictable — treat this as a good guess, not a guarantee (unlike Claude\'s predictable subscription TTL).'];
 }
 return null;
}
const urlQ=new URLSearchParams(location.search);
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
 let name=(s.cwd||'').replaceAll('\\','/').replace(HOME,'~');
 if(s.source==='codex') name=name.replace(/^codex\//,'');
 if(s.source==='claude') name=name.replace(/^claude-/,'');
 return name;
}
function machLabel(id){const m=machines.find(m=>m.id===id);return m?m.label:id;}
const ACCT_PALETTE=['#7dd3fc','#f472b6','#34d399','#fbbf24','#c084fc','#fb923c'];
function acctColor(a){const i=ACCOUNTS.indexOf(a);return ACCT_PALETTE[(i<0?0:i)%ACCT_PALETTE.length];}
function sessionKey(s){return [(s.machine||'local'),(s.source||'claude'),(s.id||s.file||'')].join('|');}
function rowWeight(s){return s.groupCount||1;}
function ratioStr(src){const p=planOf(src);return '×'+(p[1]/p[2]).toFixed(4).replace(/0+$/,'').replace(/\.$/,'');}
// live-limits panel
function lvl(pct){ return pct>=90?'crit':pct>=70?'warn':'ok'; }
function until(iso){
 if(!iso)return '';
 const ms=new Date(iso)-new Date();
 if(isNaN(ms))return '';
 if(ms<=0)return 'due now';
 const m=Math.round(ms/60000),h=Math.floor(m/60),d=Math.floor(h/24);
 if(d>=1)return 'in '+d+'d '+(h%24)+'h';
 if(h>=1)return 'in '+h+'h '+(m%60)+'m';
 return 'in '+m+'m';
}
// ── column model ────────────────────────────────────────────────────────────
const COLS=[
 {k:'when',label:'When',l:true},
 {k:'proj',label:'Project',l:true},
 {k:'msgs',label:'Msgs'},{k:'dur',label:'Dur'},{k:'tokens',label:'Tokens'},
 {k:'din',label:'$ in'},{k:'dout',label:'$ out'},
 {k:'dcw',label:'$ cache‑wr'},{k:'dcr',label:'$ cache‑rd'},
 {k:'sub',label:'$ subwork'},{k:'usd',label:'$ Total'},{k:'cacheshare',label:'cache%'},
];
const GRID='152px minmax(220px,1fr) 56px 56px 92px 74px 74px 98px 98px 88px 96px 62px';

const Row=React.memo(NativeSessionRow);

// ── React expandable detail and lazy per-call ledger ───────────────────────
function LedgerCalls({s,f}){
 const [open,setOpen]=useState(false);
 const [calls,setCalls]=useState(null);
 const [error,setError]=useState('');
 useEffect(()=>{
  if(!open||calls||error)return;
  const windowQ=curWindowCutoff?'&after='+curWindowCutoff:'';
  fetch('/api/ledger-calls?id='+encodeURIComponent(s.id)+windowQ)
   .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
   .then(d=>setCalls(d.calls||[]))
   .catch(e=>setError(e.message));
 },[open,calls,error,s.id]);
 if(!s.callCount)return null;
 return html`<div class="ledger-calls">
  <button class=${'ledger-toggle'+(open?' open':'')} onClick=${()=>setOpen(v=>!v)} aria-expanded=${open}>
   <span>${open?'▾':'▸'}</span> ${open?'Hide':'View'} ${fmt(s.callCount)} individual calls
  </button>
  ${open&&!calls&&!error?html`<div class="ledger-state">⏳ Loading individual calls…</div>`:null}
  ${open&&error?html`<div class="ledger-state warn">⚠️ Could not load calls: ${error} <button onClick=${()=>setError('')}>↻ Retry</button></div>`:null}
  ${open&&calls?html`<div class="ledger-call-wrap"><table class="ledger-call-table">
   <thead><tr><th class="l">when</th><th class="l">page / call</th><th class="l">status</th><th>input</th><th>output</th><th>cache write</th><th>cache read</th><th>tokens</th><th>$</th></tr></thead>
   <tbody>${calls.map((c,i)=>html`<tr key=${c.ts+'|'+i} class=${c.empty?'empty-call':''}>
    <td class="l mono">${tzfmt(Date.parse(c.ts))}</td>
    <td class="l mono call-slug" title=${c.tag||''}>${c.slug||c.tag||'(untagged)'}</td>
    <td class="l">${c.error?html`<span class="call-error" title=${c.error}>⚠ error</span>`:c.empty?html`<span class="call-empty">○ zero-token</span>`:html`<span class="call-ok">✓ ok</span>`}</td>
    <td>${fmt(c.in)}</td><td>${fmt(c.out)}</td><td>${fmt(c.cw)}</td><td class="cr">${fmt(c.cr)}</td><td>${fmt(c.tokens)}</td><td class="big"><${Money} value=${c.cost.total*f}/></td>
   </tr>`)}</tbody>
  </table></div>`:null}
 </div>`;
}

function Detail(props){return html`<${NativeDetail} ...${props}/>`;}
function MonthRow(props){return html`<${NativeMonthRow} ...${props}/>`;}

// ── virtualized table body (window-scroll, measured dynamic heights) ─────────
function VirtualTable({rows,expanded,onToggle,bigCut}){
 const wrapRef=useRef();
 const meas=useRef(new Map());          // item key -> measured height
 const [range,setRange]=useState({top:0,h:800});
 const [mv,setMv]=useState(0);          // bump to recompute offsets after measuring

 const items=useMemo(()=>{
  const out=[];
  const showMonths=(sortK==='when');
  let byMonth=null;
  if(showMonths){
   byMonth=new Map();
   for(const s of rows){
    const mk=(s.last||'').slice(0,7);
    const g=byMonth.get(mk)||{n:0,usd:0,api:0,cld:0,cdx:0,tok:0};
    g.n+=rowWeight(s);g.usd+=s.usd*fac(s);g.api+=s.usd;g.tok+=s.tokens;
    if(s.source==='codex')g.cdx+=s.usd*fac(s);else g.cld+=s.usd*fac(s);
    byMonth.set(mk,g);
   }
  }
  let cur=null;
  for(const s of rows){
   if(showMonths){const mk=(s.last||'').slice(0,7); if(mk!==cur){cur=mk; out.push({type:'month',key:'m|'+mk,mk,g:byMonth.get(mk)});}}
   out.push({type:'row',key:sessionKey(s),s});
  }
  return out;
 },[rows]);

 const EST={month:38,row:29,detail:340};
 const heightOf=useCallback((it)=>{
  const m=meas.current.get(it.key);
  if(m!=null)return m;
  if(it.type==='month')return EST.month;
  return expanded.has(it.key)?EST.row+EST.detail:EST.row;
 },[expanded]);

 const offsets=useMemo(()=>{
  const off=new Float64Array(items.length+1);
  for(let i=0;i<items.length;i++)off[i+1]=off[i]+heightOf(items[i]);
  return off;
 },[items,expanded,mv,heightOf]);
 const total=offsets[items.length]||0;

 // recompute the visible window from window-scroll position
 const recompute=useCallback(()=>{
  const el=wrapRef.current; if(!el)return;
  const vt=-el.getBoundingClientRect().top;   // container-space y at viewport top
  setRange({top:vt, h:window.innerHeight});
 },[]);
 useEffect(()=>{
  recompute();
  const onScroll=()=>recompute();
  window.addEventListener('scroll',onScroll,{passive:true});
  window.addEventListener('resize',onScroll);
  return ()=>{window.removeEventListener('scroll',onScroll);window.removeEventListener('resize',onScroll);};
 },[recompute]);
 useEffect(()=>{recompute();},[items.length,expanded]); // layout above may shift

 // binary search: largest i with offsets[i] <= y
 const bisect=(y)=>{ let lo=0,hi=items.length; while(lo<hi){const m=(lo+hi)>>1; if(offsets[m]<=y)lo=m+1;else hi=m;} return lo-1; };
 const over=8;
 let start=bisect(range.top)-over; if(start<0)start=0;
 let end=bisect(range.top+range.h)+over; if(end>items.length-1)end=items.length-1; if(end<start)end=start;

 const vis=[];
 for(let i=start;i<=end && items.length;i++) vis.push({i,it:items[i],top:offsets[i]});

 // measure rendered items; if a height changed, remember it and re-layout once
 const measureRef=(key)=>(el)=>{
  if(!el)return;
  const h=el.getBoundingClientRect().height;
  if(h>0 && Math.abs((meas.current.get(key)||-1)-h)>1){ meas.current.set(key,h); queueMv(); }
 };
 const mvRaf=useRef(0);
 const queueMv=()=>{ if(mvRaf.current)return; mvRaf.current=requestAnimationFrame(()=>{mvRaf.current=0;setMv(v=>v+1);}); };

 return html`<div class="cc-body" ref=${wrapRef} style=${{position:'relative',height:total+'px'}}>
   ${vis.map(({it,top})=> it.type==='month'
     ? html`<div key=${it.key} class="cc-abs" style=${{top:top+'px'}} ref=${measureRef(it.key)}><${MonthRow} mk=${it.mk} g=${it.g}/></div>`
     : html`<div key=${it.key} class="cc-abs" style=${{top:top+'px'}} ref=${measureRef(it.key)}>
         <${Row} s=${it.s} f=${fac(it.s)} bigCut=${bigCut} open=${expanded.has(it.key)} onToggle=${()=>onToggle(it.key)}/>
         ${expanded.has(it.key) ? html`<${Detail} s=${it.s} f=${fac(it.s)}/>` : null}
       </div>`) }
 </div>`;
}

// ── header controls ─────────────────────────────────────────────────────────
function Seg({children}){ return html`<div class="seg">${children}</div>`; }
function SegBtn({on,onClick,children,title}){
 return html`<button class=${on?'on':''} title=${title||''} onClick=${onClick}>${children}</button>`;
}
function TableHead({sortK,desc,onSort}){
 return html`<div class="cc-head" style=${{gridTemplateColumns:GRID}}>
   ${COLS.map(c=>html`<div key=${c.k} class=${'cc-th'+(c.l?' l':'')+(c.k===sortK?' on':'')} onClick=${()=>onSort(c.k)}>${c.label}${c.k===sortK?(desc?' ▾':' ▴'):''}</div>`)}
 </div>`;
}

// ── root ────────────────────────────────────────────────────────────────────
function App(){
 const [stx,setStx]=useState(()=>{
  let s=Object.assign({mode:'plan',claude:'claude-max-20x',codex:'chatgpt-pro-20x',machine:'all',account:'all',model:'all',provider:'all',tf:'7d'},
    JSON.parse(localStorage.getItem('cc-pricing')||'{}'));
  for(const k of ['mode','claude','codex','machine','account','model','provider','tf']) if(urlQ.get(k)) s[k]=urlQ.get(k);
  if(s.provider==='opencode')s.provider='ocgo';
  if(!['all','claude','codex','ocgo'].includes(s.provider))s.provider='all';
  return s;
 });
 const [ver,setVer]=useState(0);        // bumped when data (module globals) changes
 const [qx,setQx]=useState('');
 const [sk,setSk]=useState('when'); const [dsc,setDsc]=useState(true);
 const [empty,setEmpty]=useState(urlQ.get('empty')==='1');
 const [expanded,setExpanded]=useState(()=>new Set());
 const [usage,setUsage]=useState(null);
 const [loading,setLoading]=useState(true); const [err,setErr]=useState('');
 const firstLoad=useRef(true);
 const requestRef=useRef(null);
 const requestSeq=useRef(0);
 const requestCache=useRef(new Map());
 const reconcileRows=useMemo(()=>UsageHistoryMath.createRowCache(),[]);
 const previousVisible=useRef([]);
 const visiblePlan=useRef('');

 // keep module globals in sync so the reused helpers read current state
 st=stx; sortK=sk; desc=dsc; q=qx; showEmpty=empty;
 const persist=(s)=>{ setStx(s); localStorage.setItem('cc-pricing',JSON.stringify(s)); const u=new URL(location.href);if(s.provider==='all')u.searchParams.delete('provider');else u.searchParams.set('provider',s.provider);history.replaceState(null,'',u); };

 const loadData=useCallback((opts={})=>{
  const timeframe=tfEntry(stx.tf);
  const hours=timeframe[3]||0;
  const want=scanWindowFor(timeframe[2]);
  let url=hours?('/api?hours='+hours):want?('/api?days='+want):'/api?all=1';
  if(empty)url+='&empty=1';
  if(opts.background&&requestRef.current)return;
  requestRef.current?.abort();
  const controller=new AbortController();requestRef.current=controller;
  const seq=++requestSeq.current;
  if(!opts.background)setLoading(true);
  // Reuse a recent identical scan when switching between client-side timeframes.
  // Explicit refresh bypasses this bounded in-memory cache; no private logs are persisted.
  const hit=requestCache.current.get(url);
  const fromCache=!opts.force&&hit&&Date.now()-hit.at<30000;
  const response=fromCache
    ? Promise.resolve(hit.payload)
    : fetch(url,{signal:controller.signal}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(payload=>{
       if(seq===requestSeq.current){requestCache.current.set(url,{at:Date.now(),payload});
       if(requestCache.current.size>2)requestCache.current.delete(requestCache.current.keys().next().value);}
       return payload;
      });
  response.then(d=>{
   if(seq!==requestSeq.current)return;
   data=reconcileRows(d.sessions,enrich);
   compaction=d.compaction||{rawCount:data.length,shownRows:data.length,groupedSessions:0};
   ACCOUNTS=[...new Set(data.map(s=>s.account).filter(Boolean))].sort();
   MODELS=[...new Set(data.flatMap(s=>s.mainModels||[]).filter(Boolean))].sort();
   throttled=d.throttled||{count:0,byMachine:{},newest:''};
   curWindowHours=d.windowHours||0;
   curWindowDays=d.windowDays||0;
   curWindowCutoff=d.windowCutoff||0;
   if(d.prices)prices=d.prices;
   if(d.names&&!fromCache)names=d.names;
   machines=d.machines||[];
   setErr(''); setLoading(false); setVer(v=>v+1);
   if(firstLoad.current){
    firstLoad.current=false;
    const n=+urlQ.get('expand')||0;
    if(n>0){ // auto-expand the first N visible rows
     setTimeout(()=>{
      const rows=visibleSorted();
      setExpanded(new Set(rows.slice(0,n).map(sessionKey)));
     },0);
    }
   }
  }).catch(e=>{ if(e.name!=='AbortError'&&seq===requestSeq.current){setErr(e.message);setLoading(false);} }).finally(()=>{if(seq===requestSeq.current)requestRef.current=null;});
 },[stx.tf,empty]);

 useEffect(()=>{ loadData(); return ()=>{requestRef.current?.abort();requestRef.current=null;requestSeq.current++;}; },[loadData]);                 // initial + when tf/empty change
 useEffect(()=>{ const id=setInterval(()=>{if(!document.hidden)loadData({background:true});},120e3); return ()=>clearInterval(id); },[loadData]);
 useEffect(()=>{ const f=()=>fetch('/api/usage').then(r=>r.json()).then(setUsage).catch(()=>{});
   f(); const id=setInterval(()=>{if(!document.hidden)f();},60e3); return ()=>clearInterval(id); },[]);

 useEffect(()=>{ window.ccToggleEmpty=()=>{
   setEmpty(e=>{ const nv=!e; const u=new URL(location.href); if(nv)u.searchParams.set('empty','1');else u.searchParams.delete('empty'); history.replaceState(null,'',u); return nv; });
 }; },[]);

 // filtered + sorted rows (recompute only on inputs that matter — NOT warmth ticks)
 function visibleSorted(){
  computeCaps();
  let rows=data;
  const cutoff=tfCutoffISO();
  if(cutoff) rows=rows.filter(s=>(s.last||'')>=cutoff);
  if(stx.provider&&stx.provider!=='all') rows=rows.filter(s=>srcOf(s)===stx.provider);
  if(stx.machine!=='all') rows=rows.filter(s=>(s.machine||'local')===stx.machine);
  if(stx.account&&stx.account!=='all') rows=rows.filter(s=>(s.account||'')===stx.account);
  if(stx.model&&stx.model!=='all') rows=rows.filter(s=>(s.mainModels||[]).includes(stx.model));
  if(qx) rows=rows.filter(s=>displayName(s).toLowerCase().includes(qx));
  rows=rows.slice();
  rows.sort((a,b)=>{let x,y;
   if(sk==='when'){x=a.last||'';y=b.last||'';}
   else if(sk==='proj'){x=a.cwd;y=b.cwd;}
   else if(MONEYK[sk]){x=a[sk]*fac(a);y=b[sk]*fac(b);}
   else {x=a[sk];y=b[sk];}
   return (x<y?-1:x>y?1:0)*(dsc?-1:1);});
  const planKey=JSON.stringify([stx.mode,stx.claude,stx.codex,capF]);
  const samePlan=visiblePlan.current===planKey;visiblePlan.current=planKey;
  const previous=previousVisible.current;
  if(samePlan&&previous.length===rows.length&&rows.every((row,i)=>row===previous[i]))return previous;
  return previousVisible.current=rows;
 }
 const rows=useMemo(visibleSorted,[ver,stx.mode,stx.claude,stx.codex,stx.machine,stx.account,stx.model,stx.provider,stx.tf,qx,sk,dsc,empty]);
 const bigCut=stx.mode==='plan'?3*Math.min(ratio('claude'),ratio('codex')):3;

 const onSort=useCallback((k)=>{ if(k===sk)setDsc(d=>!d); else{setSk(k);setDsc(true);} },[sk]);
 const onToggle=useCallback((key)=>{ setExpanded(prev=>{const n=new Set(prev); n.has(key)?n.delete(key):n.add(key); return n;}); },[]);





 const compactNote=compaction.groupedSessions
  ? `📦 ${compaction.groupedSessions.toLocaleString()} older same-run sessions are shown as exact aggregate rows; newest sessions remain individual.`
  : '';

 return html`<${UsageDesk}
  stx=${stx} setSt=${persist} q=${qx} setQ=${setQx} rows=${rows} usage=${usage}
  loading=${loading} err=${err} reload=${()=>loadData({force:true})} expanded=${expanded}
  onToggle=${onToggle} bigCut=${bigCut} sk=${sk} dsc=${dsc} onSort=${onSort} empty=${empty} compactNote=${compactNote}/>`;

}

{
 document.body.classList.add('usage-desk');
 try{document.body.dataset.deskTheme=localStorage.getItem('cc-desk-theme')==='light'?'light':'dark';}catch{document.body.dataset.deskTheme='dark';}
 document.title='Usage desk · Claude Cost';
 const css=document.createElement('link');css.rel='stylesheet';css.href='/studio.css?v=sole-desk-20261007';document.head.appendChild(css);
}
ReactDOM.createRoot(document.getElementById('root')).render(html`<${App}/>`);
