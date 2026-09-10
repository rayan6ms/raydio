// Exercise the actual worklet with synthetic stereo audio, independently of UI delivery.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const code=readFileSync(new URL('./browser_endurance.js',import.meta.url),'utf8');
const source=code.match(/const worklet = `([\s\S]*?)`;/)[1];
let Meter; const messages=[];
const context={sampleRate:48000,currentTime:20,
    AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(structuredClone(m))};}},
    registerProcessor:(_,value)=>{Meter=value;}};
vm.runInNewContext(source,context);
const meter=new Meter();
meter.port.onmessage({data:'reset'});
assert.deepEqual(messages.shift(),{ready:true,contextTime:20});
const feed=(amplitude,quanta)=>{
    const block=new Float32Array(128).fill(amplitude);
    for(let i=0;i<quanta;i++){meter.process([[block,block]]);context.currentTime+=128/48000;}
};
feed(.2,375);feed(0,375);feed(.2,1);
meter.port.onmessage({data:'flush'});
const quiet=messages.flatMap(m=>m.quietRuns);
assert.equal(quiet.length,1);
assert.equal(quiet[0].frames,48000);
assert.equal(quiet[0].endFrame,96000);
assert.equal(messages.reduce((n,m)=>n+m.empty,0),0);
assert.equal(messages.reduce((n,m)=>n+m.clipped,0),0);
messages.length=0;feed(1,1);feed(NaN,1);meter.process([[]]);
meter.port.onmessage({data:'flush'});
assert.equal(messages.reduce((n,m)=>n+m.clipped,0),256);
assert.equal(messages.reduce((n,m)=>n+m.nonFinite,0),256);
assert.equal(messages.reduce((n,m)=>n+m.empty,0),128);
console.log('PASS: actual audio worklet timestamps exact one-second silence; clipping, invalid samples and empty input remain separate');
