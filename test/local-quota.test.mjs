import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
test('local quota persists fresh hourly observations, preserves errors and skips stale readings',()=>{
 let lines='';const ctx={Date,Number,Math,JSON,DIR_ACCOUNT:{},console,localQuotaFile:'/fixture/history',dirname:()=>'/fixture',mkdirSync(){},readFileSync:()=>lines,appendFileSync:(_,line)=>{lines+=line;}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function localQuotaRows()'),source.indexOf('const quotaHistoryCache')),ctx);
 const a={dir:'/account',email:'account@example.com',windows:[{key:'session',label:'5-hour',pct:100,resets:'later'}]};
 const push=(accounts,t=3600000)=>ctx.recordLocalQuota({accounts,fetchedAt:new Date(t).toISOString()});
 push([a]);push([a]);assert.equal(ctx.localQuotaRows().length,1);assert.equal(ctx.localQuotaRows()[0].windows[0].remaining,0);
 push([{...a,staleAt:'earlier'}],7200000);assert.equal(ctx.localQuotaRows().length,1);
 push([{dir:'/account',error:'HTTP 401'}],7200000);push([a],7200001);assert.equal(ctx.localQuotaRows().length,3);
 push([{dir:'/other',loggedOut:true,error:'empty'}],7200001);assert.equal(ctx.localQuotaRows().at(-1).windows.length,0);
 assert.equal(lines.includes('accessToken'),false);
});
