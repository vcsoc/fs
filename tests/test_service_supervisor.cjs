const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ServiceSupervisor } = require('../desktop/service-supervisor.cjs');

function fixture(timeoutMs = 1000) {
  const children = [], exits = [], logs = [];
  const supervisor = new ServiceSupervisor({command:'fixture', args:[], options:{}, timeoutMs,
    onExit:record => exits.push(record), log:record => logs.push(record),
    spawnProcess:() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = children.length + 100;
      child.exitCode = null; child.signalCode = null;
      child.kill = signal => { child.signalCode = signal || 'SIGTERM'; child.emit('exit', null, child.signalCode); };
      children.push(child); return child;
    },
  });
  const ready = child => child.stdout.emit('data', '{"url":"http://127.0.0.1:12345"}\n');
  return {supervisor, children, exits, logs, ready};
}
test('unexpected exit preserves signal diagnostics and permits a replacement', async () => {
  const f = fixture(), start = f.supervisor.start(); f.ready(f.children[0]);
  assert.equal(await start, 'http://127.0.0.1:12345');
  f.children[0].stderr.emit('data', 'x'.repeat(10000)); f.children[0].kill('SIGKILL');
  assert.equal(f.exits.length, 1); assert.equal(f.exits[0].signal, 'SIGKILL'); assert.equal(f.exits[0].stderr.length, 4000);
  const second = f.supervisor.start(); f.ready(f.children[1]); await second;
  assert.equal(f.children.length, 2); f.supervisor.stop(); assert.equal(f.exits.length, 1);
});
test('intentional shutdown never invokes fatal/recovery handling', async () => {
  const f = fixture(), start = f.supervisor.start(); f.ready(f.children[0]); await start;
  f.supervisor.stop(); assert.equal(f.exits.length, 0); assert.equal(f.logs.at(-1).intentional, true);
  await assert.rejects(f.supervisor.start(), /shutting down/);
});
test('a healthy service cannot be duplicated by repeated start requests', async () => {
  const f = fixture(), start = f.supervisor.start(); f.ready(f.children[0]); await start;
  await assert.rejects(f.supervisor.start(), /already running/);
  assert.equal(f.children.length, 1); f.supervisor.stop();
});
test('invalid service URLs are refused and failed processes are terminated', async () => {
  const f = fixture(), start = f.supervisor.start();
  f.children[0].stdout.emit('data', '{"url":"https://example.com"}\n');
  await assert.rejects(start, /Invalid backend URL/); assert.equal(f.children[0].signalCode, 'SIGTERM'); assert.equal(f.exits.length, 0);
});
test('startup timeouts terminate only the owned child', async () => {
  const f = fixture(10); await assert.rejects(f.supervisor.start(), /did not start in time/);
  assert.equal(f.children[0].signalCode, 'SIGTERM'); assert.equal(f.exits.length, 0);
});
test('failed renderer restoration cleanup cannot leave an orphan service', async () => {
  const f = fixture(), start = f.supervisor.start(); f.ready(f.children[0]); await start;
  await f.supervisor.terminateCurrent(); assert.equal(f.supervisor.process, null); assert.equal(f.exits.length, 0);
});
