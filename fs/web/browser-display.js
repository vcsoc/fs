'use strict';
const columnDefaults = {name:180, path:220, score:95, size:70, modified:105, created:105, indexed_at:105, analyzed_at:105};
let columnWidths = {};
let displayRevision = 0, displayPending = 0, columnResizeActive = false;
let displaySaveChain = Promise.resolve();
function saveBrowserDisplay(values) {
  displayRevision++; displayPending++;
  displaySaveChain = displaySaveChain.then(() => api('preferences', values))
    .catch(report).finally(() => { displayPending--; });
}
function applyColumnWidths() {
  for (const key of Object.keys(columnDefaults)) {
    const width = columnWidths[key];
    if (width) document.body.style.setProperty('--col-' + key, width + 'px');
    else document.body.style.removeProperty('--col-' + key);
    const handle = document.querySelector('.column-resize-handle[data-column="' + key + '"]');
    if (handle) handle.setAttribute('aria-valuenow', String(width || Math.max(60, Math.round(handle.parentElement.getBoundingClientRect().width))));
  }
  const minimum = Object.entries(columnDefaults).reduce((sum, [key, value]) => sum + (columnWidths[key] || value), 18 + (thumbnailsShown ? 30 : 0) + 110);
  document.body.style.setProperty('--columns-min-width', Math.max(1240, minimum) + 'px');
}
function showThumbnails(show) {
  const changed = thumbnailsShown !== show;
  thumbnailsShown = show;
  document.body.classList.toggle('thumbnails-hidden', !show);
  const button = $('toggle-thumbnails');
  button.setAttribute('aria-pressed', String(show));
  button.title = show ? 'Hide thumbnails' : 'Show thumbnails and restore the selected layout';
  button.setAttribute('aria-label', show ? 'Hide thumbnails' : 'Show thumbnails');
  if (changed) {
    pauseHover(); hideGalleryDetails();
    const files = new Map(browserResults.map(file => [String(file.id), file]));
    for (const card of $('results').children) {
      const file = files.get(card.dataset.id), old = card.querySelector('.file-thumbnail');
      if (!file || !old) continue;
      const preview = thumbnail(file); old.replaceWith(preview); observeGalleryCard(card, preview, file);
    }
    setLayout(resultLayout);
  }
  applyColumnWidths();
}
function applyBrowserDisplay(prefs, revision, pending) {
  if (pending || displayPending || columnResizeActive || revision !== displayRevision) return;
  columnWidths = Object.fromEntries(Object.entries(prefs.column_widths || {}).filter(([key, value]) => Object.hasOwn(columnDefaults, key) && Number.isInteger(value) && value >= 60 && value <= 1500));
  showThumbnails(prefs.show_thumbnails !== false);
}
$('toggle-thumbnails').onclick = () => {
  showThumbnails(!thumbnailsShown); saveBrowserDisplay({show_thumbnails:thumbnailsShown});
};
for (const button of document.querySelectorAll('.list-column-head [data-sort]')) {
  const key = button.dataset.sort;
  if (!Object.hasOwn(columnDefaults, key)) continue;
  const handle = element('span', 'column-resize-handle');
  handle.dataset.column = key; handle.tabIndex = 0;
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize ' + button.textContent.trim() + ' column');
  handle.setAttribute('aria-valuemin', '60'); handle.setAttribute('aria-valuemax', '1500');
  handle.title = 'Drag to resize. Arrow keys adjust width; double-click or Home resets it.';
  handle.onclick = event => event.stopPropagation();
  const update = width => { columnWidths[key] = Math.max(60, Math.min(1500, Math.round(width))); applyColumnWidths(); };
  const save = () => saveBrowserDisplay({column_widths:{...columnWidths}});
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const startX = event.clientX, startWidth = button.getBoundingClientRect().width;
    displayRevision++; columnResizeActive = true;
    document.body.classList.add('column-resizing'); handle.setPointerCapture(event.pointerId);
    handle.onpointermove = move => update(startWidth + move.clientX - startX);
    const finish = () => {
      if (!columnResizeActive) return;
      columnResizeActive = false; document.body.classList.remove('column-resizing');
      handle.onpointermove = null; handle.onpointerup = null; handle.onpointercancel = null; handle.onlostpointercapture = null;
      save();
    };
    handle.onpointerup = finish; handle.onpointercancel = finish; handle.onlostpointercapture = finish;
  };
  handle.ondblclick = event => { event.preventDefault(); event.stopPropagation(); delete columnWidths[key]; applyColumnWidths(); save(); };
  handle.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Home') delete columnWidths[key];
    else if (event.key.startsWith('Arrow')) update((columnWidths[key] || button.getBoundingClientRect().width) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 50 : 10));
    else return;
    applyColumnWidths(); save();
  };
  button.append(handle);
}
applyColumnWidths();
