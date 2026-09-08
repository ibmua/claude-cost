/* Shared, testable time-series math; no pricing or quota estimation here. */
const UsageHistoryMath = (() => {
 const zone='Europe/Kyiv', HOUR=3600000;
 const dates=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
 const offsets=new Intl.DateTimeFormat('en',{timeZone:zone,timeZoneName:'longOffset'}),dayStarts=new Map();
 function bucket(ts,gran){
  if(gran==='hour')return Math.floor(ts/HOUR)*HOUR;
  const parts=Object.fromEntries(dates.formatToParts(ts).map(p=>[p.type,p.value]));
  const utc=Date.UTC(+parts.year,+parts.month-1,+parts.day);
  if(dayStarts.has(utc))return dayStarts.get(utc);
  const offset=t=>{
   const text=offsets.formatToParts(t).find(p=>p.type==='timeZoneName').value;
   const m=text.match(/GMT([+-])(\d+):(\d+)/);return m?(m[1]==='-'?-1:1)*(+m[2]*60 + +m[3])*60000:0;
  };
  const start=utc-offset(utc-offset(utc));dayStarts.set(utc,start);return start;
 }
 function costs(rows,gran,after=0,before=Date.now(),modelFilter='all'){
  const bins=new Map();let undated=0;
  for(const row of rows){let dated=0;
   for(const [ts,usd,recordedModel] of row.series||[]){
    if(!Number.isFinite(ts)||!Number.isFinite(usd))continue;
    dated+=usd;if(ts<after||ts>before)continue;
    const model=recordedModel||(row.breakdown?.length===1?row.breakdown[0].model:'Unattributed model');
    if(modelFilter!=='all'&&model!==modelFilter)continue;
    const t=bucket(ts,gran);const b=bins.get(t)||{ts:t,total:0,claude:0,codex:0,ocgo:0,models:{}};
    const id=(row.source||'claude')+'|'+model;
    const m=b.models[id]||{id,model,provider:row.source||'claude',usd:0};m.usd+=usd;b.models[id]=m;
    b.total+=usd;b[row.source||'claude']=(b[row.source||'claude']||0)+usd;bins.set(t,b);
   }
   undated+=Math.max(0,(row.usd||0)-dated);
  }
  return {bins:[...bins.values()].sort((a,b)=>a.ts-b.ts),undated};
 }
 function quota(samples,after=0){
  const groups=new Map(),failures=new Map();
  for(const s of [...samples].sort((a,b)=>a.ts-b.ts)){
   if(s.ts<after)continue;
   const sourceKey=s.provider+'|'+s.sourceId;
   if(s.status!=='ok'){failures.set(sourceKey,s.ts);continue;}
   for(const w of s.windows||[]){
    if(!Number.isFinite(w.remaining))continue;
    const id=[s.provider,(s.provider==='claude'?s.account:null)||s.accountId||s.sourceId,w.key].join('|');
    const g=groups.get(id)||{id,provider:s.provider,account:s.account,label:w.label,points:[]};
    const prev=g.points.at(-1);
    // Do not connect across a missed hour, a failed attempt, or a quota reset.
    const failed=(failures.get(sourceKey)||0)>(prev?.ts||s.ts);
    const reset=!!prev&&(String(w.resets)!==String(prev.resets)||w.remaining>prev.remaining);
    g.points.push({...w,ts:s.ts,reset,breakBefore:!prev||reset||failed||s.ts-prev.ts>90*60000,delta:prev&&!reset&&!failed&&s.ts-prev.ts<=90*60000?prev.remaining-w.remaining:null});
    groups.set(id,g);
   }
  }
  return [...groups.values()];
 }
 // Reconcile raw snapshots before enrichment mutates them. Retain only current rows.
 function createRowCache(){
  let entries=new Map(),previous=[];
  return (rows,enrich=x=>x)=>{
   const next=new Map();const result=rows.map(raw=>{
    const key=JSON.stringify([raw.machine,raw.source,raw.id]);
    const signature=JSON.stringify(raw),old=entries.get(key);
    const entry=old?.signature===signature?old:{signature,row:enrich({...raw})};
    next.set(key,entry);return entry.row;
   });
   entries=next;
   if(result.length===previous.length&&result.every((row,i)=>row===previous[i]))return previous;
   return previous=result;
  };
 }
 function createCostCache(){
  const cache=new WeakMap();let previous=[],result=null;
  return (rows,gran,after=0,before=Date.now(),model='all')=>{
   const parts=rows.map(row=>{
    let entry=cache.get(row);
    if(!entry){const times=[];for(const [ts,usd] of row.series||[])if(Number.isFinite(ts)&&Number.isFinite(usd))times.push(ts);
     times.sort((a,b)=>a-b);entry={times,variants:new Map()};cache.set(row,entry);}
    // Time passing invalidates a contribution only when a boundary crosses a call.
    const bound=(value,inclusive)=>{let lo=0,hi=entry.times.length;while(lo<hi){const mid=(lo+hi)>>>1;
     if(entry.times[mid]<value||(inclusive&&entry.times[mid]===value))lo=mid+1;else hi=mid;}return lo;};
    const key=JSON.stringify([gran,bound(after,false),bound(before,true),model]);
    if(!entry.variants.has(key)){
     entry.variants.set(key,costs([row],gran,after,before,model));
     if(entry.variants.size>4)entry.variants.delete(entry.variants.keys().next().value);
    }
    return entry.variants.get(key);
   });
   if(result&&parts.length===previous.length&&parts.every((part,i)=>part===previous[i]))return result;
   const bins=new Map();let undated=0;
   for(const part of parts){undated+=part.undated;for(const b of part.bins){
    let out=bins.get(b.ts);if(!out){out={ts:b.ts,total:0,claude:0,codex:0,ocgo:0,models:{}};bins.set(b.ts,out);}
    out.total+=b.total;for(const provider of ['claude','codex','ocgo'])out[provider]+=b[provider];
    for(const m of Object.values(b.models)){if(!out.models[m.id])out.models[m.id]={...m,usd:0};out.models[m.id].usd+=m.usd;}
   }}
   previous=parts;return result={bins:[...bins.values()].sort((a,b)=>a.ts-b.ts),undated};
  };
 }
 return {bucket,costs,quota,HOUR,createRowCache,createCostCache};
})();
if(typeof module!=='undefined')module.exports=UsageHistoryMath;

