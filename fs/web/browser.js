'use strict';
let browserType = '';
let browserFolder = '';
let favouriteOnly = false;
let browserSort = 'score';
let browserDescending = true;
let resultLayout = localStorage.getItem('fs-layout-v2') || 'list';
let layoutSaveChain = Promise.resolve();
let browserResults = [];
let favouriteEntries = [];
const selectedFiles = new Set();
let hoverVideo = null;
let hoverAnimation = null;
let viewerFile = null;
let viewerData = null;
let viewerEpoch = 0;
let matchPosition = -1;
let clipEnd = null;
let pdfDocument = null;
let pdfObserver = null;
let pdfRenderTasks = new Set();

function sidebar(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  $('brand-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('brand-toggle').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  localStorage.setItem('fs-sidebar-collapsed', String(collapsed));
}
sidebar(localStorage.getItem('fs-sidebar-collapsed') === 'true' || innerWidth <= 760);
$('brand-toggle').onclick = () => sidebar(!document.body.classList.contains('sidebar-collapsed'));

function setLayout(layout) {
  resultLayout = layout;
  localStorage.setItem('fs-layout-v2', layout);
  hideGalleryDetails();
  $('results').classList.toggle('justified-gallery', layout === 'masonry');
  $('results').classList.toggle('thumbnail-grid', layout === 'grid');
  $('results').classList.toggle('compact-list', layout === 'list');
  $('results').classList.toggle('hybrid-list', layout === 'hybrid');
  document.body.dataset.resultLayout = layout;
  scheduleGallery();
  for (const name of ['list', 'hybrid', 'grid', 'masonry']) $(name + '-view').setAttribute('aria-pressed', String(layout === name));
}
for (const layout of ['list', 'grid', 'hybrid', 'masonry']) $(layout + '-view').onclick = () => {
  layoutRevision++; layoutPending++; setLayout(layout);
  // Preserve click order, and do not let a stale status poll undo local intent.
  layoutSaveChain = layoutSaveChain.then(() => api('preferences', {result_layout:layout}))
    .catch(error => { report(error); }).finally(() => { layoutPending--; });
};
$('accuracy').oninput = () => { $('accuracy-value').value = Math.round(Number($('accuracy').value) * 100) + '%'; scheduleSearch(); };
$('accuracy').onchange = async () => { clearTimeout(debounce); try { await api('preferences', {accuracy:Number($('accuracy').value)}); await search(); } catch (error) { report(error); } };
setLayout(resultLayout);
for (const button of document.querySelectorAll('[data-sort]')) {
  button.onclick = () => {
    browserDescending = browserSort === button.dataset.sort ? !browserDescending : button.dataset.sort !== 'name';
    browserSort = button.dataset.sort;
    for (const header of document.querySelectorAll('[data-sort]')) {
      header.querySelector('span').textContent = header.dataset.sort === browserSort ? browserDescending ? '↓' : '↑' : '';
      header.setAttribute('aria-label', header.dataset.sort + (header.dataset.sort === browserSort ? browserDescending ? ', descending' : ', ascending' : ', click to sort'));
    }
    search();
  };
}
for (const button of document.querySelectorAll('[data-type]')) button.onclick = () => {
  browserType = button.dataset.type;
  for (const item of document.querySelectorAll('[data-type]')) item.classList.toggle('active', item === button);
  view('search'); search();
};
for (const button of document.querySelectorAll('[data-date]')) button.onclick = () => {
  $('modified-before').value = '';
  const now = new Date();
  if (button.dataset.date === 'week') now.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  if (button.dataset.date === 'month') now.setDate(1);
  const localDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  $('modified-after').value = button.dataset.date === 'any' ? '' : localDate;
  for (const item of document.querySelectorAll('[data-date]')) item.classList.toggle('active', item === button);
  updateFilterCount(); search();
};
$('custom-dates').onclick = () => { $('filters').hidden = false; $('filter-toggle').setAttribute('aria-expanded', 'true'); $('modified-after').focus(); };
function scopeFolder(path, favourites = false) {
  $('root').value = '';
  browserFolder = path;
  favouriteOnly = favourites;
  $('folder-label').textContent = favourites ? 'Favourite files' : path || 'All indexed locations';
  view('search'); search();
}
$('clear-folder').onclick = () => { view('search'); scopeFolder(''); };
$('search-nav').onclick = () => { view('search'); scopeFolder(''); };
$('show-favourites').onclick = () => scopeFolder('', true);

function selectionChanged() {
  $('selection-count').textContent = selectedFiles.size ? '(' + selectedFiles.size + ')' : '';
  $('favourite-selected').disabled = selectedFiles.size === 0;
}
async function refreshFavourites() {
  favouriteEntries = await api('favourites');
  renderFavourites();
}
function renderFavourites() {
  $('favourites').replaceChildren();
  if (!favouriteEntries.length) $('favourites').append(element('p', 'empty-locations', 'Pin folders or select files below.'));
  for (const favourite of favouriteEntries) {
    const row = element('div', 'favourite-row');
    const button = element('button', 'location-link');
    button.title = favourite.path;
    button.append(element('span', '', favourite.kind === 'folder' ? '▤' : '◇'), element('span', '', basename(favourite.path)));
    button.onclick = () => favourite.kind === 'folder' ? scopeFolder(favourite.path) : favourite.id ? openViewer({id: favourite.id, name: basename(favourite.path)}) : notice('This favourite is not currently indexed. Refresh its location.');
    const remove = element('button', 'remove-favourite', '×');
    remove.setAttribute('aria-label', 'Unpin ' + basename(favourite.path));
    remove.onclick = async () => {
      try { favouriteEntries = await api('favourites', {action: 'remove', path: favourite.path}); renderFavourites(); }
      catch (error) { report(error); }
    };
    row.append(button, remove); $('favourites').append(row);
  }
}
$('favourite-selected').onclick = async () => {
  try { favouriteEntries = await api('favourites', {action: 'add', ids: [...selectedFiles]}); renderFavourites(); notice(selectedFiles.size + ' files added to Favourites.'); }
  catch (error) { report(error); }
};
$('add-favourite-folder').onclick = () => { $('favourite-error').textContent = ''; $('favourite-dialog').showModal(); };
$('favourite-cancel').onclick = () => $('favourite-dialog').close();
$('favourite-browse').hidden = !window.fsDesktop;
$('favourite-browse').onclick = async () => { try { const path = await window.fsDesktop.pickDirectory(); if (path) $('favourite-path').value = path; } catch (error) { $('favourite-error').textContent = error.message; } };
$('favourite-form').onsubmit = async event => {
  event.preventDefault();
  try { favouriteEntries = await api('favourites', {action: 'add', path: $('favourite-path').value}); renderFavourites(); $('favourite-dialog').close(); }
  catch (error) { $('favourite-error').textContent = error.message; }
};
function timeLabel(value) {
  const minutes = Math.floor(value / 60);
  const seconds = (value % 60).toFixed(1).padStart(4, '0');
  return minutes + ':' + seconds;
}
function pauseHover() {
  if (hoverAnimation) { hoverAnimation.close(); hoverAnimation = null; }
  if (hoverVideo) {
    hoverVideo.parentElement.classList.remove('preview-playing');
    hoverVideo.pause(); hoverVideo.removeAttribute('src'); hoverVideo.load(); hoverVideo.hidden = true;
    hoverVideo = null;
  }
}
function pointerRatio(holder, event) {
  const rect = holder.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
}
async function hoverMediaURL(file) {
  const expires = Number(new URL(file.media_url, location.href).searchParams.get('expires') || Infinity);
  if (expires * 1000 > Date.now() + 60000) return file.media_url;
  const fresh = await api('preview', {id:file.id, query:'', mode:'filename'});
  file.media_url = fresh.media_url;
  return fresh.media_url;
}
function thumbnail(file) {
  const holder = element('div', 'file-thumbnail');
  holder.append(element('span', 'file-extension', file.name.includes('.') ? file.name.split('.').pop().slice(0, 5).toUpperCase() : 'FILE'));
  if (['image', 'video'].includes(file.kind)) {
    const image = element('img');
    image.loading = 'lazy'; image.decoding = 'async'; image.alt = ''; image.src = file.thumbnail_url;
    image.onerror = () => image.remove();
    holder.append(image);
  }
  if (file.kind === 'video') {
    holder.append(element('span', 'video-badge', '▷ muted'));
    const timeline = thumbnailTimeline(holder, file);
    const video = element('video', 'hover-video');
    video.muted = true; video.defaultMuted = true; video.playsInline = true; video.loop = true; video.preload = 'none'; video.hidden = true;
    video.setAttribute('muted', ''); video.setAttribute('aria-label', 'Muted video hover preview');
    video.onvolumechange = () => { if (!video.muted) video.muted = true; };
    let ratio = 0, lastSeek = 0, seekTimer;
    video.onerror = () => { holder.title = 'Inline preview unavailable: ' + (video.error?.message || 'media could not be decoded'); };
    const seek = () => {
      if (hoverVideo !== video || video.readyState < 1 || !Number.isFinite(video.duration)) return;
      video.currentTime = Math.max(0, Math.min(video.duration - 0.05, ratio * video.duration));
      video.play().catch(error => { if (hoverVideo === video) holder.title = 'Inline preview paused: ' + error.message; });
    };
    video.onloadedmetadata = () => { timeline.matches(video.duration); seek(); };
    video.ontimeupdate = () => timeline.update(video.currentTime / video.duration);
    video.onseeking = () => timeline.update(video.currentTime / video.duration);
    holder.onpointerenter = async event => {
      if (event.pointerType === 'touch') return;
      pauseHover(); hoverVideo = video; video.hidden = false; holder.classList.add('preview-playing');
      ratio = pointerRatio(holder, event);
      try {
        const url = await hoverMediaURL(file);
        if (hoverVideo === video) { video.src = url; video.load(); }
      } catch (error) { if (hoverVideo === video) { holder.title = error.message; pauseHover(); } }
    };
    holder.onpointermove = event => {
      ratio = pointerRatio(holder, event);
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => { lastSeek = performance.now(); seek(); }, Math.max(0, 90 - (performance.now() - lastSeek)));
    };
    holder.onpointerleave = () => { clearTimeout(seekTimer); if (hoverVideo === video) pauseHover(); };
    holder.append(video);
    queueThumbnailMetadata(video, holder, file);
  } else if (file.kind === 'image' && /\.(gif|webp|png)$/i.test(file.name)) {
    const timeline = thumbnailTimeline(holder, file);
    const canvas = element('canvas', 'hover-animation'); canvas.hidden = true;
    canvas.setAttribute('aria-label', 'Animated image hover preview');
    holder.append(canvas);
    holder.onpointerenter = async event => {
      if (event.pointerType === 'touch') return;
      pauseHover();
      const preview = new AnimatedThumbnailPreview(canvas, ratio => timeline.update(ratio)); hoverAnimation = preview;
      preview.scrub(pointerRatio(holder, event));
      try { const url = await hoverMediaURL(file); if (!preview.closed) await preview.load(url, 'image/' + file.name.split('.').pop().toLowerCase()); }
      catch (error) { if (!preview.closed) { holder.title = error.message; preview.close(); } }
    };
    holder.onpointermove = event => { if (hoverAnimation?.canvas === canvas) hoverAnimation.scrub(pointerRatio(holder, event)); };
    holder.onpointerleave = () => { if (hoverAnimation?.canvas === canvas) pauseHover(); };
  }
  return holder;
}
function dateLabel(stamp) { return stamp == null ? 'Unknown' : new Date(stamp * 1000).toLocaleDateString(); }
function renderBrowserResults(response) {
  pauseHover(); hideGalleryDetails(); selectedFiles.clear(); selectionChanged(); browserResults = response.results;
  $('results').replaceChildren(); $('welcome').hidden = true;
  $('results-label').textContent = $('query').value.trim() ? 'Search results' : 'Your files';
  $('results-meta').title = 'Percentages are actual semantic cosine similarity. Exact denotes a direct keyword/filename/regex match. Neither is a confidence estimate.';
  $('results-meta').textContent = response.total.toLocaleString() + ' files · ' + response.elapsed_ms + ' ms' + (response.total > response.results.length ? ' · first ' + response.results.length : '');
  if (!response.results.length) {
    const empty = element('div', 'no-results');
    empty.append(element('h2', '', 'No files to show'), element('p', '', 'Try another phrase, clear a filter, or add an indexed location.'));
    $('results').append(empty);
    if (!status?.files) { $('results').replaceChildren(); $('welcome').hidden = false; }
  }
  for (const file of response.results) {
    const card = element('article', 'result-card'); card.tabIndex = 0; card.dataset.id = file.id; card.classList.toggle('source-offline', file.availability === 'offline');
    card.ondblclick = () => openViewer(file);
    card.onkeydown = event => { if (event.key === 'Enter' && event.target === card) openViewer(file); };
    const check = element('input', 'file-select'); check.type = 'checkbox'; check.setAttribute('aria-label', 'Select ' + file.name);
    check.onchange = () => { check.checked ? selectedFiles.add(file.id) : selectedFiles.delete(file.id); card.classList.toggle('selected', check.checked); selectionChanged(); };
    check.ondblclick = event => event.stopPropagation();
    const preview = thumbnail(file);
    observeGalleryCard(card, preview, file);
    const main = element('div', 'file-main');
    const title = element('button', 'file-title', file.name); title.onclick = () => openViewer(file);
    const path = element('div', 'file-path', file.path + (file.availability === 'offline' ? ' · OFFLINE (cached)' : '')); path.title = file.path;
    const excerpt = element('p', 'file-excerpt', file.excerpt || '');
    main.append(title, path, excerpt); title.title = file.name;
    const relevance = element('div', 'relevance-cell', file.relevance == null ? '—' : file.relevance_basis === 'literal' ? 'Exact' : file.relevance.toFixed(1) + '%');
    if (file.error) relevance.append(element('span', 'partial-analysis', ' · partial'));
    relevance.title = (file.relevance_type || 'Relevance is shown after a search') + (file.error ? ' · Incomplete analysis: ' + file.error : '');
    if (file.relevance != null) { const meter = element('span', 'relevance-meter'); meter.style.width = file.relevance + '%'; relevance.append(meter); }
    const bytes = element('div', 'size-cell', size(file.size));
    const modified = element('div', 'date-cell', dateLabel(file.modified)); modified.title = new Date(file.modified * 1000).toLocaleString();
    const created = element('div', 'created-cell', dateLabel(file.created));
    const location = element('div', 'location-cell', (file.availability === 'offline' ? 'OFFLINE · ' : '') + file.path); location.title = file.path + ' · ' + file.availability;
    const added = element('div', 'index-date-cell', dateLabel(file.indexed_at));
    const analysed = element('div', 'index-date-cell', dateLabel(file.analyzed_at));
    added.title = file.indexed_at == null ? 'Original index-added time is unknown' : new Date(file.indexed_at * 1000).toLocaleString();
    analysed.title = file.analyzed_at == null ? 'No recorded successful analysis' : new Date(file.analyzed_at * 1000).toLocaleString();
    card.append(check, preview, main, location, relevance, bytes, modified, created, added, analysed); $('results').append(card);
  }
  setLayout(resultLayout);
}

