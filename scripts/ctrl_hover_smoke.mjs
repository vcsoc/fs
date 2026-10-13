const endpoint=process.env.FS_CDP_URL;
const target=(await(await fetch(endpoint+'/json/list')).json()).find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'));
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
const timer=setTimeout(()=>process.exit(1),45000);
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id!==1)return;clearTimeout(timer);ws.close();if(m.result?.exceptionDetails){console.error(m.result.exceptionDetails);process.exitCode=1;}else console.log(JSON.stringify(m.result?.result?.value||m,null,2));};
ws.send(JSON.stringify({id:0,method:'Page.bringToFront'}));
ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,userGesture:true,expression:`(async()=>{
 const assert=(ok,text)=>{if(!ok)throw new Error(text)};
 const until=async fn=>{for(let n=0;n<160;n++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Ctrl hover timeout')};
 await refresh();await search();clearTimeout(debounce);searchSequence++;const originalSearch=search;search=async()=>{};
 const response=await api('search',{query:'',root:'/tmp/fs-controls-fixtures',limit:20});const files=response.results.filter(file=>['video','audio'].includes(file.kind));assert(files.length===2,'Audio and video fixtures');
 const key=(down,held)=>window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{key:'Control',ctrlKey:held,bubbles:true}));
 for(const file of files){
  renderBrowserResults({results:[file],total:1,elapsed_ms:0});const holder=document.querySelector('.file-thumbnail');const rect=holder.getBoundingClientRect();
  const enter=ctrl=>holder.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse',clientX:rect.left+rect.width*.1,ctrlKey:ctrl}));
  enter(false);holder.querySelector('video,audio').volume=0;await until(()=>hoverVideo?.readyState>=2&&!hoverVideo.paused);const media=hoverVideo;assert(media.muted,'Muted by default');
  key(true,true);assert(!media.muted,'Ctrl press unmutes active preview');key(false,false);assert(media.muted,'Ctrl release remutes');
  key(true,true);window.dispatchEvent(new Event('blur'));assert(media.muted&&!hoverCtrlHeld,'Focus loss remutes');
  key(true,true);holder.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse',ctrlKey:true}));assert(media.muted&&media.paused&&!hoverVideo,'Leaving mutes and stops decoder');
  enter(true);holder.querySelector('video,audio').volume=0;await until(()=>hoverVideo?.readyState>=2);assert(!hoverVideo.muted,'Ctrl held before hover works');
  const active=hoverVideo;renderBrowserResults({results:[],total:0,elapsed_ms:0});assert(active.muted&&active.paused&&!hoverVideo,'Rerender cleanup mutes');key(false,false);
 }
 await openViewer(files.find(file=>file.kind==='video'));const viewer=$('viewer-body').querySelector('video');viewer.muted=false;
 key(true,true);key(false,false);assert(!viewer.muted,'Ctrl hover shortcuts do not change viewer audio');closeViewer();
 search=originalSearch;resetHoverAudio();await search();
 return {video:true,audio:true,mutedByDefault:true,ctrlPressUnmutes:true,ctrlReleaseRemutes:true,heldBeforeHover:true,focusLossRemutes:true,leaveAndRerenderMuteAndStop:true,viewerAudioUnchanged:true};
})()`}}));
