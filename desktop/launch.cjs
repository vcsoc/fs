const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function electronPath() {
  if (process.env.FS_ELECTRON_PATH) return process.env.FS_ELECTRON_PATH;
  const root = path.dirname(require.resolve('electron/package.json'));
  const marker = path.join(root, 'path.txt');
  if (fs.existsSync(marker)) {
    const executable = path.join(root, 'dist', fs.readFileSync(marker, 'utf8').trim());
    if (fs.existsSync(executable)) return executable;
  }
  // Reuse a supported distro runtime instead of downloading another copy.
  if (process.platform !== 'win32') {
    const seen = new Set();
    for (const folder of (process.env.PATH || '').split(path.delimiter)) {
      for (const name of ['electron', 'electron44', 'electron43']) {
        const candidate = path.join(folder, name);
        if (!fs.existsSync(candidate)) continue;
        const real = fs.realpathSync(candidate);
        if (real.includes('node_modules') || seen.has(real)) continue;
        seen.add(real);
        const version = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 3000 }).stdout || '';
        const major = Number(version.match(/v(\d+)\./)?.[1]);
        if (major >= 43) { console.log('Using system Electron: ' + candidate); return candidate; }
      }
    }
  }
  return require('electron');
}
const child = spawn(electronPath(), [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
