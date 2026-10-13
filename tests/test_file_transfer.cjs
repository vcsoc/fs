const test=require('node:test');
const assert=require('node:assert/strict');
const {fileUris}=require('../desktop/file-transfer.cjs');
test('file clipboard uses escaped native URIs, not plain paths or cut operations',()=>{
  assert.equal(fileUris(['/tmp/a space.jpg','/tmp/a#b.png']), 'file:///tmp/a%20space.jpg\r\nfile:///tmp/a%23b.png\r\n');
});
test('invalid and unbounded clipboard selections are rejected',()=>{
  for(const paths of [[],['relative.txt'],['/tmp/a\nb'],Array(201).fill('/tmp/a')])assert.throws(()=>fileUris(paths));
});
