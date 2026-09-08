import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/history.js',import.meta.url),'utf8');
const context={module:{exports:{}},Intl};vm.runInNewContext(source,context);
const {costs,bucket,quota}=context.module.exports;
test('cost bins use each call, exclude out-of-range usage, and retain undated difference',()=>{
 const rows=[{source:'codex',usd:13,series:[[3600001,2],[7200001,3],[7200002,5]]}];
 const result=costs(rows,'hour',7000000,8000000);
 assert.equal(result.bins.length,1);assert.equal(result.bins[0].total,8);assert.equal(result.undated,3);
});
test('Kyiv days use calendar boundaries, including DST transitions',()=>{
 assert.equal(bucket(Date.parse('2026-09-07T01:00:00+03:00'),'day'),Date.parse('2026-09-07T00:00:00+03:00'));
 assert.equal(bucket(Date.parse('2026-03-29T16:00:00+03:00'),'day'),Date.parse('2026-03-29T00:00:00+02:00'));
 assert.equal(bucket(Date.parse('2026-10-25T16:00:00+02:00'),'day'),Date.parse('2026-10-25T00:00:00+03:00'));
});
test('bar segments use recorded call models, not session-wide proportional allocations',()=>{
 const rows=[{source:'codex',usd:10,breakdown:[{model:'a'},{model:'b'}],series:[[3600001,2,'a'],[3600002,3,'b'],[7200001,5,'b']]}];
 const result=costs(rows,'hour',0,8000000);
 assert.equal(result.bins[0].models['codex|a'].usd,2);
 assert.equal(result.bins[0].models['codex|b'].usd,3);
 assert.equal(result.bins[1].models['codex|b'].usd,5);
 assert.equal(costs(rows,'hour',0,8000000,'a').bins[0].total,2);
 for(const b of result.bins)assert.equal(Object.values(b.models).reduce((n,m)=>n+m.usd,0),b.total);
});
test('UI presentation has no HTML injection or imperative chart handlers',()=>{
 for(const file of ['app.js','studio.js','components.js','history.js']){
  const text=readFileSync(new URL('../public/'+file,import.meta.url),'utf8');
  assert.doesNotMatch(text,/dangerouslySetInnerHTML|\.innerHTML\s*=|\.onmousemove\s*=|\.onclick\s*=/);
 }
});
test('quota deltas exclude resets, missing hours and failed measurements',()=>{
 const s=(ts,remaining,resets=100)=>({ts:ts*3600000,sourceId:'a',provider:'claude',accountId:'acct',account:'a',status:'ok',windows:[{key:'weekly',label:'Weekly',remaining,resets}]});
 const samples=[s(1,80),s(2,70),s(3,100,200),s(6,90,200),{ts:6.5*3600000,provider:'claude',sourceId:'a',status:'error'},s(7,80,200)];
 const p=quota(samples)[0].points;
 assert.equal(p[1].delta,10);assert.equal(p[1].breakBefore,false);
 for(const i of [2,3,4]){assert.equal(p[i].delta,null);assert.equal(p[i].breakBefore,true);}
});
test('batch compaction retains true call-hour distribution on repeated merges',()=>{
 const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const fn=server.slice(server.indexOf('function aggregateRows('),server.indexOf('\nfunction ',server.indexOf('function aggregateRows(')+1));
 const c={createHash:createRequire(import.meta.url)('node:crypto').createHash,rowWeight:s=>s.groupCount||1};vm.createContext(c);vm.runInContext(fn+';this.aggregate=aggregateRows;',c);
 const row={source:'claude',first:'2026-09-07T01:00:00Z',last:'2026-09-07T09:00:00Z',usd:5,series:[[3600001,2],[7200001,3]],breakdown:[]};
 const a=c.aggregate([row,row],'key');const b=c.aggregate([a,row],'key');
 assert.equal(b.usd,15);assert.equal(b.series.length,2);assert.equal(b.series[0][1],6);assert.equal(b.series[1][1],9);
});

test('session reconciliation reuses unchanged rows and detects edits, additions and removals',()=>{
 const reconcile=context.module.exports.createRowCache();let builds=0;
 const make=rows=>reconcile(JSON.parse(JSON.stringify(rows)),r=>{builds++;r.enriched=true;return r;});
 const a={id:'a',machine:'local',source:'codex',series:[[1,2,'a']]};
 const first=make([a]);assert.equal(make([a]),first);assert.equal(builds,1);
 const added=make([a,{...a,id:'b'}]);assert.equal(added[0],first[0]);assert.equal(builds,2);
 const edited=make([{...a,series:[[1,3,'a']]}, {...a,id:'b'}]);
 assert.notEqual(edited[0],first[0]);assert.equal(edited[1],added[1]);
 assert.equal(make([]).length,0);
});

test('cached history reuses unchanged contributions, but expires calls and accepts corrections',()=>{
 const cached=context.module.exports.createCostCache();
 let reads=0;const series=[[100,2,'a'],[200,3,'b']];
 const row={source:'codex',usd:5,get series(){reads++;return series;}};
 const first=cached([row],'hour',0,300);const initialReads=reads;
 assert.equal(cached([row],'hour',0,400),first);assert.equal(reads,initialReads);
 assert.equal(cached([row],'hour',50,500),first);assert.equal(reads,initialReads);
 const added={source:'claude',usd:4,series:[[250,4,'c']]};
 assert.equal(cached([row,added],'hour',0,400).bins[0].total,9);
 assert.equal(reads,initialReads);
 assert.equal(cached([row],'hour',150,400).bins[0].total,3);
 assert.equal(cached([row],'hour',0,150).bins[0].total,2);
 const corrected={...row,usd:8,series:[[100,8,'a']]};
 assert.equal(cached([corrected],'hour',0,400).bins[0].total,8);
 assert.equal(cached([],'hour',0,400).bins.length,0);
});

test('quota keyboard navigation advances through hourly samples in daily chart mode',()=>{
 const fn=source.slice(source.indexOf(' function key(e,kind,'),source.indexOf(' function changeZoom('));
 const c={shown:[{points:[{ts:3600000},{ts:7200000},{ts:10800000}]}],start:0,end:14400000,
  active:null,gran:'day',UsageHistoryMath:context.module.exports,setPinned(){}};
 c.setActive=value=>{c.active=value;};vm.createContext(c);vm.runInContext(fn+';this.navigate=key;',c);
 const press=key=>c.navigate({key,preventDefault(){}},'quota');
 press('Home');assert.equal(c.active.ts,3600000);
 press('ArrowRight');assert.equal(c.active.ts,7200000);
 press('ArrowRight');assert.equal(c.active.ts,10800000);
 press('ArrowLeft');assert.equal(c.active.ts,7200000);
 press('Escape');assert.equal(c.active,null);
 c.navigate({key:'Home',preventDefault(){}},'quota',[{points:[{ts:7200000}]}]);assert.equal(c.active.ts,7200000);
});

test('Claude observations from multiple machines share account window charts',()=>{
 const samples=['local','remote'].map((machine,i)=>({provider:'claude',machine,sourceId:machine,accountId:machine,account:'same',ts:3600000+i,status:'ok',windows:[{key:'session',label:'5-hour',remaining:50,resets:100}]}));
 assert.equal(quota(samples).length,1);
});
