import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const endpoint=process.env.FS_CDP_URL, profile=process.env.FS_TEST_DATA_DIR;
if (!endpoint || !profile?.startsWith('/tmp/fs-')) throw new Error('Explicit isolated test endpoint/profile required');
const version=await(await fetch(endpoint+'/json/version')).json();
const target=(await(await fetch(endpoint+'/json/list')).json()).find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'));
async function connect(url) {
  const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  let sequence=0;const pending=new Map();
  ws.onmessage=event=>{const result=JSON.parse(event.data),item=pending.get(result.id);if(!item)return;pending.delete(result.id);clearTimeout(item.timer);result.error?item.reject(new Error(result.error.message)):item.resolve(result.result)};
  return {ws,command:(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method))},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})};
}
const browser=await connect(version.webSocketDebuggerUrl),page=await connect(target.webSocketDebuggerUrl);
const processes=await browser.command('SystemInfo.getProcessInfo');
const mainPid=processes.processInfo.find(process=>process.type==='browser').id;
const evaluate=async expression=>{const result=await page.command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value};
const until=async fn=>{for(let n=0;n<180;n++){try{if(await fn())return}catch(_){}await new Promise(r=>setTimeout(r,100))}throw new Error('Service recovery timeout')};
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
function ownedBackend() {
  const rows=execFileSync('ps',['-eo','pid=,ppid=,args='],{encoding:'utf8'}).trim().split('\n').map(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return {pid:Number(match[1]),ppid:Number(match[2]),args:match[3]}});
  const candidates=rows.filter(row=>row.args.includes('--data-dir '+profile+' ')&&row.args.endsWith(' serve')&&!row.args.includes('--worker'));
  let owned=candidates.find(row=>row.ppid===mainPid);assert(owned,'No owned backend directly under test Electron process');
  // Frozen PyInstaller may have a bootloader parent. Kill its Python child,
  // not just the bootloader, so the test cannot leave an orphan service.
  while(candidates.some(row=>row.ppid===owned.pid))owned=candidates.find(row=>row.ppid===owned.pid);
  return owned.pid;
}
try {
  await evaluate(`(async()=>{await refresh();mode='text';browserType='';browserFolder='';favouriteOnly=false;$('root').value='/tmp/fs-controls-fixtures';$('query').value='sunbeam';await search();await openViewer(browserResults.find(file=>file.name==='controls.mp4'));const media=$('viewer-body').querySelector('video');if(media.readyState<1)await new Promise(r=>media.addEventListener('loadedmetadata',r,{once:true}));media.pause();media.currentTime=12;media.volume=.25;media.playbackRate=1.5;media.muted=true;})()`);
  for(let attempt=0;attempt<3;attempt++) {
    const previousUrl=await evaluate('location.href');process.kill(ownedBackend(),'SIGKILL');
    await until(async()=>await evaluate(`location.href!==${JSON.stringify(previousUrl)}&&$('service-recovery-message').textContent.includes('view was restored')`));
    const state=await evaluate(`({query:$('query').value,open:$('viewer-dialog').open,time:$('viewer-body').querySelector('video')?.currentTime,paused:$('viewer-body').querySelector('video')?.paused,muted:$('viewer-body').querySelector('video')?.muted,rate:$('viewer-body').querySelector('video')?.playbackRate,volume:$('viewer-body').querySelector('video')?.volume})`);
    assert(state.query==='sunbeam'&&state.open&&state.paused&&state.muted&&Math.abs(state.time-12)<.3&&state.rate===1.5&&state.volume===.25,'Recovery lost viewer/playback state: '+JSON.stringify(state));
  }
  process.kill(ownedBackend(),'SIGKILL');
  await until(async()=>await evaluate(`!$('service-retry').hidden&&$('service-recovery-message').textContent.includes('could not stay connected')`));
  assert(await evaluate(`$('viewer-dialog').open&&$('service-recovery').parentElement===$('viewer-dialog')`),'Bounded failure must preserve the viewer and expose its retry button');
  await evaluate(`$('service-retry').click()`);
  await until(async()=>await evaluate(`$('service-recovery-message').textContent.includes('view was restored')`));
  const records=readFileSync(profile+'/logs/search-service.log','utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert(records.some(record=>record.event==='exit'&&!record.intentional&&(record.signal||(Number.isInteger(record.code)&&record.code!==0))),'Missing exit signal/code diagnostics');
  console.log(JSON.stringify({unexpectedExitRecovery:true,queryPreserved:true,viewerPositionPreserved:true,pauseMuteVolumeSpeedPreserved:true,threeRestartsThenBoundedFailure:true,windowPreserved:true,manualRetry:true,exitDiagnostics:true},null,2));
} catch (error) {
  console.error(error); process.exitCode=1;
} finally {
  page.ws.close(); browser.ws.close();
  // Chromium may retain the browser-target close handshake after a renderer
  // reload. Bound teardown of this diagnostic client's own sockets.
  setTimeout(()=>process.exit(process.exitCode||0),200);
}