function HistoryPanel({rows,stx,loading,cachedCosts}){
 const chartRef=useRef(null),[width,setWidth]=useState(1000);
 const [clock,setClock]=useState(()=>Date.now());
 useEffect(()=>{const tick=()=>{if(!document.hidden)setClock(Date.now());};const id=setInterval(tick,60000);document.addEventListener('visibilitychange',tick);return()=>{clearInterval(id);document.removeEventListener('visibilitychange',tick);};},[]);
 const timeFormatter=useMemo(()=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}),[]);
 const [gran,setGran]=useState('hour'),[history,setHistory]=useState(null),[error,setError]=useState('');
 const [selected,setSelected]=useState('all'),[active,setActive]=useState(null),[pinned,setPinned]=useState(false),[zoom,setZoom]=useState(null);
 useEffect(()=>{const el=chartRef.current;if(!el)return;const measure=()=>setWidth(Math.max(300,el.getBoundingClientRect().width));measure();const o=new ResizeObserver(measure);o.observe(el);return()=>o.disconnect();},[]);
 useEffect(()=>{let alive=true;const c=new AbortController();const refresh=()=>fetch('/api/quota-history',{signal:c.signal}).then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.json();}).then(d=>{if(alive){setHistory(old=>({...d,samples:JSON.stringify(old?.samples)===JSON.stringify(d.samples)?old.samples:d.samples}));setError('');}}).catch(e=>{if(alive&&e.name!=='AbortError')setError(e.message);});refresh();const timer=setInterval(()=>{if(!document.hidden)refresh();},60000);return()=>{alive=false;c.abort();clearInterval(timer);};},[]);
 useEffect(()=>{setActive(null);setPinned(false);setZoom(null);setSelected('all');},[stx.provider,stx.account,stx.model,stx.tf,gran]);
 const now=useMemo(()=>Date.now(),[rows,clock,stx.tf]);
 const after=tfEntry(stx.tf)[2]?now-tfEntry(stx.tf)[2]*864e5:0;
 const provider=stx.provider||'all';
 const samples=useMemo(()=>(history?.samples||[]).filter(s=>(provider==='all'||s.provider===(provider==='ocgo'?'opencode':provider))&&(stx.account==='all'||s.account===stx.account)),[history?.samples,provider,stx.account]);
 const cost=useMemo(()=>cachedCosts(rows,gran,UsageHistoryMath.bucket(after,'hour'),now,stx.model||'all'),[rows,gran,now,stx.model]);
 // Rebuild only when a boundary crosses an observation, not on every clock tick.
 const quotaBoundary=samples.reduce((latest,s)=>s.ts<after?Math.max(latest,s.ts):latest,-Infinity);
 const groups=useMemo(()=>UsageHistoryMath.quota(samples,after),[samples,quotaBoundary]);
 const shown=useMemo(()=>groups.filter(g=>selected==='all'||g.id===selected),[groups,selected]);
 const models=useMemo(()=>{const map=new Map();for(const b of cost.bins)for(const m of Object.values(b.models)){const old=map.get(m.id)||{...m,usd:0};old.usd+=m.usd;map.set(m.id,old);}return [...map.values()].sort((a,b)=>b.usd-a.usd||a.id.localeCompare(b.id));},[cost]);
 const color=id=>{let h=0;for(const c of id)h=(h*31+c.charCodeAt(0))>>>0;return 'hsl('+h%360+' 65% 68%)';};
 const earliest=useMemo(()=>Math.min(now,...cost.bins.map(b=>b.ts),...groups.flatMap(g=>g.points.map(p=>p.ts))),[now,cost,groups]);
 const fullStart=UsageHistoryMath.bucket(after||earliest,gran),fullEnd=Math.max(now,fullStart+3600000);
 const start=zoom?.[0]??fullStart,end=zoom?.[1]??fullEnd,left=62,right=18,plot=width-left-right;
 const x=t=>left+(t-start)/(end-start)*plot;
 const next=t=>gran==='hour'?t+3600000:UsageHistoryMath.bucket(t+36*3600000,'day');
 const bins=useMemo(()=>cost.bins.filter(b=>next(b.ts)>start&&b.ts<end),[cost,gran,start,end]);
 const max=useMemo(()=>Math.max(.001,...bins.map(b=>b.total)),[bins]);
 const fmtTime=t=>timeFormatter.format(t);
 const dollars=n=>'$'+n.toFixed(n<1?4:2);
 const tickCount=width<560?2:5,ticks=Array.from({length:tickCount},(_,i)=>start+(end-start)*i/(tickCount-1));
 const costRects=useMemo(()=>bins.map(b=>{
  const bx=x(Math.max(start,b.ts)),bw=Math.max(.4,x(Math.min(next(b.ts),end))-bx-2);let sum=0;
  return {ts:b.ts,segments:models.flatMap(m=>{const value=b.models[m.id]?.usd||0;if(!value)return [];
   const y=180-(sum+value)/max*155;sum+=value;return [{id:m.id,x:bx,y,width:bw,height:value/max*155,fill:color(m.id)}];})};
 }),[bins,models,start,end,width,max,gran]);
 const quotaPaths=useMemo(()=>shown.map(g=>{const points=g.points.filter(p=>p.ts>=start&&p.ts<=end).map(p=>({...p,x:x(p.ts),y:180-p.remaining*1.55}));
  return {id:g.id,points,path:points.map((p,i)=>(!i||p.breakBefore?'M':'L')+p.x+','+p.y).join(' '),fill:color(g.id)};
 }),[shown,start,end,width]);
 const axis=quota=>html`<g>${[0,.5,1].map(v=>html`<g key=${v}><line x1=${left} x2=${width-right} y1=${180-v*155} y2=${180-v*155} stroke="currentColor" opacity=".13"/><text x=${left-8} y=${184-v*155} textAnchor="end" fill="currentColor" fontSize="12">${quota?Math.round(v*100)+'%':dollars(max*v)}</text></g>`)}${ticks.map(t=>html`<text key=${t} x=${x(t)} y="206" textAnchor=${t===start?'start':t===end?'end':'middle'} fill="currentColor" fontSize="11">${fmtTime(t)}</text>`)}</g>`;
 function hit(e,kind,force=false){if(pinned&&!force)return;const rect=e.currentTarget.getBoundingClientRect();const px=(e.clientX-rect.left)/rect.width*width;const ts=Math.max(start,Math.min(end,start+(px-left)/plot*(end-start)));const bucket=UsageHistoryMath.bucket(ts,gran);setActive({ts, bucket,model:e.target.dataset?.model||null,kind});}
 function key(e,kind,chartGroups=shown){if(e.key==='Escape'){setActive(null);setPinned(false);return;}if(!['ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(e.key))return;e.preventDefault();if(e.key==='Enter'||e.key===' '){setPinned(v=>!v);return;}const times=kind==='quota'?[...new Set(chartGroups.flatMap(g=>g.points.map(p=>p.ts)))].filter(t=>t>=start&&t<=end).sort((a,b)=>a-b):bins.map(b=>b.ts);if(!times.length)return;let index=times.findIndex(t=>t>=((kind==='quota'?active?.ts:active?.bucket)??times[0]));if(index<0)index=times.length-1;index=e.key==='Home'?0:e.key==='End'?times.length-1:Math.max(0,Math.min(times.length-1,index+(e.key==='ArrowLeft'?-1:1)));const ts=times[index];setActive({ts,bucket:UsageHistoryMath.bucket(ts,gran),kind,model:null});setPinned(true);}
 function changeZoom(factor){const span=Math.max(3600000,Math.min(fullEnd-fullStart,(end-start)*factor));const center=active?.ts??(start+end)/2;const a=Math.max(fullStart,Math.min(fullEnd-span,center-span/2));setZoom(span>=fullEnd-fullStart?null:[a,a+span]);}
 const activeBin=active?cost.bins.find(b=>b.ts===active.bucket):null;
 const cursor=active&&active.ts>=start&&active.ts<=end?html`<line x1=${x(active.ts)} x2=${x(active.ts)} y1="16" y2="182" stroke="currentColor" strokeDasharray="4 4" opacity=".55" pointerEvents="none"/>`:null;
 const nearby=g=>{if(!active)return g.points.at(-1);const p=g.points.reduce((best,p)=>!best||Math.abs(p.ts-active.ts)<Math.abs(best.ts-active.ts)?p:best,null);return p&&Math.abs(p.ts-active.ts)<=90*60000?p:null;};
 const failures=samples.filter(s=>s.ts>=after&&s.status!=='ok'),sourceErrors=(history?.sources||[]).filter(s=>s.error);
 const selectedModel=activeBin?.models[active?.model];
 return html`<section class="desk-panel history-panel" aria-label="Usage history">
 <div class="desk-section-head"><h2>Cost & quota over time</h2><div class="history-controls"><${Seg}>${[['hour','Hours'],['day','Days']].map(([id,label])=>html`<${SegBtn} key=${id} on=${gran===id} onClick=${()=>setGran(id)}>${label}<//>`)}<//><button class="desk-icon" aria-label="Zoom in chart" title="Zoom in around selection" onClick=${()=>changeZoom(.5)}>＋</button><button class="desk-icon" aria-label="Zoom out chart" disabled=${!zoom} onClick=${()=>changeZoom(2)}>−</button><button class="desk-icon" aria-label="Reset chart zoom" disabled=${!zoom} onClick=${()=>setZoom(null)}>⤢</button></div></div>
 <p>Stacked by model · API prices · Europe/Kyiv · edge buckets may be partial.</p>
 <h3>API-equivalent spend <small>${loading?'Updating…':dollars(bins.reduce((n,b)=>n+b.total,0))+' in view'}</small></h3>
 <div class="history-plot">
 <svg ref=${chartRef} viewBox=${'0 0 '+width+' 222'} tabIndex="0" role="application" aria-label=${'API cost by '+gran+'. Hover or tap to inspect. Arrow keys select buckets; Enter pins; Escape clears.'} onPointerMove=${e=>hit(e,'cost')} onClick=${e=>{hit(e,'cost',true);setPinned(v=>!v);}} onPointerLeave=${()=>{if(!pinned)setActive(null);}} onKeyDown=${e=>key(e,'cost')}>
 ${axis(false)}${costRects.map(b=>html`<g key=${b.ts}>${b.segments.map(m=>html`<rect key=${m.id} data-model=${m.id} x=${m.x} y=${m.y} width=${m.width} height=${m.height} fill=${m.fill} opacity=${active?.model&&active.model!==m.id?'.4':'1'} stroke=${active?.bucket===b.ts&&active?.model===m.id?'currentColor':'none'} strokeWidth="1"/>`)}</g>`)}${cursor}
 </svg>
 </div>
 <div class="history-readout" role=${active?.kind==='cost'?'tooltip':undefined} aria-label="Cost chart details">
  <div><strong>${active?fmtTime(active.bucket):'Explore cost history'}</strong>${pinned?html`<button class="desk-icon" aria-label="Unpin chart selection" onClick=${()=>{setPinned(false);setActive(null);}}>×</button>`:null}</div>
  <div>${selectedModel?html`<span><i style=${{background:color(selectedModel.id)}}/>${shortModel(selectedModel.model)} <b>${dollars(selectedModel.usd)}</b></span>`:html`<span>${active?'All models in this bucket':'Hover a model segment to inspect its cost'}</span>`}<span>Bucket total <b>${active?dollars(activeBin?.total||0):'—'}</b></span></div>
  <small>${pinned?'Pinned · click or Escape to release':'Hover or tap · click to pin · ← → explore · Esc clears'}</small>
 </div>
 <div class="history-legend" aria-label="Model legend">${models.map(m=>html`<span key=${m.id}><i style=${{background:color(m.id)}}/>${shortModel(m.model)} <small>${dollars(activeBin?.models[m.id]?.usd??m.usd)}</small></span>`)}</div>
 ${!loading&&!bins.length?html`<p>No recorded cost matches these filters.</p>`:null}
 ${cost.undated>.001?html`<p>ⓘ ${dollars(cost.undated)} without call timestamps is excluded.</p>`:null}
 ${['claude','codex'].filter(id=>provider==='all'||provider===id).map(id=>{
 const chartLabel=id==='claude'?'Claude':'Codex',chartGroups=groups.filter(g=>g.provider===id),chartShown=shown.filter(g=>g.provider===id);
 const latest=new Map();for(const s of samples.filter(s=>s.provider===id).sort((a,b)=>a.ts-b.ts))latest.set(s.sourceId,s);
 const chartFailures=[...latest.values()].filter(s=>s.status!=='ok');
 return html`<section key=${id} aria-label=${chartLabel+' quota'}>
 <div class="desk-section-head"><h3>${chartLabel} quota remaining</h3><select aria-label=${chartLabel+' quota series'} value=${chartGroups.some(g=>g.id===selected)?selected:'all'} onChange=${e=>setSelected(e.target.value)}><option value="all">All matching windows</option>${chartGroups.map(g=>html`<option key=${g.id} value=${g.id}>${g.provider} · ${g.account} · ${g.label}</option>`)}</select></div>
 <svg viewBox=${'0 0 '+width+' 222'} tabIndex="0" role="application" aria-label=${chartLabel+' quota history. Hover or tap to inspect; arrow keys select samples.'} onPointerMove=${e=>hit(e,'quota')} onClick=${e=>{hit(e,'quota',true);setPinned(v=>!v);}} onPointerLeave=${()=>{if(!pinned)setActive(null);}} onKeyDown=${e=>key(e,'quota',chartShown)}>
 ${axis(true)}${quotaPaths.filter(g=>chartShown.some(s=>s.id===g.id)).map(g=>html`<g key=${g.id}><path d=${g.path} fill="none" stroke=${g.fill} strokeWidth="2"/>${g.points.map(p=>html`<circle key=${p.ts} cx=${p.x} cy=${p.y} r=${active&&Math.abs(p.ts-active.ts)<30*60000?6:4} fill=${g.fill}/>`)}</g>`)}${cursor}
 </svg>
 <div class="history-quota-readout" role=${active?.kind==='quota'?'tooltip':undefined} aria-label=${chartLabel+' quota chart details'}><strong>${active?fmtTime(active.ts):'Latest quota readings · hover the chart to explore'}</strong>
 <div class="history-legend" aria-label=${chartLabel+' quota readings'}>${chartShown.map(g=>{const p=nearby(g);return html`<span key=${g.id}><i style=${{background:color(g.id)}}/>${g.account} · ${g.label}: <b>${p?p.remaining+'% left':'No nearby sample'}</b>${p?html`<small>${fmtTime(p.ts)}${p.reset?' · reset / recovery':p.delta===null?'':' · '+p.delta.toFixed(1)+' percentage points used'}</small>`:null}</span>`;})}</div>
 </div>
 ${!chartGroups.length?html`<p>${history?'No successful '+chartLabel+' quota samples match these filters yet.':'Loading quota history…'}</p>`:chartGroups.every(g=>g.points.length===1)?html`<p>First snapshot recorded. The next hourly sample begins the trend.</p>`:null}
 ${chartFailures.length?html`<div role="status">${chartFailures.map(s=>html`<p key=${s.sourceId}>⚠ ${s.account||s.sourceId} · ${s.error} · ${fmtTime(s.ts)}</p>`)}</div>`:null}
 </section>`;})}
 ${provider==='ocgo'?html`<p>No OpenCode quota source is configured. Recorded costs are shown above.</p>`:null}
 ${error||sourceErrors.length?html`<p role="alert">⚠ ${error||sourceErrors.map(s=>s.machine+': '+s.error+(s.stale?' (cached samples)':'')).join('; ')}</p>`:null}
 ${failures.length?html`<details><summary>⚠ ${failures.length} unsuccessful quota reads</summary>${failures.slice(-12).map((s,i)=>html`<p key=${i}>${fmtTime(s.ts)} · ${s.provider} · ${s.sourceId}: ${s.error}</p>`)}</details>`:null}
 <p class="history-note">Quota covers the account across machines. Provider and account filters apply to both charts; project/model filters narrow cost only. Lines break at resets, failed reads and missing hours. Quota is observed hourly, including in daily mode.</p>
 </section>`;
}
