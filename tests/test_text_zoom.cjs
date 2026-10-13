const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {zoomAction, nextScale, attachTextZoom} = require('../desktop/text-zoom.cjs');
test('text zoom shortcuts handle plus, equals, minus, reset and numeric keypad', () => {
  const input = {type:'keyDown',control:true,alt:false};
  for(const key of ['+','=']) assert.equal(zoomAction({...input,key}),'in');
  assert.equal(zoomAction({...input,key:'-'}),'out');
  assert.equal(zoomAction({...input,key:'0'}),'reset');
  assert.equal(zoomAction({...input,code:'NumpadAdd'}),'in');
  assert.equal(zoomAction({...input,key:'+',control:false}),null);
  assert.equal(zoomAction({...input,key:'+',alt:true}),null);
  assert.equal(zoomAction({...input,key:'+',type:'keyUp'}),null);
  assert.equal(zoomAction({...input,key:'=',control:false,meta:true}),'in');
});
test('text scale has bounded steps and reset', () => {
  assert.equal(nextScale(1,'in'),1.1);assert.equal(nextScale(1.1,'out'),1);
  assert.equal(nextScale(2,'in'),2);assert.equal(nextScale(.75,'out'),.75);
  assert.equal(nextScale(1.75,'reset'),1);
});
test('text zoom persists and reapplies CSS after service navigation without browser zoom', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fs-text-zoom-'));
  try {
    const file=path.join(dir,'zoom.json'); const scripts=[];
    const contents=new EventEmitter();contents.setZoomFactor=value=>assert.equal(value,1);contents.executeJavaScript=code=>{scripts.push(code);return Promise.resolve()};
    attachTextZoom(contents,file);let prevented=false;
    contents.emit('before-input-event',{preventDefault(){prevented=true}},{type:'keyDown',control:true,key:'+'});
    assert.equal(prevented,true);assert.equal(JSON.parse(fs.readFileSync(file)).scale,1.1);
    contents.emit('did-finish-load');assert.match(scripts.at(-1),/--text-scale.*1\.1/);
    const reopened=new EventEmitter();reopened.setZoomFactor=contents.setZoomFactor;reopened.executeJavaScript=contents.executeJavaScript;
    attachTextZoom(reopened,file);reopened.emit('did-finish-load');assert.match(scripts.at(-1),/1\.1/);
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
});
