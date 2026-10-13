const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

nativeTheme.themeSource = 'dark';
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) app.commandLine.appendSwitch('ozone-platform', process.env.FS_OZONE_PLATFORM || 'wayland');

let backend;
let window;
let backendUrl;

function startBackend() {
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  const venv = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const service = path.join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'fs-service.exe' : 'fs-service');
  const python = app.isPackaged ? service : process.env.FS_PYTHON || (fs.existsSync(venv) ? venv : (process.platform === 'win32' ? 'python' : 'python3'));
  const args = [...(app.isPackaged ? [] : ['-m', 'fs']), '--ollama-url', process.env.FS_OLLAMA_URL || 'http://127.0.0.1:11434'];
  if (process.env.FS_MODEL) args.push('--model', process.env.FS_MODEL);
  if (process.env.FS_DATA_DIR) args.push('--data-dir', process.env.FS_DATA_DIR);
  args.push('serve');
  return new Promise((resolve, reject) => {
    backend = spawn(python, args, { cwd: root, env: { ...process.env, PYTHONPATH: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let ready = false;
    const timer = setTimeout(() => { backend.kill(); reject(new Error('The local search service did not start in time.')); }, 30000);
    backend.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    backend.on('error', error => { clearTimeout(timer); reject(error); });
    backend.on('exit', code => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`Python service exited (${code}). ${errors}\nRun: uv sync --extra test`));
      else if (window && !window.isDestroyed()) {
        dialog.showErrorBox('Search service stopped', errors || 'Restart fs to reconnect to the local index.');
        window.close();
      }
    });
    backend.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n')[0];
      if (!output.includes('\n') || ready) return;
      try {
        const { url } = JSON.parse(line);
        if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('Invalid backend URL');
        ready = true;
        clearTimeout(timer);
        resolve(url);
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  });
}

app.whenReady().then(async () => {
  try {
    backendUrl = await startBackend();
    window = new BrowserWindow({
      width: 1320, height: 880, minWidth: 760, minHeight: 600,
      title: 'fs — Find what matters', backgroundColor: '#1e1e1e',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url === 'https://github.com/vcsoc/fs') shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== backendUrl + '/') event.preventDefault();
    });
    ipcMain.handle('fs:theme', (event, theme) => {
      if (event.sender === window.webContents && ['dark', 'light'].includes(theme)) nativeTheme.themeSource = theme;
    });
    ipcMain.handle('fs:pick-directory', async (event) => {
      if (event.sender !== window.webContents || !event.senderFrame.url.startsWith(backendUrl + '/')) return null;
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Select a drive or folder to index' });
      return result.canceled ? null : result.filePaths[0];
    });
    await window.loadURL(backendUrl);
  } catch (error) {
    dialog.showErrorBox('Could not start fs', error.message);
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (backend) backend.kill(); });
