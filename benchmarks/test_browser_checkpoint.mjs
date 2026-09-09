import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./browser_checkpoint.js',import.meta.url),'utf8');
const failed={requestedSeconds:21600,status:'failed',finishedAt:'preflight'};
const window={raydioEndurance:{report:failed}};
let tick,deadline,writes=0,fail=false,cleared=0;
vm.runInNewContext(source,{window,Date,performance:{now:()=>0},AbortSignal,
    setInterval:f=>(tick=f,1),clearInterval:()=>{cleared++;},
    setTimeout:f=>(deadline=f,2),clearTimeout:()=>{},
    fetch:async()=>{writes++;return {ok:!fail,status:fail?503:204};}});
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
deadline();assert.equal(window.raydioCheckpoint.timer,null);
console.log('PASS: failed preflight -> new run -> progress/retry -> final save; deduplication and bounded lifetime');
