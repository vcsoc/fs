const endpoint = process.env.FS_CDP_URL || 'http://127.0.0.1:9280';
const targets = await (await fetch(endpoint + '/json/list')).json();
const target = targets.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
if (!target) throw new Error('No fs page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject) => {ws.onopen=resolve;ws.onerror=reject;});
const deadline=setTimeout(()=>process.exit(1),240000);
ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(deadline);console.log(JSON.stringify(message.result?.result?.value || message,null,2));ws.close();if(message.result?.exceptionDetails || message.result?.result?.value?.state !== 'complete')process.exitCode=1;};
ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,expression:`(async()=>{
  await refresh(); view('preferences');
  for(const [key,value] of [['model','embeddinggemma-2:740m'],['embedding_backend','direct'],['worker_memory_mb',Math.max(2048,status.preferences.worker_memory_mb)]]){
    $('pref-'+key).value=value;$('pref-'+key).dispatchEvent(new Event('input',{bubbles:true}));
  }
  $('setup-model').scrollIntoView({block:'center'});$('setup-model').click();
  const stages=new Set();let id;
  for(let n=0;n<2300;n++){
    await new Promise(r=>setTimeout(r,100));
    if(modelSetupRequest?.id)id=modelSetupRequest.id;
    if(!id)continue;
    const s=await api('status');
    const job=s.job.id===id?s.job:s.job.completed.find(item=>item.id===id);
    if(!job)continue;
    stages.add(job.phase);
    if(['complete','error','cancelled'].includes(job.state)){
      await refresh();return {state:job.state,error:job.error,model:job.model,stages:[...stages],inlineVisible:!$('model-setup-progress').hidden,label:$('model-setup-label').textContent,progress:$('model-download-progress').value,modalities:s.model_runtime.modalities};
    }
  }
  return {state:'timeout',label:$('model-setup-label').textContent};
})()`}}));
