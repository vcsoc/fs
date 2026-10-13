const endpoint=process.env.FS_CDP_URL;
const target=(await(await fetch(endpoint+'/json/list')).json()).find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'));
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
const timer=setTimeout(()=>process.exit(1),45000);
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id!==1)return;clearTimeout(timer);ws.close();if(m.result?.exceptionDetails){console.error(m.result.exceptionDetails);process.exitCode=1;}else console.log(JSON.stringify(m.result?.result?.value||m,null,2));};
ws.send(JSON.stringify({id:0,method:'Page.bringToFront'}));
ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,expression:`(async()=>{
 const assert=(ok,message)=>{if(!ok)throw new Error(message)};
 const until=async fn=>{for(let n=0;n<140;n++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Gallery condition timeout')};
 await refresh();await search();clearTimeout(debounce);searchSequence++;const realSearch=search;search=async()=>{};
 const old=resultLayout;const photos=await api('search',{query:'gallery-fixture',mode:'filename',limit:20});
 $('masonry-view').click();await layoutSaveChain;await refresh();assert(resultLayout==='masonry'&&status.preferences.result_layout==='masonry','Masonry survives status poll');
 renderBrowserResults(photos);
 await until(()=>[...document.querySelectorAll('.file-thumbnail img')].every(img=>img.complete&&img.naturalWidth));
 scheduleGallery();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const cards=[...document.querySelectorAll('.result-card')];assert(cards.length>=5,'Aspect fixtures found');
 const rows=new Map();
 for(const card of cards){const thumb=card.querySelector('.file-thumbnail'),rect=thumb.getBoundingClientRect();const ratio=Number(card.dataset.aspectRatio);assert(Math.abs(rect.width/rect.height-ratio)<.025,'Uncropped aspect ratio');const key=Math.round(rect.top);if(!rows.has(key))rows.set(key,[]);rows.get(key).push(rect.height);assert(getComputedStyle(card.querySelector('.size-cell')).display==='none'&&getComputedStyle(card.querySelector('.file-path')).display==='none','Only image and filename');}
 assert([...rows.values()].some(row=>row.length>1),'Multi-thumbnail rows');assert([...rows.values()].every(row=>Math.max(...row)-Math.min(...row)<1),'Each row has equal-height thumbnails');
 const card=cards.find(card=>Number(card.dataset.aspectRatio)<.6);const thumb=card.querySelector('.file-thumbnail');thumb.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse',clientX:thumb.getBoundingClientRect().left+5}));
 assert(!galleryDetails.hidden&&galleryDetails.textContent.includes('Modified'),'Hover details shown');const a=thumb.getBoundingClientRect(),b=galleryDetails.getBoundingClientRect();assert(b.right<=a.left||b.left>=a.right,'Details beside focused thumbnail');thumb.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));assert(galleryDetails.hidden,'Hover details disappear');
 const matches=await api('search',{query:'sunbeam',mode:'text',root:'/tmp/fs-gallery-fixtures',limit:20});const movie=matches.results.find(file=>file.kind==='video');assert(movie&&movie.matched_sections.length===2,'Two exact caption intervals');renderBrowserResults({results:[movie],total:1,elapsed_ms:0});
 await until(()=>document.querySelectorAll('.thumbnail-match').length===2);assert([...document.querySelectorAll('.thumbnail-match')].map(x=>Number(x.dataset.start)).join(',')==='0.4,2.1','Start/end evidence retained');
 const holder=document.querySelector('.file-thumbnail'),rect=holder.getBoundingClientRect();holder.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse',clientX:rect.left+rect.width*.5}));const video=holder.querySelector('video');await until(()=>video.readyState>=2&&!video.paused);assert(getComputedStyle(holder.querySelector('.thumbnail-seekbar')).opacity==='1','Seek strip visible');await until(()=>Math.abs(Number(holder.dataset.playhead)-.5)<.2);assert(getComputedStyle(holder.querySelector('.thumbnail-playhead')).opacity==='1','Vertical playhead visible');holder.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
 $('results').style.width='360px';renderBrowserResults(photos);scheduleGallery();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));assert($('results').scrollWidth<=$('results').clientWidth+1,'Narrow gallery has no horizontal overflow');$('results').style.removeProperty('width');
 search=realSearch;$(old+'-view').click();await layoutSaveChain;hideGalleryDetails();pauseHover();
 return {masonry:true,aspectRatios:true,equalHeightRows:true,minimalCards:true,sideDetails:true,narrowLayout:true,seekbar:true,verticalPlayhead:true,multipleMatchIntervals:true};
})()`}}));
