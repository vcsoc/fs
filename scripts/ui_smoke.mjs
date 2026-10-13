import { writeFile } from 'node:fs/promises';

const endpoint = process.env.FS_CDP_URL || 'http://127.0.0.1:9230';
const root = process.env.FS_UI_ROOT || '/tmp/fs-ui-docs';
const semantic = process.env.FS_UI_SEMANTIC === '1';
const targets = await (await fetch(endpoint + '/json/list')).json();
const target = targets.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
if (!target) throw new Error('Start fs with --remote-debugging-port=9230 first.');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = event => {
  const data = JSON.parse(event.data);
  if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.text);
  if (data.id) {
    const pair = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) pair.reject(new Error(data.error.message));
    else pair.resolve(data.result);
  }
};
function command(method, params = {}) {
  return new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params })); });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const timer = setTimeout(() => { console.error('UI smoke test timed out'); process.exit(1); }, 20000);
try {
  await command('Runtime.enable');
  await command('Page.enable');
  const result = await evaluate(`(async () => {
    const assert = (ok, text) => { if (!ok) throw new Error(text); };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async check => { for (let i=0;i<80;i++) { if(await check()) return; await wait(100); } throw new Error('UI condition timed out'); };
    await document.fonts.ready;
    assert(document.documentElement.dataset.theme === 'dark', 'Default dark theme');
    assert(getComputedStyle(document.body).fontFamily.includes('JetBrains Mono'), 'Bundled font');
    assert(typeof window.fsDesktop.pickDirectory === 'function', 'Sandboxed native picker bridge');
    document.getElementById('preferences-nav').click();
    assert(!document.getElementById('preferences-view').hidden, 'Preferences navigation');
    const originalApi = api;
    api = async (path, ...args) => path === 'model/status' ? {needs_install_consent:true} : originalApi(path, ...args);
    const choice = modelChoice();
    await until(() => document.getElementById('model-dialog').open);
    document.getElementById('model-direct').click();
    assert(await choice === 'direct', 'Declining installation selects the built-in runtime');
    api = originalApi;
    await api('preferences', {scan_duty_percent:100, max_file_mb:0, cpu_threads:1});
    document.getElementById('search-nav').click();
    document.getElementById('add-location').click();
    document.getElementById('index-path').value = ${JSON.stringify(root)};
    document.getElementById('semantic-index').checked = ${JSON.stringify(semantic)};
    document.getElementById('index-form').requestSubmit(document.querySelector('#index-form button[type=submit]'));
    await until(async () => { const status=await api('status'); return status.files > 0 && status.job.state === 'complete'; });
    document.getElementById('query').value = 'solar';
    document.querySelector('[data-mode="text"]').click();
    await until(() => !document.getElementById('search-button').disabled);
    assert(document.querySelectorAll('.result-card').length === 1, 'Content search');
    if (${JSON.stringify(semantic)}) {
      document.querySelector('[data-mode="semantic"]').click();
      await until(() => !document.getElementById('search-button').disabled);
      assert(document.querySelectorAll('.result-card').length === 1, 'Real managed semantic search');
      assert(!document.getElementById('notice').textContent.includes('unavailable'), 'No MLX failure');
    }
    document.querySelector('[data-mode="filename"]').click();
    await until(() => !document.getElementById('search-button').disabled);
    assert(document.querySelector('.file-title').textContent === 'solar-notes.txt', 'Filename search');
    document.querySelector('[data-mode="regex"]').click();
    await until(() => !document.getElementById('search-button').disabled);
    assert(document.querySelectorAll('.result-card').length === 1, 'Regex search');
    document.getElementById('modified-after').value = '2099-01-01';
    await search();
    assert(document.querySelectorAll('.result-card').length === 0, 'Date filter');
    document.getElementById('clear-filters').click();
    await until(() => !document.getElementById('search-button').disabled);
    document.getElementById('about-nav').click();
    assert(document.querySelector('.developer').textContent === 'Developed by Chris Visser', 'Developer credit');
    assert(document.querySelector('.about-card a').href === 'https://github.com/vcsoc/fs', 'GitHub link');
    document.getElementById('search-nav').click();
    return {font:getComputedStyle(document.body).fontFamily, theme:document.documentElement.dataset.theme, results:document.querySelectorAll('.result-card').length, nativePicker:true};
  })()`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const desktop = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(process.env.FS_UI_SCREENSHOT || '/tmp/fs-ui-desktop.png', Buffer.from(desktop.data, 'base64'));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise(resolve => setTimeout(resolve, 250));
  const mobileWidth = await evaluate('({scroll:document.documentElement.scrollWidth, width:innerWidth})');
  if (mobileWidth.scroll > mobileWidth.width) throw new Error('Mobile layout overflows horizontally');
  const mobile = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/fs-ui-mobile.png', Buffer.from(mobile.data, 'base64'));
  await command('Emulation.clearDeviceMetricsOverride');
  if (exceptions.length) throw new Error(exceptions.join('\n'));
  console.log(JSON.stringify({ ...result, mobileOverflow: false, browserExceptions: exceptions.length }, null, 2));
} finally { clearTimeout(timer); ws.close(); }
