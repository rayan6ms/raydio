import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./browser_checkpoint.js',import.meta.url),'utf8');
const failed={requestedSeconds:21600,status:'failed',finishedAt:'preflight'};
const window={raydioEndurance:{report:failed}};
let tick,deadline,writes=0,fail=false,cleared=0,health;
vm.runInNewContext(source,{window,Date,performance:{now:()=>0},AbortSignal,
    setInterval:f=>(tick=f,1),clearInterval:()=>{cleared++;},
    setTimeout:f=>(deadline=f,2),clearTimeout:()=>{},
    fetch:async url=>{if(url.endsWith('/health'))return {ok:true,json:async()=>health};writes++;return {ok:!fail,status:fail?503:204};}});
await tick();assert.equal(writes,1);assert.equal(cleared,0);
await tick();assert.equal(writes,1); // no duplicate terminal save
const running={requestedSeconds:21600,status:'running',lastProgressAt:'1'};
window.raydioEndurance.report=running;
await tick();assert.equal(writes,2); // rearmed by report identity
running.lastProgressAt='2'; fail=true;
await tick();assert.equal(window.raydioCheckpoint.errors,1);
fail=false;await tick();assert.equal(writes,4); // failed revision retried
running.status='completed';running.finishedAt='end';
await tick();assert.equal(writes,5); // final saved without external .finally
await tick();assert.equal(writes,5);
window.raydioEndurance.report={...failed};await tick();assert.equal(writes,6);
assert.equal(window.raydioCheckpoint.saved,5);
window.raydioEndurance.report={requestedSeconds:120,requestedAt:'short-run',status:'running',elapsedSeconds:60,lastProgressAt:'short-progress'};
await tick();assert.equal(writes,7);
assert.equal(window.raydioCheckpoint.lastSavedRequestedAt,'short-run');
assert.equal(window.raydioCheckpoint.lastSavedElapsedSeconds,60);
window.raydioEndurance.report={requestedSeconds:9};await tick();assert.equal(writes,7);
window.raydioEndurance.report={requestedSeconds:21601};await tick();assert.equal(writes,7);
const active={requestedSeconds:21600,requestedAt:'actual',status:'running',elapsedSeconds:61,lastProgressAt:'61'};
window.raydioEndurance.report=active;
health={hostSamples:2,remainingSeconds:24000,lastReceiver:{requestedAt:'preflight',status:'running',elapsedSeconds:61}};
await assert.rejects(window.raydioCheckpoint.verify(),/not saved this running report/);
health.lastReceiver.requestedAt='actual';health.remainingSeconds=100;
await assert.rejects(window.raydioCheckpoint.verify(),/lifetime/);
health.remainingSeconds=24000;health.hostSamples=1;
await assert.rejects(window.raydioCheckpoint.verify(),/samples/);
health.hostSamples=2;
assert.equal((await window.raydioCheckpoint.verify()).verified,true);
deadline();assert.equal(window.raydioCheckpoint.timer,null);
await assert.rejects(window.raydioCheckpoint.verify(),/lifetime/);
console.log('PASS: failed preflight -> new run -> progress/retry -> final save; deduplication and bounded lifetime');
