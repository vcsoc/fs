const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ServiceSupervisor } = require('./service-supervisor.cjs');

nativeTheme.themeSource = 'dark';
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) app.commandLine.appendSwitch('ozone-platform', process.env.FS_OZONE_PLATFORM || 'wayland');

let supervisor, window, backendUrl, recoveryPromise, pendingFailure;
let quitting = false, recoveryState = null;
const restartTimes = [];

function logService(record) {
  try {
    const directory = path.join(process.env.FS_DATA_DIR || app.getPath('userData'), 'logs');
    fs.mkdirSync(directory, {recursive:true, mode:0o700});
    const file = path.join(directory, 'search-service.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) {
      fs.copyFileSync(file, file + '.previous'); fs.truncateSync(file, 0);
    }
    const safe = {...record, stderr:record.stderr?.replace(/https?:\/\/\S+/g, '[URL redacted]')};
    fs.appendFileSync(file, JSON.stringify({time:new Date().toISOString(), ...safe}) + '\n', {mode:0o600});
  } catch (_) { /* Failure to write diagnostics must not stop local search. */ }
}
function notifyService(message, failed = false) {
  if (!window || window.isDestroyed()) return;
  window.webContents.executeJavaScript(`typeof showServiceRecovery === 'function' && showServiceRecovery(${JSON.stringify(message)}, ${failed})`).catch(() => {});
}
async function recoverService() {
  if (quitting || !window || window.isDestroyed()) return;
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    notifyService('Local search disconnected. Reconnecting…');
    try {
      recoveryState = await window.webContents.executeJavaScript("typeof captureRecoveryState === 'function' ? captureRecoveryState() : null") || recoveryState;
    } catch (_) { /* Keep an earlier snapshot if the renderer is unavailable. */ }
    while (!quitting && window && !window.isDestroyed()) {
      const cutoff = Date.now() - 5 * 60 * 1000;
      while (restartTimes.length && restartTimes[0] < cutoff) restartTimes.shift();
      if (restartTimes.length >= 3) {
        notifyService('Local search could not stay connected. Diagnostic details were saved. Retry when ready; your window stays open.', true);
        logService({event:'restart-limit'}); return;
      }
      restartTimes.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, 500 * restartTimes.length));
      if (quitting || window.isDestroyed()) return;
      try {
        backendUrl = await supervisor.start();
        if (quitting || window.isDestroyed()) return;
        await window.loadURL(backendUrl);
        await window.webContents.executeJavaScript(`restoreRecoveryState(${JSON.stringify(recoveryState)})`);
        if (supervisor.process.exitCode !== null || supervisor.process.signalCode !== null) throw new Error('Search service exited during reconnection.');
        notifyService(recoveryState?.activeScan ? 'Local search reconnected. The interrupted scan needs to be restarted.' : 'Local search reconnected. Your view was restored.');
        recoveryState = null; logService({event:'reconnected'}); return;
      } catch (error) {
        logService({event:'restart-failed', message:error.message});
        await supervisor.terminateCurrent();
      }
    }
  })().finally(() => { recoveryPromise = null; });
  return recoveryPromise;
}
function createSupervisor() {
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  const venv = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const service = path.join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'fs-service.exe' : 'fs-service');
  const command = app.isPackaged ? service : process.env.FS_PYTHON || (fs.existsSync(venv) ? venv : (process.platform === 'win32' ? 'python' : 'python3'));
  const args = [...(app.isPackaged ? [] : ['-m', 'fs']), '--ollama-url', process.env.FS_OLLAMA_URL || 'http://127.0.0.1:11434'];
  if (process.env.FS_MODEL) args.push('--model', process.env.FS_MODEL);
  if (process.env.FS_DATA_DIR) args.push('--data-dir', process.env.FS_DATA_DIR);
  args.push('serve');
  return new ServiceSupervisor({command, args, options:{cwd:root, env:{...process.env, PYTHONPATH:root}, stdio:['ignore', 'pipe', 'pipe']}, log:logService,
    onExit:record => {
      if (quitting) return;
      if (!window) pendingFailure = record;
      else recoverService().catch(error => logService({event:'recovery-error', message:error.message}));
    },
  });
}

app.whenReady().then(async () => {
  try {
    supervisor = createSupervisor(); backendUrl = await supervisor.start();
    window = new BrowserWindow({
      width:1320, height:880, minWidth:760, minHeight:600,
      title:'fs — Find what matters', backgroundColor:'#1e1e1e', icon:path.join(__dirname, 'icon.png'),
      webPreferences:{preload:path.join(__dirname, 'preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true},
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(({url}) => {
      if (url === 'https://github.com/vcsoc/fs') shell.openExternal(url);
      return {action:'deny'};
    });
    window.webContents.on('will-navigate', (event, url) => { if (url !== backendUrl + '/') event.preventDefault(); });
    ipcMain.handle('fs:theme', (event, theme) => {
      if (event.sender === window.webContents && ['dark', 'light'].includes(theme)) nativeTheme.themeSource = theme;
    });
    ipcMain.handle('fs:pick-directory', async event => {
      if (event.sender !== window.webContents || !event.senderFrame.url.startsWith(backendUrl + '/')) return null;
      const result = await dialog.showOpenDialog(window, {properties:['openDirectory'], title:'Select a drive or folder to index'});
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('fs:retry-service', event => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== window.webContents.getURL()) return;
      if (recoveryPromise || (supervisor.process && supervisor.process.exitCode === null && supervisor.process.signalCode === null)) return;
      restartTimes.length = 0;
      return recoverService();
    });
    if (pendingFailure) await recoverService(); else await window.loadURL(backendUrl);
  } catch (error) {
    if (!quitting) dialog.showErrorBox('Could not start fs', error.message);
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; supervisor?.stop(); });
