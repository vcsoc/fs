'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="fs-token"]').content;
let mode = 'hybrid';
let status;
let layoutRevision = 0;
let layoutPending = 0;
let searchSequence = 0;
let debounce;
let searched = false;
let previousJob = 'idle';
let locationsSignature = '';
const filterIds = ['filename', 'root', 'modified-after', 'modified-before', 'created-after', 'created-before'];

async function api(path, body, signal) {
  const response = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The local search service could not complete that request.');
  return result;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function notice(text) { $('notice').textContent = text || ''; $('notice').hidden = !text; }
function report(error) { notice(error.message || String(error)); }
function applyTheme(theme) {
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
    window.fsDesktop?.setTheme?.(theme)?.catch(report);
  }
}
function basename(path) { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path; }
function size(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function view(name) {
  for (const key of ['search', 'locations', 'about', 'preferences']) {
    $(key + '-view').hidden = key !== name;
    $(key + '-nav').classList.toggle('active', key === name);
  }
  $('view-name').textContent = {search: 'Search', locations: 'Locations', about: 'About', preferences: 'Preferences'}[name];
}
for (const name of ['search', 'locations', 'about', 'preferences']) $(name + '-nav').onclick = () => view(name);
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => view(button.dataset.view);
function showIndex(root = '') {
  $('index-path').value = root;
  $('dialog-error').textContent = '';
  $('semantic-index').checked = true;
  $('index-dialog').showModal();
}
for (const id of ['add-location', 'welcome-add', 'locations-add']) $(id).onclick = () => showIndex();
$('close-dialog').onclick = () => $('index-dialog').close();
$('browse').hidden = !window.fsDesktop;
$('browse').onclick = async () => {
  try { const path = await window.fsDesktop.pickDirectory(); if (path) $('index-path').value = path; }
  catch (error) { $('dialog-error').textContent = error.message; }
};
$('index-form').onsubmit = async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const semantic = $('semantic-index').checked;
    const choice = semantic ? await modelChoice() : undefined;
    if (choice === null) return;
    const result = await api('index', { root: $('index-path').value, semantic, setup_choice: choice });
    $('index-dialog').close();
    if (result.queued) notice('Location queued · position ' + result.position + '. It will index automatically.');
    await refresh();
  } catch (error) { $('dialog-error').textContent = error.message; }
  finally { submit.disabled = false; }
};
$('cancel-job').onclick = () => api('cancel', {}).catch(report);

