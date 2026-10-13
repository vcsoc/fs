const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('fsDesktop', {
  pickDirectory: () => ipcRenderer.invoke('fs:pick-directory'),
  setTheme: theme => ipcRenderer.invoke('fs:theme', theme),
  retryService: () => ipcRenderer.invoke('fs:retry-service'),
  droppedPath: file => webUtils.getPathForFile(file),
  dragFiles: ids => ipcRenderer.invoke('fs:drag-files', ids),
  copyFiles: ids => ipcRenderer.invoke('fs:copy-files', ids),
});
