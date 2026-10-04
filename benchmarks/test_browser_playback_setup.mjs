// Exercise the setup/recorder contract without Discord or a real network.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./browser_playback_setup.js', import.meta.url), 'utf8');
const request = 'https://www.youtube.com/watch?v=4moWSMi1L_4';
const article = (id, text) => ({innerText:text,
    getAttribute:()=>`chat-messages-${id}`});
let messages = [article(100, 'old message')], recording, saves = 0;
const window = {
    getSelection:()=>({removeAllRanges(){},addRange(){}}),
    raydioEndurance:{peers:[{connectionState:'connected'}],
        start:async options=>{recording=options;}},
    raydioCheckpoint:{timer:1,save:async()=>{saves++;}},
};
const box = {focus(){},dispatchEvent(){},querySelector(selector){
    return {textContent:selector.includes('commandName')?'/play':
        selector.includes('optionPillKey')?'request':request};
}};
const send = {getAttribute:()=>'false',click(){
    messages.push(article(200, 'Raydio Raydio • Now Playing Playing • Loop: ON'));
}};
const document = {
    querySelectorAll:()=>messages,
    querySelector:selector=>selector.includes('textbox')?box:send,
    createRange:()=>({selectNodeContents(){}}),execCommand(){},
};
vm.runInNewContext(source, {window,document,
    DataTransfer:class {setData(){}}, ClipboardEvent:class {}});
const setup = window.raydioPlaybackSetup;
setup.prepare({request,botName:'Raydio'});
assert.throws(()=>setup.startAudit({seconds:300}), /Submit/);
setup.submit();
assert.throws(()=>setup.submit(), /Prepare once/);
setup.startAudit({seconds:300});
await Promise.resolve();
assert.equal(recording.botName, 'Raydio');
assert.equal(recording.seconds, 300);
assert.equal(recording.pcm, true);
assert.equal(recording.scheduling, true);
assert.equal(saves, 1);
console.log('PASS: fresh player, single submission and selected bot identity reach the receiver recorder');
