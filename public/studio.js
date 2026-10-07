/* Usage desk: presentation only. App owns fetching, filtering, pricing and expansion. */
const DESK_VIEWS=[['sessions','▤','Sessions'],['history','◷','History'],['models','◈','Model spend'],['limits','◴','Account limits'],['prices','⚙','Plans & prices']];
function UsageDesk({stx,setSt,q,setQ,rows,usage,loading,err,reload,expanded,onToggle,bigCut,sk,dsc,onSort,empty,compactNote}){
 const [view,setView]=useState(()=>new URLSearchParams(location.search).get('panel')==='history'?'history':'sessions');
 // Keep row contributions when History unmounts during panel navigation.
 const historyCosts=useMemo(()=>UsageHistoryMath.createCostCache(),[]);
 const [wide,setWide]=useState(false);
 const [theme,setTheme]=useState(()=>{try{return localStorage.getItem('cc-desk-theme')==='light'?'light':'dark';}catch{return 'dark';}});
 useLayoutEffect(()=>{document.body.dataset.deskTheme=theme;try{localStorage.setItem('cc-desk-theme',theme);}catch{}},[theme]);
 const set=patch=>setSt({...stx,...patch});
 const {total,api,count,providers}=useMemo(()=>{
  const providers=PROVIDERS.map(p=>({...p,value:0}));
  const byId=Object.fromEntries(providers.map(p=>[p.id,p]));
  let total=0,api=0,count=0;
  for(const s of rows){const value=s.usd*fac(s);total+=value;api+=s.usd;count+=rowWeight(s);byId[srcOf(s)].value+=value;}
  return {total,api,count,providers};
 },[rows]);
 const pending=loading&&!data.length;
 const go=id=>{setView(id);const u=new URL(location.href);if(id==='history')u.searchParams.set('panel','history');else u.searchParams.delete('panel');history.replaceState(null,'',u);window.scrollTo({top:0});};
 const moneyNode=n=>pending?html`<span class=desk-placeholder aria-label=Loading>—</span>`:html`<${Money} value=${n}/>`;
 return html`<div class=${'desk '+(wide?'desk-wide':'')}>
  <aside class="desk-rail"><a class="desk-brand" href="?empty=1"><span class="desk-mark">◒</span><strong>Usage desk</strong></a>
   <p class="desk-caption">Your AI, accounted for.</p>
   <nav aria-label="Dashboard views">${DESK_VIEWS.map(([id,icon,label])=>html`<button key=${id} aria-current=${view===id?'page':null} class=${view===id?'active':''} onClick=${()=>go(id)}><span aria-hidden="true">${icon}</span>${label}</button>`)}</nav>
   <div class="desk-rail-bottom"><span>Private · on this machine</span></div>
  </aside>
  <main class="desk-main">
   <header class="desk-header"><div><h1>${DESK_VIEWS.find(v=>v[0]===view)[2]}</h1><p>${view==='sessions'?'Follow the work. See where the usage goes.':view==='history'?'Compare API-price usage with changes in account quota.':view==='models'?'Compare cost, tokens, and reasoning across your models.':view==='limits'?'Live account quotas, separate from estimated spend.':'Choose how usage translates into cost.'}</p></div>
    <div class="desk-actions"><button class="desk-icon" aria-label=${theme==='dark'?'Switch to light theme':'Switch to dark theme'} title=${theme==='dark'?'Switch to light theme':'Switch to dark theme'} onClick=${()=>setTheme(t=>t==='dark'?'light':'dark')}>${theme==='dark'?'☀':'☾'}</button><${Seg}>${[['plan','📦 Plan'],['api','🧾 API']].map(([id,label])=>html`<${SegBtn} key=${id} on=${stx.mode===id} onClick=${()=>set({mode:id})}>${label}<//>`)}<//><button class="desk-icon" aria-label="Refresh session data" title="Refresh session data" disabled=${loading} onClick=${reload}>↻</button></div>
   </header>
   <div class="desk-toolbar"><${Seg}>${TIMEFRAMES.map(t=>html`<${SegBtn} key=${t[0]} on=${stx.tf===t[0]} onClick=${()=>set({tf:t[0]})}>${t[1]}<//>`)}<//><span class="desk-scope">${loading?(data.length?'Updating… previous results shown':'Loading sessions…'):fmt(count)+' sessions in view'}</span></div>
   <section class="desk-overview" aria-label="Spend overview" aria-busy=${loading}><div class="desk-total"><span>${stx.mode==='plan'?'Plan-equivalent spend':'API-equivalent spend'}</span><strong>${moneyNode(total)}</strong><small>${pending?'Reading local and remote usage…':stx.mode==='plan'?html`${moneyNode(api)} at API prices`:'Estimated from recorded token usage'}</small></div>
    <div class="desk-allocation"><div class="desk-meter" aria-label="Spend by provider">${providers.map(p=>html`<span key=${p.id} style=${{width:(total?p.value/total*100:0)+'%',background:p.color}} title=${p.label}/>` )}</div><div class="desk-providers">${providers.map(p=>html`<div key=${p.id}><span><i style=${{background:p.color}}/>${p.label}</span><strong>${moneyNode(p.value)}</strong></div>`)}</div><p>${stx.mode==='plan'?'Plan estimates use your selected plans. Claude’s monthly cap still applies.':'Input, output and cache costs use the configured model rates.'}</p></div>
   </section>
   ${err?html`<div class="desk-error" role="alert">⚠ ${err} <button onClick=${reload}>Retry</button></div>`:null}
   ${html`<div class="desk-filters"><label class="desk-search"><span aria-hidden="true">⌕</span><textarea rows="1" aria-label="Search projects" placeholder="Find a project or session…" value=${q} onInput=${e=>setQ(e.target.value.toLowerCase())}/></label>
    <${ProviderFilter} value=${stx.provider} onChange=${provider=>set({provider,model:'all'})}/>
    <select aria-label="Machine" value=${stx.machine} onChange=${e=>set({machine:e.target.value})}><option value="all">🌐 All machines</option>${machines.map(m=>html`<option key=${m.id} value=${m.id}>${m.label}</option>`)}</select>
    <select aria-label="Account" value=${stx.account} onChange=${e=>set({account:e.target.value})}><option value="all">👤 All accounts</option>${ACCOUNTS.map(a=>html`<option key=${a} value=${a}>${a}</option>`)}</select>
    <select aria-label="Model" value=${stx.model} onChange=${e=>set({model:e.target.value})}><option value="all">◈ All models</option>${MODELS.map(m=>html`<option key=${m} value=${m}>${shortModel(m)}</option>`)}</select>
    <button class=${empty?'desk-empty active':'desk-empty'} aria-pressed=${empty} onClick=${()=>window.ccToggleEmpty()}>○ Empty attempts ${fmt(throttled.count||0)}</button>
   </div>`}
   ${view==='sessions'?html`<section class="desk-sessions"><div class="desk-section-head"><h2>Session ledger</h2><div><select aria-label="Sort sessions" value=${sk} onChange=${e=>onSort(e.target.value)}>${COLS.map(c=>html`<option key=${c.k} value=${c.k}>${c.label}</option>`)}</select><button class="desk-icon" aria-label="Reverse sort order" onClick=${()=>onSort(sk)}>${dsc?'↓':'↑'}</button><button class="desk-empty" aria-pressed=${wide} onClick=${()=>setWide(v=>!v)}>☷ ${wide?'Fewer columns':'All columns'}</button></div></div>
    <details class="desk-note"><summary>ⓘ Session details</summary><p>Select a session for token breakdown, charts, transcript links, and individual calls. Click its name to rename.</p></details>
    ${compactNote?html`<details class="desk-note"><summary>ⓘ Older sessions are grouped</summary><p>${compactNote}</p></details>`:null}
    ${!loading&&!rows.length?html`<div class="desk-blank">No matching sessions. Try a wider timeframe or clear your filters.<button onClick=${()=>{setQ('');set({machine:'all',account:'all',model:'all',provider:'all'});}}>Clear filters</button></div>`:null}
    <div class="wrap"><${TableHead} sortK=${sk} desc=${dsc} onSort=${onSort}/><${VirtualTable} key=${wide?'wide':'compact'} rows=${rows} expanded=${expanded} onToggle=${onToggle} bigCut=${bigCut}/></div>
    </section>`:null}
   ${view==='history'?html`<${HistoryPanel} rows=${rows} stx=${stx} loading=${loading} cachedCosts=${historyCosts}/>`:null}
   ${view==='models'?html`<section class="desk-panel"><h2>Spend by model</h2><div class="desk-model-table"><${ModelSpend} rows=${rows}/></div><details><summary>Token and cost breakdown</summary><${TotalsPanel} rows=${rows}/></details></section>`:null}
   ${view==='limits'?html`<section class="desk-panel"><${LimitsPanel} usage=${usage} provider=${stx.provider} account=${stx.account}/></section>`:null}
   ${view==='prices'?html`<section class="desk-panel"><h2>Your plans</h2><p>Plan mode converts API value using your calibrated monthly allowance.</p><div class="desk-plan-pickers">${[['claude','Claude'],['codex','ChatGPT']].map(([src,label])=>html`<label key=${src}>${label}<select aria-label=${label+' plan'} value=${stx[src]} onChange=${e=>set({[src]:e.target.value})}>${PLANS[src].map(p=>html`<option key=${p[0]} value=${p[0]}>${p[0]} · $${p[1]}/month · $${fmt(p[2])} API value</option>`)}</select><small>${ratioStr(src)} of API cost in plan mode</small></label>`)}</div><p>Claude totals are capped at the selected monthly price, prorated for the current month. Codex is uncapped. OpenCode retains its API value.</p><h2>Model rates <small>per million tokens</small></h2><${PriceTables}/><p>Standard rates. Astra requests above 272K input tokens use the higher tier. Separate Codex cache writes and speed-tier surcharges are not accounted.</p></section>`:null}
  </main>
 </div>`;
}
