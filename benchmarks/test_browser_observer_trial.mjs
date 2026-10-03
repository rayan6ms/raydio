import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./browser_observer_trial.js',import.meta.url),'utf8');
async function simulate({failed=false,saveFails=false,busy=false,shortLife=false}={}){
    const calls=[],saves=[];
    const result=()=>({version:1,status:failed?'failed':'completed',error:failed?'identity changed':undefined,uninterruptedConnection:true,coverage:{uninterruptedConnection:true}});
    const window={raydioCounterAudit:{running:busy,start:async()=>{calls.push('endpoint');return result()}},
        raydioEndurance:{running:false,start:async o=>{calls.push(o.pcm?'pcm':'polling');return result()}}};
    vm.runInNewContext(source,{window,Date,AbortSignal,JSON,fetch:async(url,o)=>{
        if(url.endsWith('/health'))return {ok:true,json:async()=>({remainingSeconds:shortLife?1:1800})};
        saves.push(JSON.parse(o.body));return {ok:!saveFails,status:saveFails?500:200};
    }});
    if(busy){await assert.rejects(window.raydioObserverTrial.start({seconds:10}),/Another observer/);return;}
    const report=await window.raydioObserverTrial.start({seconds:10});
    assert.equal(window.raydioObserverTrial.running,false);
    if(failed||saveFails){assert.equal(calls.length,1);assert.equal(saves.length,1);assert.equal(report.status,'failed');}
    else if(shortLife){assert.equal(calls.length,0);assert.equal(report.status,'failed');}
    else{assert.deepEqual(calls,['endpoint','pcm','pcm','endpoint']);assert.equal(report.saved,4);assert.equal(report.status,'completed');assert.ok(saves.every((s,i)=>s.observerTrial.index===i));}
}
await simulate();await simulate({failed:true});await simulate({saveFails:true});await simulate({busy:true});await simulate({shortLife:true});
console.log('PASS: balanced order, per-window persistence, failed windows retained, concurrency and lifetime guards');
