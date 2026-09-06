// DOM click to updated player footer, with an explicit alternating sequence.
// A replaced/missing panel or reverted state invalidates the run. There must be
// one current panel and no competing controls. Does not measure sound latency.
const measureRaydioLatency = async (count=12) => {
    if (window.__raydioLatencyRunning) throw Error('Latency run already active');
    window.__raydioLatencyRunning=true;
    const panel=()=>[...document.querySelectorAll('main article')].filter(a=>a.innerText.includes('Raydio • Now Playing')).at(-1);
    const state=()=>panel()?.innerText.includes('Paused •')?'Paused':panel()?.innerText.includes('Playing •')?'Playing':null;
    const results=[];
    window.__raydioLatency=results;
    let expected=state();
    try {
        if (expected!=='Playing') throw Error('Start with an active playing track');
        // Old Discord messages can retain a Playing footer after a bot restart.
        // Require fresh progress before any click, so a stale panel is never an oracle.
        const before=panel()?.innerText;
        let advancing=false;
        for (let i=0;i<3;i++) {
            await new Promise(resolve=>setTimeout(resolve,1000));
            if (state()==='Playing' && panel()?.innerText!==before) { advancing=true; break; }
        }
        if (!advancing) throw Error('Player panel is not advancing');
        for (let i=0;i<count;i++) {
            if (state()!==expected) throw Error('Panel reverted during settling');
            const action=expected==='Playing'?'Pause':'Resume';
            const next=expected==='Playing'?'Paused':'Playing';
            const button=[...document.querySelectorAll('main button')].filter(b=>b.innerText.trim()===action).at(-1);
            if (!button || button.disabled) throw Error('Current control unavailable');
            const ms=await new Promise((resolve,reject)=>{
                const start=performance.now();
                const observer=new MutationObserver(()=>{
                    if(state()===next){observer.disconnect();clearTimeout(timer);resolve(performance.now()-start);}
                });
                const timer=setTimeout(()=>{observer.disconnect();reject(Error('Panel status timeout'));},10000);
                observer.observe(document.querySelector('main'),{childList:true,subtree:true,characterData:true});
                button.click();
            });
            results.push({action,ms}); expected=next;
            await new Promise(resolve=>setTimeout(resolve,2000));
        }
        return {valid:true,settleMs:2000,results};
    } catch(e) {
        return {valid:false,error:String(e),settleMs:2000,results};
    } finally {window.__raydioLatencyRunning=false;}
};
