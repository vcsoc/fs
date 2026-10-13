const fs = require('node:fs');
const path = require('node:path');
const STEPS = [.75, .85, 1, 1.1, 1.25, 1.5, 1.75, 2];
function zoomAction(input) {
  if (!['keyDown', 'rawKeyDown'].includes(input.type) || !(input.control || input.meta) || input.alt) return null;
  if (['+', '='].includes(input.key) || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.code === 'NumpadSubtract') return 'out';
  if (input.key === '0' || input.code === 'Numpad0') return 'reset';
  return null;
}
function nextScale(current, action) {
  if (action === 'reset') return 1;
  if (action === 'in') return STEPS.find(step => step > current + .001) || STEPS.at(-1);
  return [...STEPS].reverse().find(step => step < current - .001) || STEPS[0];
}
function attachTextZoom(contents, filename) {
  let scale = 1;
  try { const saved = JSON.parse(fs.readFileSync(filename, 'utf8')); if (STEPS.includes(saved.scale)) scale = saved.scale; } catch (_) { /* Defaults also cover missing or damaged settings. */ }
  const apply = () => {
    contents.setZoomFactor(1);
    return contents.executeJavaScript(`document.documentElement.style.setProperty('--text-scale', '${scale}'); document.documentElement.dataset.textScale = '${scale}';`).catch(() => {});
  };
  contents.on('did-finish-load', apply);
  const change = action => {
    scale = nextScale(scale, action);
    // CSS typography only: never change Chromium zoom or media dimensions.
    apply();
    try {
      fs.mkdirSync(path.dirname(filename), {recursive:true});
      fs.writeFileSync(filename + '.tmp', JSON.stringify({scale}), {mode:0o600});
      fs.renameSync(filename + '.tmp', filename);
    } catch (_) { /* Text resizing must work even when persistence is unavailable. */ }
  };
  contents.on('before-input-event', (event, input) => {
    const action = zoomAction(input);
    if (!action) return;
    event.preventDefault(); change(action);
  });
  return {change};
}
module.exports = {attachTextZoom, zoomAction, nextScale};
