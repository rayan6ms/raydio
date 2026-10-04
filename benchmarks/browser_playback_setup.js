// Controlled Discord UI only. Install before preparing a new test command.
// Keep prepare(), submit(), enableLoop(), and startAudit() in separate calls:
// Discord needs a render turn to parse its editor and apply each interaction.
(() => {
    if (window.raydioEndurance?.running) throw Error('Do not replace setup during an audit');
    const clean = s => (s || '').replace(/[\u200b\ufeff]/g, '').trim();
    const articles = () => [...document.querySelectorAll('main [role="article"]')];
    const identity = a => a.getAttribute('data-list-item-id');
    const snowflake = a => identity(a)?.match(/-(\d+)$/)?.[1];
    const idle = () => {
        if (window.raydioEndurance?.running) throw Error('No controls during an audit');
    };
    const box = () => {
        const e = document.querySelector('[role="textbox"][aria-label="Message #chat"]');
        if (!e) throw Error('Open test → #chat');
        return e;
    };
    let state;
    const panel = () => {
        if (!state?.submitted) throw Error('Submit the prepared command first');
        const matches = articles().filter(a => a.innerText.includes('Raydio • Now Playing')
            && a.innerText.includes(state.botName) && snowflake(a)
            && BigInt(snowflake(a)) > state.lastMessage);
        if (matches.length !== 1) throw Error('Expected one fresh bot player; old panels are not playback');
        return matches[0];
    };
    const api = window.raydioPlaybackSetup = {};
    api.prepare = async ({request='https://youtu.be/dQw4w9WgXcQ', botName='bot1544468432907669644'}={}) => {
        idle();
        if (state?.submitted || state?.preparing) throw Error('Existing trial; await preparation or reinstall setup');
        if (typeof request !== 'string' || !request.trim() || request.length > 1000 || /[\r\n]/.test(request))
            throw Error('Use one nonempty request');
        const ids = articles().map(snowflake).filter(Boolean).map(BigInt);
        if (!ids.length) throw Error('Message identities unavailable; cannot check response freshness');
        state = {request:request.trim(), botName, lastMessage:ids.reduce((a,b)=>a>b?a:b), preparing:true, prepared:false, submitted:false};
        const render = () => new Promise(resolve=>setTimeout(resolve,100));
        const until = async (check, message) => {
            for (let attempt=0; attempt<40; attempt++) {
                const value=check(); if (value) return value;
                await render();
            }
            throw Error(message);
        };
        const paste = text => {
            const data=new DataTransfer(); data.setData('text/plain',text);
            box().dispatchEvent(new ClipboardEvent('paste', {clipboardData:data,bubbles:true,cancelable:true}));
        };
        const e = box(); e.focus();
        const range = document.createRange(), selection = window.getSelection();
        range.selectNodeContents(e); selection.removeAllRanges(); selection.addRange(range);
        // Let Slate accept the selection, then use its public cut handler.
        // execCommand('delete') can mutate the DOM without clearing its draft,
        // leaving later pastes invisible or appended to the stale command.
        await new Promise(resolve=>setTimeout(resolve,200));
        e.dispatchEvent(new ClipboardEvent('cut', {clipboardData:new DataTransfer(), bubbles:true, cancelable:true}));
        await new Promise(resolve=>setTimeout(resolve,200));
        // A full pasted command can remain plain text. Select the bot's public
        // slash-command option first, then fill its parsed request field.
        try {
            paste('/');
            const option=await until(() => {
                const matches=[...document.querySelectorAll('[role="option"]')].filter(o=>
                    clean(o.innerText).startsWith('/play\n') && clean(o.innerText.split('\n').at(-1))===state.botName);
                if (matches.length>1) throw Error('Ambiguous bot play options; do not submit');
                return matches[0];
            },'Selected bot play option unavailable; do not submit');
            option.click();
            await until(()=>clean(box().querySelector('[class*="commandName"]')?.textContent)==='/play'
                && clean(box().querySelector('[class*="optionPillKey"]')?.textContent)==='request',
                'Discord has not selected the play request field');
            paste(state.request);
            await until(()=>clean(box().querySelector('[class*="optionPillValue"]')?.textContent)===state.request,
                'Discord has not parsed the request; do not submit');
            state.prepared = true;
        } finally { state.preparing = false; }
        return {prepared:true};
    };
    api.submit = () => {
        idle();
        if (!state?.prepared || state.submitted) throw Error('Prepare once and await completion before submitting');
        const e = box();
        if (clean(e.querySelector('[class*="commandName"]')?.textContent) !== '/play'
            || clean(e.querySelector('[class*="optionPillKey"]')?.textContent) !== 'request'
            || clean(e.querySelector('[class*="optionPillValue"]')?.textContent) !== state.request)
            throw Error('Discord has not parsed /play and its request field; do not submit raw editor text');
        if (!window.raydioEndurance?.peers.some(p=>p.connectionState==='connected'))
            throw Error('Install receiver observer before joining General');
        const button = document.querySelector('[aria-label="Send Message"]');
        if (!button || button.getAttribute('aria-disabled') !== 'false') throw Error('Send unavailable');
        // Consume before the click so a retry cannot send a duplicate command.
        state.submitted = true; button.click();
        return {submitted:true};
    };
    api.enableLoop = () => {
        idle(); const a = panel();
        if (a.innerText.includes('Playing • Loop: ON')) return {loop:true};
        const b = [...a.querySelectorAll('button')].find(e=>e.textContent.trim()==='Loop: OFF');
        if (!b) throw Error('Fresh player has no loop control');
        b.click(); return {loopRequested:true};
    };
    api.startAudit = ({seconds=300}={}) => {
        idle(); const a = panel();
        if (!a.innerText.includes('Playing • Loop: ON')) throw Error('Verify Loop ON before recording');
        if (!window.raydioCheckpoint?.timer) throw Error('Install persistence first');
        // The recorder independently requires one advancing inbound receiver.
        // It returns a status on preflight failure; never label promise resolution success.
        void window.raydioEndurance.start({seconds,botName:state.botName,pcm:true,scheduling:true})
            .then(()=>window.raydioCheckpoint.save());
        return {auditRequested:true, messageId:identity(a)};
    };
    return {installed:true};
})();
