const endpoint = process.env.FS_CDP_URL || 'http://127.0.0.1:9260';
const targets = await (await fetch(endpoint + '/json/list')).json();
const target = targets.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
if (!target) throw new Error('No fs page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const timeout = setTimeout(() => process.exit(1), 20000);
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  console.log(JSON.stringify(message.result?.result?.value || message, null, 2));
  clearTimeout(timeout); ws.close();
};
const query = JSON.stringify(process.argv[2] || 'BARC Session 0');
ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{awaitPromise:true, returnByValue:true, expression:`(async () => {
  const response = await api('search', {query:${query}, mode:'filename', limit:1});
  if (!response.results.length) return {error:'No matching indexed media'};
  $('query').value = ''; await openViewer(response.results[0]);
  const media = document.querySelector('.viewer-media');
  if (!media) return {error:$('viewer-notice').textContent};
  for (let n=0;n<100 && media.readyState<2 && !media.error;n++) await new Promise(r=>setTimeout(r,100));
  let playError='';
  try { await Promise.race([media.play(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Playback timeout')),5000))]); } catch(error) { playError=error.message; }
  await new Promise(r=>setTimeout(r,1500));
  const result={name:response.results[0].name,readyState:media.readyState,currentTime:media.currentTime,paused:media.paused,error:media.error?.message,code:media.error?.code,playError,notice:$('viewer-notice').textContent};
  media.pause(); return result;
})()`}}));