// Build highlights only with text nodes; document/source markup is never executed.
function highlighted(container, text, ranges) {
  const points = Array.from(text);
  const events = new Map();
  for (const [index, match] of ranges.entries()) {
    const start = Math.max(0, match.start), end = Math.min(points.length, match.end);
    if (end <= start) continue;
    for (const [position, add] of [[start, true], [end, false]]) {
      if (!events.has(position)) events.set(position, []);
      events.get(position).push({index, add, type: match.type});
    }
  }
  const positions = [...new Set([0, points.length, ...events.keys()])].sort((a, b) => a - b);
  const active = new Map();
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i], end = positions[i + 1];
    for (const event of events.get(start) || []) event.add ? active.set(event.index, event.type) : active.delete(event.index);
    const part = points.slice(start, end).join('');
    if (active.size) {
      const mark = element('mark', [...active.values()].includes('literal') ? 'literal-match' : 'semantic-match', part);
      mark.title = mark.className === 'semantic-match' ? 'Semantically related indexed passage' : 'Search text match'; fragment.append(mark);
    } else fragment.append(document.createTextNode(part));
  }
  container.replaceChildren(fragment);
}
function closeViewer() {
  viewerEpoch++; pauseHover(); closeMediaControls();
  for (const media of $('viewer-body').querySelectorAll('video,audio')) { media.pause(); media.removeAttribute('src'); media.load(); }
  pdfObserver?.disconnect(); pdfObserver = null;
  for (const task of pdfRenderTasks) task.cancel(); pdfRenderTasks.clear();
  pdfDocument?.loadingTask?.destroy().catch(() => {}); pdfDocument = null;
  $('viewer-body').replaceChildren(); $('video-sections').replaceChildren(); $('video-timeline').replaceChildren();
  if ($('viewer-dialog').open) $('viewer-dialog').close();
  document.body.append($('service-recovery'));
}
$('viewer-close').onclick = closeViewer;
$('viewer-dialog').addEventListener('cancel', event => { event.preventDefault(); closeViewer(); });
function jumpMatch(delta) {
  const marks = $('viewer-dialog').querySelectorAll('#viewer-body mark,.pdf-highlight,#video-matches mark');
  if (!marks.length) return;
  matchPosition = (matchPosition + delta + marks.length) % marks.length;
  const details = marks[matchPosition].closest('details'); if (details) details.open = true;
  marks[matchPosition].scrollIntoView({block: 'center', behavior: 'smooth'});
  for (const mark of marks) mark.classList.remove('current-match'); marks[matchPosition].classList.add('current-match');
}
$('next-match').onclick = () => jumpMatch(1);
$('previous-match').onclick = () => jumpMatch(-1);
$('viewer-favourite').onclick = async () => { if (!viewerFile) return; try { favouriteEntries = await api('favourites', {action: 'add', ids: [viewerFile.id]}); renderFavourites(); $('viewer-favourite').textContent = '★'; } catch (error) { $('viewer-notice').textContent = error.message; } };
$('viewer-external').onclick = () => viewerFile && api('open', {id: viewerFile.id}).catch(error => { $('viewer-notice').textContent = error.message; });
function textPreview(data) {
  const pre = element('pre', 'document-text'); highlighted(pre, data.text, data.matches); $('viewer-body').replaceChildren(pre);
}
async function pdfPreview(data, epoch) {
  const pdfjs = await import('/vendor/pdf.mjs');
  if (epoch !== viewerEpoch) return;
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
  const document = await pdfjs.getDocument({url: data.media_url, isEvalSupported: false, useWasm: false, useSystemFonts: true}).promise;
  if (epoch !== viewerEpoch) { await document.loadingTask.destroy(); return; }
  pdfDocument = document; $('viewer-body').replaceChildren();
  const original = Array.from(data.text);
  const literals = [...new Set(data.matches.filter(m => m.type === 'literal').map(m => original.slice(m.start, m.end).join('').toLocaleLowerCase()))];
  const semantics = data.matches.filter(m => m.type === 'semantic').map(m => original.slice(m.start, m.end).join('').toLocaleLowerCase());
  const render = async holder => {
    if (holder.dataset.busy || holder.querySelector('canvas')) return;
    holder.dataset.busy = '1';
    try {
      const page = await document.getPage(Number(holder.dataset.page));
      const width = Math.min(1000, Math.max(280, $('viewer-body').clientWidth - 50));
      const natural = page.getViewport({scale: 1}); const viewport = page.getViewport({scale: width / natural.width});
      const canvas = element('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
      holder.style.height = viewport.height + 'px'; holder.style.width = viewport.width + 'px';
      holder.replaceChildren(canvas);
      const task = page.render({canvasContext: canvas.getContext('2d'), viewport, intent: 'print'}); pdfRenderTasks.add(task);
      await task.promise; pdfRenderTasks.delete(task);
      if (epoch !== viewerEpoch) return;
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!item.str || !item.transform) continue;
        const value = item.str.toLocaleLowerCase();
        const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
        const height = Math.hypot(matrix[2], matrix[3]);
        const ranges = [];
        for (const literal of literals) {
          if (!literal) continue;
          let start = 0, offset;
          while ((offset = value.indexOf(literal, start)) >= 0) { ranges.push([offset, offset + literal.length, 'literal']); start = offset + Math.max(1, literal.length); }
        }
        if (value.trim().length > 4 && semantics.some(passage => passage.includes(value.trim()))) ranges.push([0, value.length, 'semantic']);
        for (const [start, end, type] of ranges) {
          const rectangle = element('span', 'pdf-highlight ' + type + '-match');
          rectangle.style.left = (matrix[4] + item.width * viewport.scale * start / value.length) + 'px';
          rectangle.style.top = (matrix[5] - height) + 'px'; rectangle.style.width = (item.width * viewport.scale * (end - start) / value.length) + 'px'; rectangle.style.height = height + 'px';
          holder.append(rectangle);
        }
      }
    } catch (error) { if (epoch === viewerEpoch && error.name !== 'RenderingCancelledException') $('viewer-notice').textContent = 'PDF layout unavailable: ' + error.message + '. Use Extracted text.'; }
    finally { delete holder.dataset.busy; }
  };
  pdfObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) render(entry.target);
      else if (!entry.target.dataset.busy) { const canvas = entry.target.querySelector('canvas'); if (canvas) { canvas.width = 0; canvas.height = 0; entry.target.replaceChildren(); } }
    }
  }, {root: $('viewer-body'), rootMargin: '250px'});
  for (let number = 1; number <= Math.min(document.numPages, 100); number++) {
    const holder = element('div', 'pdf-page'); holder.dataset.page = number; holder.setAttribute('aria-label', 'PDF page ' + number); holder.style.height = '800px'; $('viewer-body').append(holder); pdfObserver.observe(holder);
  }
  // Render the first page immediately; subsequent pages are viewport-lazy.
  if ($('viewer-body').firstChild) await render($('viewer-body').firstChild);
}
function mediaPreview(data) {
  const media = element(data.kind === 'audio' ? 'audio' : 'video', 'viewer-media');
  media.controls = false; media.autoplay = data.kind === 'video'; media.muted = true; media.defaultMuted = true; media.setAttribute('muted', ''); media.playsInline = true; media.preload = 'metadata'; media.src = data.media_url;
  media.onerror = () => { $('viewer-notice').textContent = media.error?.code === 2 ? 'Media could not be read. Re-check the location connection, then reopen the video.' : 'This codec could not be decoded by the built-in player. Use Open in system app for this file. ' + (media.error?.message || ''); };
  media.ontimeupdate = () => { if (clipEnd !== null && media.currentTime >= clipEnd) { media.pause(); clipEnd = null; } };
  media.onseeking = () => { if (clipEnd !== null && media.currentTime > clipEnd) clipEnd = null; };
  $('viewer-body').replaceChildren(media);
  $('video-matches').hidden = !data.sections.length && !data.text;
  const jump = section => { media.currentTime = section.start; clipEnd = section.end; media.play().catch(error => { $('viewer-notice').textContent = error.message; }); };
  for (const section of data.sections) {
    const button = element('button', 'video-section');
    button.append(element('strong', '', timeLabel(section.start) + ' → ' + timeLabel(section.end)), element('span', '', section.text), element('small', '', section.type === 'semantic' ? 'Related passage · similarity ' + section.score : 'Caption text match'));
    button.onclick = () => jump(section); $('video-sections').append(button);
  }
  if (data.text) {
    const details = element('details', 'media-transcript'); details.append(element('summary', '', 'Caption text'));
    const transcript = element('pre', 'document-text transcript'); highlighted(transcript, data.text, data.matches);
    details.append(transcript); $('video-sections').append(details);
  }
  setupMediaControls(media, data, () => { clipEnd = null; });
}
function showServiceRecovery(message, failed = false) {
  const parent = $('viewer-dialog').open ? $('viewer-dialog') : document.body;
  parent.append($('service-recovery'));
  $('service-recovery-message').textContent = message;
  $('service-retry').hidden = !failed || !window.fsDesktop;
  $('service-recovery').hidden = false;
}
$('service-dismiss').onclick = () => { $('service-recovery').hidden = true; };
$('service-retry').onclick = () => window.fsDesktop?.retryService();
function captureRecoveryState() {
  const media = $('viewer-body').querySelector('video,audio');
  return {
    query:$('query').value, mode, filters:Object.fromEntries(filterIds.map(id => [id, $(id).value])),
    accuracy:$('accuracy').value, browserType, browserFolder, favouriteOnly, browserSort, browserDescending,
    sidebarCollapsed:document.body.classList.contains('sidebar-collapsed'),
    viewer:$('viewer-dialog').open && viewerFile ? {id:viewerFile.id, name:viewerFile.name} : null,
    media:media ? {time:media.currentTime, playing:!media.paused, muted:media.muted, volume:media.volume, rate:media.playbackRate, clipEnd} : null,
    activeScan:['running','queued'].includes(status?.job?.state),
  };
}
async function restoreRecoveryState(state) {
  if (!state) return;
  await refresh();
  $('query').value = state.query; mode = state.mode;
  for (const [id, value] of Object.entries(state.filters)) $(id).value = value;
  $('accuracy').value = state.accuracy;
  browserType = state.browserType; browserFolder = state.browserFolder; favouriteOnly = state.favouriteOnly;
  browserSort = state.browserSort; browserDescending = state.browserDescending; sidebar(state.sidebarCollapsed);
  for (const button of document.querySelectorAll('.mode-tabs button')) button.classList.toggle('active', button.dataset.mode === mode);
  for (const button of document.querySelectorAll('[data-type]')) button.classList.toggle('active', button.dataset.type === browserType);
  for (const header of document.querySelectorAll('[data-sort]')) {
    header.querySelector('span').textContent = header.dataset.sort === browserSort ? browserDescending ? '↓' : '↑' : '';
  }
  await search();
  if (!state.viewer) return;
  await openViewer(state.viewer);
  const media = $('viewer-body').querySelector('video,audio');
  if (!media || !state.media) return;
  media.pause();
  if (media.readyState < 1) await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); media.removeEventListener('loadedmetadata', finish); media.removeEventListener('error', finish); resolve(); };
    const timer = setTimeout(finish, 10000);
    media.addEventListener('loadedmetadata', finish); media.addEventListener('error', finish);
  });
  if (Number.isFinite(media.duration)) media.currentTime = Math.max(0, Math.min(media.duration - .001, state.media.time));
  media.volume = state.media.volume; media.playbackRate = state.media.rate; media.muted = state.media.muted; clipEnd = state.media.clipEnd;
  if (state.media.playing) media.play().catch(error => { $('viewer-notice').textContent = 'Playback paused after reconnect: ' + error.message; });
}
async function openViewer(file) {
  closeViewer(); viewerFile = file; const epoch = viewerEpoch; matchPosition = -1; clipEnd = null;
  $('viewer-title').textContent = file.name; $('viewer-path').textContent = 'Loading preview…'; $('viewer-notice').textContent = ''; $('viewer-match-count').textContent = '';
  $('viewer-text-toggle').hidden = true; $('video-matches').hidden = true;
  $('viewer-favourite').textContent = '☆'; $('viewer-dialog').showModal();
  try {
    const data = await api('preview', {id: file.id, query: $('query').value, mode, minimum_relevance: Number($('accuracy').value)});
    if (epoch !== viewerEpoch) return;
    viewerData = data; viewerFile = data;
    highlighted($('viewer-title'), data.name, data.name_matches || []); $('viewer-path').textContent = data.path + ' · ' + size(data.size) + ' · Added: ' + (data.indexed_at == null ? 'Unknown' : new Date(data.indexed_at * 1000).toLocaleString()) + ' · Analysed: ' + (data.analyzed_at == null ? 'Unknown' : new Date(data.analyzed_at * 1000).toLocaleString()); $('viewer-path').title = $('viewer-path').textContent;
    $('viewer-notice').textContent = data.warning + (data.truncated ? ' Text preview limited to 100,000 characters.' : '');
    $('viewer-match-count').textContent = data.matches.length + ' text matches' + (data.matches.some(m => m.type === 'semantic') ? ' / related passages' : '') + (data.sections.length ? ' · ' + data.sections.length + ' timed sections' : '');
    $('previous-match').disabled = $('next-match').disabled = !data.matches.length;
    if (['video', 'audio'].includes(data.kind)) mediaPreview(data);
    else if (data.kind === 'image') { const image = element('img', 'viewer-image'); image.alt = data.name; image.src = data.media_url; image.onerror = () => { $('viewer-notice').textContent = 'Image format unsupported in this browser. Use Open in system app.'; }; $('viewer-body').replaceChildren(image); }
    else if (data.pdf) {
      $('viewer-text-toggle').hidden = false; $('viewer-text-toggle').textContent = 'Extracted text';
      $('viewer-text-toggle').onclick = () => {
        const showText = $('viewer-text-toggle').textContent === 'Extracted text';
        pdfObserver?.disconnect(); pdfDocument?.loadingTask?.destroy().catch(() => {}); pdfDocument = null;
        $('viewer-text-toggle').textContent = showText ? 'Page layout' : 'Extracted text';
        showText ? textPreview(data) : pdfPreview(data, epoch).catch(error => { $('viewer-notice').textContent = error.message; });
      };
      await pdfPreview(data, epoch);
    } else textPreview(data);
  } catch (error) { if (epoch === viewerEpoch) $('viewer-notice').textContent = error.message; }
}
