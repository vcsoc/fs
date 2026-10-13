const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fsDesktop', {
  pickDirectory: () => ipcRenderer.invoke('fs:pick-directory'),
  setTheme: theme => ipcRenderer.invoke('fs:theme', theme),
});
