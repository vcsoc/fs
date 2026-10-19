const endpoint=process.env.FS_CDP_URL;
const target=(await(await fetch(endpoint+'/json/list')).json()).find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'));
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const pending=new Map(),errors=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening')command('Page.handleJavaScriptDialog',{accept:true});if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}};
function command(method,params={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const timer=setTimeout(()=>process.exit(1),60000);
try {
 await command('Page.enable');await command('Runtime.enable');
 console.log(await evaluate(`(async()=>{
  const assert=(ok,msg)=>{if(!ok)throw new Error(msg)};const wait=async()=>{await displaySaveChain;await new Promise(r=>setTimeout(r,150))};
  await api('preferences',{show_thumbnails:true,column_widths:{},result_layout:'list'});await refresh();mode='filename';$('query').value='';$('root').value='/tmp/fs-090-alias-fixtures';await search();
  const link=[...$('locations').querySelectorAll('button.location-link')].find(b=>b.title.startsWith('/tmp/fs-090-alias-fixtures'));assert(link,'Test location missing');
  link.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:80,clientY:200}));
  const menu=[...locationMenu.querySelectorAll('button')];assert(menu.some(b=>b.textContent==='Remove from fs'),'Remove action missing');menu.find(b=>b.textContent==='Rename alias').click();
  $('location-alias-input').value='My pictures <safe>';$('location-alias-form').requestSubmit();
  for(let n=0;n<50&&$('location-alias-dialog').open;n++)await new Promise(r=>setTimeout(r,50));await refresh();
  assert(status.roots.find(r=>r.root==='/tmp/fs-090-alias-fixtures').alias==='My pictures <safe>','Alias not persisted');
  assert([...$('locations').querySelectorAll('button')].some(b=>b.textContent.includes('My pictures <safe>')),'Sidebar alias missing');assert($('root').selectedOptions[0].text==='My pictures <safe>','Filter alias missing');
  assert(parseFloat(getComputedStyle($('search-nav')).fontSize)>=11,'Sidebar font not increased');
  const sortBefore=browserSort;
  window.resizeTarget=document.querySelector('[data-sort=name] .column-resize-handle');
  window.resizeStart=resizeTarget.getBoundingClientRect().toJSON();
  return {aliasAndMenu:true,sidebarFont:true,sortBefore,resizeStart};
 })()`));
 const point=await evaluate('({x:resizeStart.x+resizeStart.width/2,y:resizeStart.y+resizeStart.height/2})');
 await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
 await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+90,y:point.y,button:'left',buttons:1});
 await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+90,y:point.y,button:'left',clickCount:1});
 await evaluate(`(async()=>{await displaySaveChain;const width=(await api('status')).preferences.column_widths.name;if(!width||width<200)throw new Error('Pointer resize not saved');window.savedNameWidth=width;if(browserSort!=='score')throw new Error('Resize changed sorting');resizeTarget.focus();resizeTarget.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await displaySaveChain;if((await api('status')).preferences.column_widths.name!==width+10)throw new Error('Keyboard resize failed');window.savedNameWidth=width+10;
  const check=$('results').querySelector('.file-select');check.checked=true;check.dispatchEvent(new Event('change'));const selection=[...selectedFiles];
  const staleRevision=displayRevision;$('toggle-thumbnails').click();applyBrowserDisplay({show_thumbnails:true,column_widths:{}},staleRevision,false);if(thumbnailsShown)throw new Error('Pending display change overwritten');await displaySaveChain;applyBrowserDisplay({show_thumbnails:true,column_widths:{}},staleRevision,false);if(thumbnailsShown)throw new Error('Stale status overwrote display intent');await refresh();if(thumbnailsShown||$('results').querySelector('.file-thumbnail img')||getComputedStyle($('results').querySelector('.file-thumbnail')).visibility!=='hidden')throw new Error('Thumbnails not disabled');if(JSON.stringify([...selectedFiles])!==JSON.stringify(selection))throw new Error('Toggle lost selection');if($('results').querySelector('.file-main').getBoundingClientRect().width<100)throw new Error('Hidden preview shifted columns');
 })()`);
 await command('Page.reload');await new Promise(r=>setTimeout(r,1600));
 console.log(await evaluate(`(async()=>{await refresh();if(thumbnailsShown)throw new Error('Thumbnail setting did not survive reload');const prefs=(await api('status')).preferences;if(!prefs.column_widths.name||document.body.style.getPropertyValue('--col-name')!==prefs.column_widths.name+'px')throw new Error('Widths did not survive reload');
  await api('preferences',{result_layout:'masonry'});await refresh();if(document.body.dataset.resultLayout!=='list')throw new Error('Hidden thumbnails did not use text layout');$('toggle-thumbnails').click();await displaySaveChain;await refresh();if(document.body.dataset.resultLayout!=='masonry'||!thumbnailsShown)throw new Error('Gallery not restored');
  if(!status.roots.some(r=>r.alias==='My pictures <safe>'))throw new Error('Alias lost on reload');
  await removeLocation('/tmp/fs-090-alias-fixtures');if((await api('status')).roots.some(r=>r.root==='/tmp/fs-090-alias-fixtures'))throw new Error('Location not unlinked');
  return {aliasPersists:true,removeFromSidebar:true,thumbnailToggle:true,selectionPreserved:true,columnPointerResize:true,columnKeyboardResize:true,widthsPersistOnReload:true,thumbnailPreferencePersists:true,galleryRestored:true};
 })()`));
 if(errors.length)throw new Error('Browser exceptions: '+errors.join('; '));
} finally {clearTimeout(timer);ws.close();setTimeout(()=>process.exit(),200)}
