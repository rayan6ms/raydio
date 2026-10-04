// Exercise the public composer/recorder contract without Discord or a network.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./browser_playback_setup.js', import.meta.url), 'utf8');
const request = 'https://www.youtube.com/watch?v=4moWSMi1L_4';
const article = (id, text) => ({innerText:text,
    getAttribute:()=>`chat-messages-${id}`});
async function simulate({missing=false, ambiguous=false}={}) {
    let messages=[article(100,'old message')], recording, saves=0, sends=0;
    let draft='stale /play draft', parsed=false, picker=false, selectedBot;
    const clipboard=[];
    const window={
        getSelection:()=>({removeAllRanges(){},addRange(){}}),
        raydioEndurance:{peers:[{connectionState:'connected'}],
            start:async options=>{recording=options;}},
        raydioCheckpoint:{timer:1,save:async()=>{saves++;}},
    };
    const box={focus(){},dispatchEvent(event){
        if(event.type==='cut') {draft='';parsed=false;picker=false;clipboard.push('cut');}
        else if(event.type==='paste') {
            const text=event.clipboardData.getData('text/plain');clipboard.push(text);
            if(!parsed) {draft+=text;picker=draft==='/';}
            else draft+=text;
        }
    },querySelector(selector){
        if(!parsed)return null;
        return {textContent:selector.includes('commandName')?'/play':
            selector.includes('optionPillKey')?'request':draft};
    }};
    const option=name=>({innerText:`/play\nrequest\nPlay a song\n${name}`,
        click(){selectedBot=name;parsed=true;picker=false;draft='';}});
    const send={getAttribute:()=>'false',click(){
        assert.equal(parsed,true,'never submit plain pasted text');
        assert.equal(selectedBot,'Raydio');assert.equal(draft,request);sends++;
        messages.push(article(200,'Raydio Raydio • Now Playing Playing • Loop: ON'));
    }};
    const document={
        querySelectorAll:selector=>selector.includes('option')?
            picker?[option('Testbot'),...(missing?[]:[option('Raydio')]),
                ...(ambiguous?[option('Raydio')]:[])]:[]:messages,
        querySelector:selector=>selector.includes('textbox')?box:send,
        createRange:()=>({selectNodeContents(){}}),
        execCommand(){throw Error('DOM-only draft deletion must not be used');},
    };
    vm.runInNewContext(source,{window,document,
        setTimeout:callback=>queueMicrotask(callback),
        DataTransfer:class {
            data={};setData(type,text){this.data[type]=text;}
            getData(type){return this.data[type]||'';}
        }, ClipboardEvent:class {
            constructor(type,options){this.type=type;Object.assign(this,options);}
        }});
    const setup=window.raydioPlaybackSetup;
    const preparing=setup.prepare({request,botName:'Raydio'});
    assert.throws(()=>setup.submit(),/await completion/);
    await assert.rejects(setup.prepare({request,botName:'Raydio'}),/Existing trial/);
    if(missing||ambiguous) {
        await assert.rejects(preparing,missing?/unavailable/:/Ambiguous/);
        assert.throws(()=>setup.submit(),/await completion/);
        assert.equal(sends,0);return;
    }
    await preparing;
    assert.deepEqual(clipboard,['cut','/',request]);
    assert.throws(()=>setup.startAudit({seconds:300}),/Submit/);
    setup.submit();assert.equal(sends,1);
    assert.throws(()=>setup.submit(),/Prepare once/);
    setup.startAudit({seconds:300});
    await Promise.resolve();
    assert.equal(recording.botName,'Raydio');assert.equal(recording.seconds,300);
    assert.equal(recording.pcm,true);assert.equal(recording.scheduling,true);
    assert.equal(saves,1);
}
await simulate();await simulate({missing:true});await simulate({ambiguous:true});
console.log('PASS: stale draft clearing, explicit bot selection, parsed request, bounded failures, single submission and recorder identity');
