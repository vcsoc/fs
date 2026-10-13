'use strict';
// Also handle renderer-delivered keyboard events (including DevTools input).
// Native main-process interception prevents those events reaching us twice.
window.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || !window.fsDesktop?.textZoom) return;
  const action = ['+', '='].includes(event.key) || event.code === 'NumpadAdd' ? 'in' : event.key === '-' || event.code === 'NumpadSubtract' ? 'out' : event.key === '0' || event.code === 'Numpad0' ? 'reset' : null;
  if (!action) return;
  event.preventDefault(); window.fsDesktop.textZoom(action);
}, {capture:true});