async function recheckLocation(root) {
  try {
    await api('source/check', {root});
    notice('Checking location availability…');
    for (let attempt = 0; attempt < 20; attempt++) {
      await refresh();
      const source = status.roots.find(item => item.root === root);
      if (!source || source.availability !== 'checking') {
        notice(source ? basename(root) + ' · ' + source.availability : 'Location removed.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    notice('Location check is still pending; status updates automatically.');
  } catch (error) { report(error); }
}
async function rescanLocation(root) {
  try {
    const choice = await modelChoice();
    if (choice === null) return;
    const result = await api('index', {root, semantic:true, setup_choice:choice});
    notice(result.queued ? 'Rescan queued · position ' + result.position : 'Rescanning ' + basename(root) + '…');
    await refresh();
  } catch (error) { report(error); }
}
let aliasRoot = null;
function locationLabel(root) { return status?.roots?.find(source => source.root === root)?.alias || basename(root); }
function renameLocation(root) {
  aliasRoot = root; $('location-alias-path').textContent = root;
  $('location-alias-input').value = status?.roots?.find(source => source.root === root)?.alias || '';
  $('location-alias-error').textContent = ''; $('location-alias-dialog').showModal(); $('location-alias-input').focus();
}
$('location-alias-cancel').onclick = () => $('location-alias-dialog').close();
$('location-alias-form').onsubmit = async event => {
  event.preventDefault();
  try {
    await api('source/alias', {root:aliasRoot, alias:$('location-alias-input').value});
    $('location-alias-dialog').close(); await refresh();
    if (!favouriteOnly && !browserFolder && $('root').value) $('folder-label').textContent = locationLabel($('root').value);
  } catch (error) { $('location-alias-error').textContent = error.message; }
};
async function removeLocation(root) {
  if (!confirm('Remove "' + locationLabel(root) + '" from fs? This removes its index and watcher, not the original files. Running scans will not be interrupted.')) return;
  try {
    await api('remove', {root});
    if ($('root').value === root) { $('root').value = ''; browserFolder = ''; }
    await refresh(); if (searched) await search();
    notice('Location removed from fs. Original files are unchanged.');
  } catch (error) { report(error); }
}
let locationMenu;
function closeLocationMenu() { locationMenu?.remove(); locationMenu = undefined; }
function openLocationMenu(event, root) {
  event.preventDefault(); closeLocationMenu();
  locationMenu = element('div', 'location-context-menu'); locationMenu.setAttribute('role', 'menu');
  locationMenu.setAttribute('aria-label', 'Location actions for ' + locationLabel(root));
  for (const [label, action] of [['Open in file manager', async () => { try { await api('source/open', {root}); } catch (error) { report(error); } }], ['Rescan location', () => rescanLocation(root)], ['Re-check availability', () => recheckLocation(root)], ['Rename alias', () => renameLocation(root)], ['Remove from fs', () => removeLocation(root)]]) {
    const button = element('button', '', label); button.setAttribute('role', 'menuitem');
    button.onclick = () => { closeLocationMenu(); action(); }; locationMenu.append(button);
  }
  document.body.append(locationMenu);
  const rect = event.currentTarget.getBoundingClientRect();
  locationMenu.style.left = Math.max(8, Math.min(event.clientX || rect.left, innerWidth - locationMenu.offsetWidth - 8)) + 'px';
  locationMenu.style.top = Math.max(8, Math.min(event.clientY || rect.bottom, innerHeight - locationMenu.offsetHeight - 8)) + 'px';
  locationMenu.firstElementChild.focus();
}
document.addEventListener('pointerdown', event => { if (locationMenu && !locationMenu.contains(event.target)) closeLocationMenu(); });
document.addEventListener('keydown', event => { if (!locationMenu) return; if (event.key === 'Escape' || event.key === 'Tab') closeLocationMenu(); else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = [...locationMenu.children]; buttons[(buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); } });
window.addEventListener('resize', closeLocationMenu);

function updateLocationCount(label, source) {
  label.textContent = source.files.toLocaleString() + (label.tagName === 'P' ? ' indexed files · ' + source.availability : '');
  label.title = source.files.toLocaleString() + ' files indexed / ' + (source.total_files == null ? 'total unknown; rescan to count files' : source.total_files.toLocaleString() + ' total files (last discovery)');
}
function renderLocations(roots) {
  const signature = JSON.stringify(roots.map(({root, availability, watch_enabled, alias}) => ({root, availability, watch_enabled, alias})));
  if (signature === locationsSignature) {
    for (const label of document.querySelectorAll('.location-count')) {
      const source = roots.find(item => item.root === label.dataset.root);
      if (source) updateLocationCount(label, source);
    }
    for (const label of document.querySelectorAll('.location-watcher')) {
      const source = roots.find(item => item.root === label.dataset.root);
      if (source) label.textContent = source.watch_status || (source.watch_enabled ? 'Watcher starting' : 'Paused');
    }
    return;
  }
  locationsSignature = signature;
  $('locations').replaceChildren();
  $('location-cards').replaceChildren();
  const selected = $('root').value;
  $('root').replaceChildren(new Option('All locations', ''));
  if (!roots.length) $('locations').append(element('p', 'empty-locations', 'Your folders will appear here.'));
  for (const root of roots) {
    const button = element('button', 'location-link');
    button.title = root.root + ' · ' + root.availability;
    button.append(element('span', '', root.availability === 'offline' ? '○' : '▤'), element('span', '', locationLabel(root.root) + (root.availability === 'offline' ? ' · offline' : '')));
    button.onclick = () => { browserFolder = ''; favouriteOnly = false; $('folder-label').textContent = locationLabel(root.root); view('search'); $('root').value = root.root; updateFilterCount(); search(); if (root.availability === 'offline') recheckLocation(root.root); };
    const sidebarCount = element('span', 'location-count'); sidebarCount.dataset.root = root.root; updateLocationCount(sidebarCount, root); button.append(sidebarCount);
    button.oncontextmenu = event => openLocationMenu(event, root.root);
    const row = element('div', 'location-row');
    const meter = element('progress', 'location-progress'); meter.max = 100; meter.hidden = true; meter.dataset.root = root.root; meter.setAttribute('aria-label', 'Indexing progress for ' + locationLabel(root.root));
    const remaining = element('span', 'location-remaining'); remaining.hidden = true; remaining.dataset.root = root.root;
    remaining.title = 'Files left in this scan, including the current file until processing finishes.';
    row.append(button, remaining, meter); $('locations').append(row);
    $('root').append(new Option(locationLabel(root.root), root.root));
    const card = element('div', 'location-card');
    card.oncontextmenu = event => openLocationMenu(event, root.root);
    const text = element('div');
    const count = element('p', 'location-count', root.files.toLocaleString() + ' cached files · ' + root.availability); count.dataset.root = root.root; updateLocationCount(count, root);
    const watcher = element('p', 'location-watcher', root.watch_status || (root.watch_enabled ? 'Watcher starting' : 'Paused')); watcher.dataset.root = root.root;
    watcher.title = root.scope === 'selected' ? 'File-only import: watches only the explicitly selected files, never unrelated siblings.' : 'Checks for new and changed files in bounded discovery slices; waits for stable files and idle indexing. Runs while fs is open.';
    text.append(element('h2', '', locationLabel(root.root)), element('p', '', root.root), count, watcher);
    const actions = element('div', 'location-actions');
    const reindex = element('button', '', 'Refresh index ↻');
    reindex.onclick = () => showIndex(root.root);
    const remove = element('button', '', 'Remove');
    remove.onclick = () => removeLocation(root.root);
    const rename = element('button', '', 'Rename alias'); rename.onclick = () => renameLocation(root.root);
    const check = element('button', '', 'Re-check status'); check.onclick = () => recheckLocation(root.root);
    const watch = element('button', '', root.watch_enabled ? 'Pause watcher' : 'Resume watcher');
    watch.onclick = async () => { try { await api('watch', {root:root.root, enabled:!root.watch_enabled}); await refresh(); } catch (error) { report(error); } };
    actions.append(reindex, check, watch, rename, remove); card.append(text, actions); $('location-cards').append(card);
  }
  if (roots.some(root => root.root === selected)) $('root').value = selected;
  if (searched && status?.job.state !== 'running') scheduleSearch();
}
function scanCounts(job) {
  const known = Number.isFinite(job.total) && job.phase === 'indexing';
  const done = Math.max(0, Number(job.processed ?? job.scanned) || 0);
  return {known, done, remaining: known ? Math.max(0, job.total - done) : null};
}
function updateScanProgress(job) {
  const running = job.state === 'running';
  const {known, done, remaining} = scanCounts(job);
  const fraction = known ? (job.total ? Math.min(1, done / job.total) : 1) : 0;
  for (const label of document.querySelectorAll('.location-remaining')) {
    label.hidden = !running || label.dataset.root !== job.root;
    label.textContent = known ? remaining.toLocaleString() + ' files remaining' : 'Counting remaining files…';
  }
  for (const meter of document.querySelectorAll('.location-progress')) {
    meter.hidden = !running || meter.dataset.root !== job.root;
    if (known) meter.value = fraction * 100; else meter.removeAttribute('value');
  }
  const summary = $('scan-summary'); summary.title = 'Overall progress averages per-location completion across this batch; queued locations count as zero until scanned. File discovery is indeterminate, not an elapsed-time estimate.'; summary.hidden = !running && !job.batch_total;
  if (job.batch_total) {
    const overall = Math.min(100, 100 * ((job.batch_completed || 0) + (running ? fraction : 0)) / job.batch_total);
    summary.textContent = (running ? (known ? done + '/' + job.total + ' files · ' + remaining + ' remaining' : 'Discovering / preparing') + ' · ' : '') + 'Overall scans ' + (!known && running ? '≥' : '') + overall.toFixed(1) + '% · ' + (job.batch_completed || 0) + '/' + job.batch_total + ' scans finished';
  }
}
async function refresh() {
  const requestedLayoutRevision = layoutRevision;
  const requestedDuringLayoutSave = layoutPending > 0;
  const requestedDisplayRevision = displayRevision;
  const requestedDuringDisplaySave = displayPending > 0 || columnResizeActive;
  try {
    const previousFileCount = status?.files;
    status = await api('status');
    renderLocations(status.roots);
    $('model-name').textContent = status.model;
    $('semantic-model').textContent = status.model;
    $('about-model').textContent = status.model;
    applyTheme(status.preferences.theme);
    fillPreferences(status.preferences);
    if (document.activeElement !== $('accuracy')) { $('accuracy').value = status.preferences.accuracy; $('accuracy-value').value = Math.round(status.preferences.accuracy * 100) + '%'; }
    if (!requestedDuringLayoutSave && !layoutPending && requestedLayoutRevision === layoutRevision && (!preferencesLoaded || resultLayout !== status.preferences.result_layout)) setLayout(status.preferences.result_layout);
    applyBrowserDisplay(status.preferences, requestedDisplayRevision, requestedDuringDisplaySave);
    preferencesLoaded = true;
    $('database-path').textContent = status.database;
    $('model-runtime-status').textContent = dirtyPreferences.has('model') || dirtyPreferences.has('embedding_backend') ? 'Unsaved selection · Set up embedding model applies your selected model and runtime first.' : status.model_runtime.direct_ready && status.model_runtime.backend === 'direct' ? 'Ready · ' + status.model + ' · ' + status.model_runtime.modalities.join(' / ') + ' · direct ONNX CPU · cached locally' : status.model + ' · runtime: ' + status.model_runtime.backend + ' · setup not yet verified';
    $('index-summary').textContent = status.files.toLocaleString() + ' files · ' + status.chunks.toLocaleString() + ' vector chunks · stored locally';
    if (!searched) {
      $('welcome').hidden = status.files > 0;
      if (status.files > 0) await search();
    }
    if (searched && previousFileCount !== undefined && previousFileCount !== status.files && status.job.state !== 'running') await search(false);
    const job = status.job;
    updateScanProgress(job);
    updateModelSetupProgress(job);
    const running = job.state === 'running';
    $('job-panel').hidden = !running;
    if (running) {
      const preparing = ['downloading', 'checking', 'installing', 'verifying'].includes(job.phase);
      $('job-label').textContent = preparing ? 'Setting up your embedding model' + (job.download_total ? ' · ' + Math.round(100 * (job.downloaded || 0) / job.download_total) + '%' : '') : job.phase === 'discovering' ? 'Discovering files · ' + job.discovered.toLocaleString() + ' files' : scanCounts(job).done.toLocaleString() + ' files scanned · ' + (scanCounts(job).known ? scanCounts(job).remaining.toLocaleString() + ' remaining' : 'Counting remaining…') + ' · ' + (job.updated || 0).toLocaleString() + ' updated · ' + (job.file_workers || 1) + ' workers';
      $('job-detail').textContent = (job.path || 'Connecting to local embedding model…') + (job.queued?.length ? ' · ' + job.queued.length + ' locations queued' : '');
    }
    if (previousJob === 'running' && !running) {
      if (job.state === 'error') notice(job.error);
      else if (job.state === 'offline') notice(job.message);
      else if (job.kind === 'model') notice(job.state === 'cancelled' ? 'Model setup cancelled.' : 'Model setup verified successfully · ' + job.model);
      else {
        notice(job.state === 'cancelled' ? 'Indexing stopped. Completed files are saved; refresh to resume.' : 'Index updated. ' + job.updated + ' files updated, ' + job.removed + ' removed, ' + job.errors + ' errors.');
        if (searched) await search(false);
      }
    }
    if (job.state === 'offline') notice(job.message);
    previousJob = job.state;
  } catch (error) { report(error); }
}
function renderResults(response) { renderBrowserResults(response); }
async function search(clearNotice = true) {
  const sequence = ++searchSequence;
  searched = true;
  if (clearNotice) notice('');
  $('search-button').disabled = true;
  $('search-button').textContent = 'Searching…';
  updateClearQuery();
  $('folder-label').textContent = favouriteOnly ? 'Favourite files' : browserFolder || ($('root').value ? locationLabel($('root').value) : 'All indexed locations');
  const body = {query: $('query').value, mode, limit: 100, file_type: browserType, folder: browserFolder, favourites_only: favouriteOnly, sort_by: browserSort, sort_desc: browserDescending, minimum_relevance: Number($('accuracy').value)};
  for (const id of filterIds) if ($(id).value) body[id.replaceAll('-', '_')] = $(id).value;
  try {
    const response = await api('search', body);
    if (sequence !== searchSequence) return;
    renderResults(response);
    if (response.warning) notice('Text results shown. ' + response.warning);
  } catch (error) { if (sequence === searchSequence) report(error); }
  finally {
    if (sequence === searchSequence) {
      $('search-button').disabled = false;
      $('search-button').replaceChildren(document.createTextNode('Find files '), element('span', '', '↗'));
    }
  }
}
function scheduleSearch() {
  clearTimeout(debounce);
  debounce = setTimeout(search, mode === 'semantic' || mode === 'hybrid' ? 400 : 180);
}
$('search-form').onsubmit = event => { event.preventDefault(); clearTimeout(debounce); search(); };
function updateClearQuery() { $('clear-query').hidden = !$('query').value; }
$('query').oninput = () => { updateClearQuery(); scheduleSearch(); };
$('clear-query').onclick = () => { $('query').value = ''; updateClearQuery(); $('query').focus(); clearTimeout(debounce); search(); };
for (const button of document.querySelectorAll('[data-mode]')) {
  button.onclick = () => {
    mode = button.dataset.mode;
    for (const other of document.querySelectorAll('[data-mode]')) other.classList.toggle('selected', other === button);
    $('query').placeholder = mode === 'regex' ? 'e.g. invoice[_-]\\d{4} or a content pattern…' : mode === 'filename' ? 'A filename, or part of one…' : 'Try “notes about the solar project”…';
    search();
  };
}
$('filter-toggle').onclick = () => {
  $('filters').hidden = !$('filters').hidden;
  $('filter-toggle').setAttribute('aria-expanded', String(!$('filters').hidden));
};
function updateFilterCount() {
  const count = filterIds.filter(id => $(id).value).length;
  $('filter-count').textContent = count ? '(' + count + ')' : '';
}
for (const id of filterIds) $(id).oninput = () => { updateFilterCount(); scheduleSearch(); };
$('clear-filters').onclick = () => { for (const id of filterIds) $(id).value = ''; updateFilterCount(); search(); };
document.addEventListener('keydown', event => {
  if ((event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key === 'k')) && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('index-dialog').open) {
    event.preventDefault(); view('search'); $('query').focus();
  }
});
let resolveModelChoice;
async function modelChoice() {
  const state = await api('model/status');
  if (!state.needs_install_consent) return undefined;
  return new Promise(resolve => { resolveModelChoice = resolve; $('model-dialog').showModal(); });
}
function chooseModel(choice) {
  $('model-dialog').close();
  const resolve = resolveModelChoice;
  resolveModelChoice = null;
  if (resolve) resolve(choice);
}
$('model-direct').onclick = () => chooseModel('direct');
$('model-ollama').onclick = () => chooseModel('ollama');
$('model-cancel').onclick = () => chooseModel(null);
$('model-dialog').addEventListener('cancel', () => chooseModel(null));
let modelSetupRequest = null;
function updateModelSetupProgress(job) {
  if (!modelSetupRequest) return;
  const panel = $('model-setup-progress'), meter = $('model-download-progress');
  panel.hidden = false;
  const tracked = job.id === modelSetupRequest.id ? job : job.completed?.find(item => item.id === modelSetupRequest.id);
  const queued = job.queued_jobs?.findIndex(item => item.id === modelSetupRequest.id);
  if (!tracked) { meter.removeAttribute('value'); $('model-setup-label').textContent = queued >= 0 ? 'Queued · position ' + (queued + 1) : 'Preparing model setup…'; return; }
  panel.dataset.state = tracked.state;
  const ended = ['complete', 'error', 'cancelled'].includes(tracked.state);
  $('setup-model').disabled = !ended;
  if (ended) {
    meter.value = tracked.state === 'complete' ? 100 : 0;
    $('model-setup-label').textContent = tracked.state === 'complete' ? 'Ready · ' + tracked.model + ' · setup verified successfully' : tracked.state === 'cancelled' ? 'Setup cancelled · retry to resume' : 'Model setup failed';
    $('model-setup-detail').textContent = tracked.error || '';
    return;
  }
  const downloading = tracked.phase === 'downloading';
  const known = downloading && tracked.download_total > 0;
  const percentage = known ? Math.min(100, 100 * (tracked.downloaded || 0) / tracked.download_total) : null;
  if (known) meter.value = percentage; else meter.removeAttribute('value');
  const labels = {downloading:'Downloading', installing:'Installing', verifying:'Verifying checksum', checking:'Checking / loading model'};
  $('model-setup-label').textContent = (labels[tracked.phase] || 'Preparing') + ' · ' + tracked.model + (known ? ' · ' + percentage.toFixed(1) + '%' : '');
  $('model-setup-detail').textContent = (tracked.path || '') + (known ? ' · ' + size(tracked.downloaded || 0) + ' / ' + size(tracked.download_total) : '');
}
$('setup-model').onclick = async () => {
  $('setup-model').disabled = true; modelSetupRequest = {id:null};
  updateModelSetupProgress({});
  try {
    const edits = readPreferenceEdits();
    if (Object.keys(edits).length) { const saved = await api('preferences', edits); dirtyPreferences.clear(); fillPreferences(saved); }
    await refresh();
    const choice = await modelChoice();
    if (choice === null) { modelSetupRequest = null; $('model-setup-progress').hidden = true; $('setup-model').disabled = false; return; }
    const result = await api('model/setup', {choice});
    modelSetupRequest = {id:result.job_id};
    await refresh();
  } catch (error) { $('setup-model').disabled = false; $('model-download-progress').value = 0; $('model-setup-progress').dataset.state = 'error'; $('model-setup-label').textContent = 'Model setup failed'; $('model-setup-detail').textContent = error.message; modelSetupRequest = null; report(error); }
};
const preferenceDefaults = {accuracy:0.68, result_layout:'list', theme: 'dark', model: 'embeddinggemma-2:740m', embedding_backend: 'direct', cpu_threads: 2, file_workers: 2, scan_duty_percent: 25, worker_memory_mb: 2048, max_file_mb: 8, max_chunks: 64, use_gpu: false};
let preferencesLoaded = false;
const dirtyPreferences = new Set();
$('preferences-form').oninput = event => { if (event.target.id.startsWith('pref-')) dirtyPreferences.add(event.target.id.slice(5)); };
function fillPreferences(prefs) {
  for (const key of Object.keys(preferenceDefaults)) {
    if (dirtyPreferences.has(key)) continue;
    const input = $('pref-' + key);
    if (key === 'use_gpu') input.checked = prefs[key];
    else input.value = prefs[key];
  }
}
function readPreferenceEdits() {
  const prefs = {};
  for (const key of dirtyPreferences) {
    const input = $('pref-' + key);
    prefs[key] = ['theme', 'model', 'embedding_backend', 'result_layout'].includes(key) ? input.value : key === 'use_gpu' ? input.checked : Number(input.value);
  }
  return prefs;
}
$('preferences-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const saved = await api('preferences', readPreferenceEdits());
    dirtyPreferences.clear(); fillPreferences(saved); await refresh();
    applyTheme(saved.theme);
    $('preferences-message').textContent = 'Saved. Resource limits apply to the next indexing job.';
  } catch (error) { $('preferences-message').textContent = error.message; }
};
$('reset-preferences').onclick = () => { dirtyPreferences.clear(); fillPreferences(preferenceDefaults); Object.keys(preferenceDefaults).forEach(key => dirtyPreferences.add(key)); $('preferences-message').textContent = 'Defaults restored in this form. Save to apply.'; };
document.addEventListener('DOMContentLoaded', () => { refresh(); refreshFavourites().catch(report); });
setInterval(refresh, 1500);
