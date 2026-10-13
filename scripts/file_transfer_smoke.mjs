import {execFileSync} from 'node:child_process';
const endpoint=process.env.FS_CDP_URL;
const target=(await(await fetch(endpoint+'/json/list')).json()).find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'));
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let sequence=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}};
function command(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const timeout=setTimeout(()=>process.exit(1),300000);
const newName='new-'+Date.now()+'.txt';
let saved, mime;
try {
  // Preserve the existing clipboard without printing or persisting its contents.
  const types=execFileSync('wl-paste',['--list-types'],{encoding:'utf8',timeout:3000}).trim().split('\n');
  mime=types.find(t=>t==='text/uri-list')||types.find(t=>t==='image/png')||types.find(t=>t.startsWith('text/plain'))||types[0];
  if(mime)saved=execFileSync('wl-paste',['--no-newline','--type',mime],{timeout:3000});
} catch {}
try {
  await command('Page.bringToFront');
  const data={items:[{mimeType:'text/uri-list',data:'file:///tmp/fs-070-transfer-fixtures/chosen.jpg'}],files:['/tmp/fs-070-transfer-fixtures/chosen.jpg'],dragOperationsMask:1};
  await command('Input.dispatchDragEvent',{type:'dragEnter',x:600,y:300,data});
  await command('Input.dispatchDragEvent',{type:'drop',x:600,y:300,data});
  const result=await evaluate(`(async()=>{
    const assert=(ok,msg)=>{if(!ok)throw new Error(msg)};const until=async fn=>{for(let n=0;n<900;n++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Import/watch timeout: '+$('notice').textContent)};
    await until(async()=>{const s=await api('search',{mode:'filename',query:'chosen.jpg'});return s.results.length===1});
    await until(async()=>{const s=await api('status');return s.job.state!=='running'});
    const response=await api('search',{mode:'filename',root:'/tmp/fs-070-transfer-fixtures'});assert(response.results.length===1,'Only dropped file is imported');
    const file=response.results[0];assert(file.thumbnail_state==='ready','Real thumbnail state');
    const poster=await fetch(file.thumbnail_url);assert(poster.ok&&poster.headers.get('content-type').startsWith('image/'),'Generated poster');
    mode='filename';$('query').value='chosen.jpg';await search();const card=$('results').querySelector('.result-card');assert(card.draggable,'Native drag enabled');
    const checkbox=card.querySelector('input');checkbox.checked=true;checkbox.dispatchEvent(new Event('change'));assert(!$('copy-selected').disabled,'Copy selection enabled');
    const copied=await window.fsDesktop.copyFiles([file.id]);assert(copied.copied===1,'Native file clipboard');
    const roots=(await api('status')).roots;const source=roots.find(r=>r.root==='/tmp/fs-070-transfer-fixtures');assert(source.scope==='selected'&&source.watch_enabled,'Scoped watcher persists');
    await api('watch',{root:source.root,enabled:false});assert(!(await api('status')).roots.find(r=>r.root===source.root).watch_enabled,'Watcher can be paused');
    await api('watch',{root:source.root,enabled:true});
    let rejected=false;try{await window.fsDesktop.copyFiles([-1])}catch{rejected=true}assert(rejected,'Invalid selections rejected');
    await api('import',{paths:['/tmp/fs-070-watcher-fixtures'],semantic:false});await until(async()=>{const s=await api('status');return s.job.state!=='running'});
    return {nativeDrop:true,onlySelectedFile:true,thumbnail:true,nativeFileClipboard:true,dragEnabled:true,persistentScopedWatcher:true,watcherPauseResume:true,invalidSelectionRejected:true};
  })()`);
  const uris=execFileSync('wl-paste',['--type','text/uri-list'],{encoding:'utf8'});if(!uris.includes('file:///tmp/fs-070-transfer-fixtures/chosen.jpg'))throw new Error('Native URI clipboard mismatch');
  execFileSync('python3',['-c',`from pathlib import Path;Path('/tmp/fs-070-watcher-fixtures/${newName}').write_text('A brand new automatically watched file')`]);
  const watched=await evaluate(`(async()=>{for(let n=0;n<900;n++){const r=await api('search',{mode:'filename',root:'/tmp/fs-070-watcher-fixtures',query:'${newName}'});if(r.results.length){if(!r.results[0].analyzed_at)throw new Error('New file was not analysed');const poster=await fetch(r.results[0].thumbnail_url);if(!poster.ok)throw new Error('No watched thumbnail');return true}await new Promise(r=>setTimeout(r,100))}throw new Error('New file was not automatically indexed')})()`);
  console.log(JSON.stringify({...result,automaticNewFileAnalysisAndThumbnail:watched},null,2));
} finally {
  if(saved&&mime)execFileSync('wl-copy',['--type',mime],{input:saved,timeout:3000,stdio:['pipe','ignore','ignore']});
  clearTimeout(timeout);ws.close();setTimeout(()=>process.exit(0),200);
}
