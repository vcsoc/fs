'use strict';
async function copySelectedFiles() {
  if (!selectedFiles.size || !window.fsDesktop?.copyFiles) return;
  try {
    const result = await window.fsDesktop.copyFiles([...selectedFiles]);
    notice(result.copied + ' original files copied to the system clipboard. Paste into a file manager or another file-aware application.');
  } catch (error) { report(error); }
}
$('copy-selected').onclick = copySelectedFiles;
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selectedFiles.size && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !event.target.isContentEditable && !$('viewer-dialog').open && !getSelection()?.toString()) {
    event.preventDefault(); copySelectedFiles();
  }
});
let dropDepth = 0;
const fileDrag = event => [...(event.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', event => {
  if (!fileDrag(event)) return;
  event.preventDefault(); dropDepth++; document.body.classList.add('file-drop-active');
});
document.addEventListener('dragleave', () => {
  dropDepth = Math.max(0, dropDepth - 1);
  if (!dropDepth) document.body.classList.remove('file-drop-active');
});
document.addEventListener('dragover', event => {
  if (!fileDrag(event)) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', async event => {
  if (!fileDrag(event)) return;
  event.preventDefault(); dropDepth = 0; document.body.classList.remove('file-drop-active');
  try {
    if (!window.fsDesktop?.droppedPath) throw new Error('Native file drop requires the desktop application.');
    const paths = [...new Set([...event.dataTransfer.files].map(file => window.fsDesktop.droppedPath(file)))];
    if (!paths.length || paths.some(path => !path)) throw new Error('Drop original local files or folders, not browser downloads or virtual attachments.');
    const result = await api('import', {paths});
    notice('Queued ' + result.files + ' selected files only and ' + result.folders + ' complete folders. Originals are not moved.');
    await refresh();
  } catch (error) { report(error); }
});
window.addEventListener('blur', () => { dropDepth = 0; document.body.classList.remove('file-drop-active'); });
