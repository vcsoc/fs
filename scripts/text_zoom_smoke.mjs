const fixtureRoot=JSON.stringify(process.env.FS_FIXTURE_ROOT||'/tmp/fs-070-format-fixtures');
const target=(await(await fetch(process.env.FS_CDP_URL+'/json/list')).json()).find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'));
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}};
const command=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function key(key,code,windowsVirtualKeyCode){await command('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,modifiers:2});await command('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode,modifiers:2});await new Promise(r=>setTimeout(r,200))}
const timeout=setTimeout(()=>process.exit(1),45000);
try {
 await command('Page.bringToFront');await key('0','Digit0',48);
 await evaluate(`(async()=>{const r=await api('search',{mode:'filename',root:${fixtureRoot}});await api('preferences',{result_layout:'grid'});renderBrowserResults(r);setLayout('grid');await new Promise(r=>setTimeout(r,200));window.zoomProbe=()=>{const t=$('results').querySelector('.file-thumbnail').getBoundingClientRect();return {font:parseFloat(getComputedStyle($('results').querySelector('.file-title')).fontSize),width:t.width,height:t.height,viewport:innerWidth,scale:document.documentElement.dataset.textScale}};window.zoomBaseline=zoomProbe()})()`);
 await key('+','Equal',187);
 const zoomed=await evaluate(`(()=>{const x=zoomProbe(),b=zoomBaseline;if(!(x.font>b.font&&Math.abs(x.width-b.width)<.01&&Math.abs(x.height-b.height)<.01&&x.viewport===b.viewport))throw new Error('Font-only zoom failed '+JSON.stringify({x,b}));return x})()`);
 await key('-','Minus',189);
 await evaluate(`(()=>{if(Math.abs(zoomProbe().font-zoomBaseline.font)>.01)throw new Error('Zoom out did not restore font')})()`);
 await key('=','Equal',187);await key('=','Equal',187);
 await command('Page.reload');await new Promise(r=>setTimeout(r,1400));
 await evaluate(`(()=>{if(document.documentElement.dataset.textScale!=='1.25')throw new Error('Text scale lost on reload')})()`);
 await key('0','Digit0',48);
 await evaluate(`(async()=>{if(document.documentElement.dataset.textScale!=='1')throw new Error('Reset failed');view('preferences');$('pref-max_chunks').value='512';$('pref-max_chunks').dispatchEvent(new Event('input',{bubbles:true}));if(!$('pref-max_chunks').checkValidity())throw new Error('512 invalid in UI');await api('preferences',{max_chunks:512});await refresh();if($('pref-max_chunks').value!=='512'||(await api('status')).preferences.max_chunks!==512)throw new Error('512 not persisted');view('search')})()`);
 console.log(JSON.stringify({fontOnlyZoom:true,thumbnailDimensionsUnchanged:true,pageViewportUnchanged:true,ctrlPlusMinusReset:true,ctrlEquals:true,persistenceAcrossReload:true,chunk512UiAndBackend:true,zoomed},null,2));
} finally {clearTimeout(timeout);ws.close();setTimeout(()=>process.exit(),200)}
