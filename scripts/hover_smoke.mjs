const endpoint = process.env.FS_CDP_URL || 'http://127.0.0.1:9310';
const target = (await (await fetch(endpoint + '/json/list')).json()).find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
if (!target) throw new Error('No fs page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const timeout = setTimeout(() => process.exit(1), 45000);
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  clearTimeout(timeout); ws.close();
  if (message.result?.exceptionDetails) { console.error(message.result.exceptionDetails); process.exitCode = 1; }
  else console.log(JSON.stringify(message.result?.result?.value || message, null, 2));
};
ws.send(JSON.stringify({id:0, method:'Page.bringToFront'}));
ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{awaitPromise:true, returnByValue:true, expression:`(async () => {
  const assert = (ok, text) => { if (!ok) throw new Error(text); };
  const until = async fn => { for (let n=0;n<120;n++) { if (fn()) return; await new Promise(r=>setTimeout(r,50)); } throw new Error('Hover condition timeout: ' + JSON.stringify({visibility:document.visibilityState,preview:hoverAnimation?{closed:hoverAnimation.closed,ready:hoverAnimation.ready,frame:hoverAnimation.frame,tick:hoverAnimation.tick,seek:hoverAnimation.seek,time:(performance.now()-hoverAnimation.origin)%hoverAnimation.duration,title:hoverAnimation.canvas.title}:null})); };
  await refresh(); await search();
  // Fixture rendering is isolated from pending startup/debounced search updates.
  clearTimeout(debounce); searchSequence++;
  const originalSearch = search; search = async () => {};
  const originalLayout = resultLayout;
  const images = await api('search',{query:'hover-fixture',mode:'filename',limit:20});
  assert(images.results.length === 3, 'GIF/WebP/APNG fixtures found');
  $('grid-view').click(); await layoutSaveChain; await refresh();
  const checked = [];
  for (const file of images.results) {
    renderBrowserResults({results:[file],total:1,elapsed_ms:0});
    const holder = document.querySelector('.file-thumbnail'); const rect = holder.getBoundingClientRect();
    holder.dispatchEvent(new PointerEvent('pointerenter',{clientX:rect.left+rect.width*.2,pointerType:'mouse'}));
    await until(()=>hoverAnimation?.ready && !holder.querySelector('canvas').hidden);
    const preview=hoverAnimation;
    assert(preview.starts.length===3 && preview.duration===1000,'Actual variable frame timing');
    await until(()=>holder.querySelector('canvas').dataset.frame==='1');
    const green=holder.querySelector('canvas').getContext('2d').getImageData(1,1,1,1).data;
    assert(green[1]>100 && green[0]<30,'20 percent maps to green by time, not frame count');
    holder.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+rect.width*.7,pointerType:'mouse'}));
    await until(()=>holder.querySelector('canvas').dataset.frame==='2');
    const pixel=holder.querySelector('canvas').getContext('2d').getImageData(1,1,1,1).data;
    assert(pixel[2]>200 && pixel[0]<30,'Pointer selects blue third frame');
    const before=holder.querySelector('canvas').dataset.frame;
    await until(()=>holder.querySelector('canvas').dataset.frame!==before);
    holder.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
    assert(!hoverAnimation && preview.closed && holder.querySelector('canvas').hidden,'Animation decoder released on leave');
    checked.push(file.name);
  }
  const videos=await api('search',{query:'movie.mp4',mode:'filename',limit:10});
  const movie=videos.results.find(file=>file.path.startsWith('/tmp/fs-browser-docs/'));
  assert(movie,'Movie fixture found');
  renderBrowserResults({results:[movie],total:1,elapsed_ms:0});
  const holder=document.querySelector('.file-thumbnail'); const rect=holder.getBoundingClientRect();
  holder.dispatchEvent(new PointerEvent('pointerenter',{clientX:rect.left+rect.width*.15,pointerType:'mouse'}));
  const video=holder.querySelector('video');
  await until(()=>video.readyState>=2 && !video.paused);
  assert(video.muted && video.loop,'Muted looping video');
  holder.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+rect.width*.25,pointerType:'mouse'}));
  holder.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+rect.width*.7,pointerType:'mouse'}));
  await until(()=>Math.abs(video.currentTime/video.duration-.7)<.15);
  holder.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
  assert(!hoverVideo && video.hidden && !video.getAttribute('src'),'Video decoder released on leave');
  search=originalSearch;
  $(originalLayout + '-view').click(); await layoutSaveChain;
  return {animated:checked,variableFrameTiming:true,positionScrubbing:true,mutedVideo:true,latestPointerMove:true,decoderCleanup:true};
})()`}}));
