const {execFile} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
function fileUris(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 200 || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p) || /[\r\n\0]/.test(p))) throw new Error('Select between 1 and 200 original files.');
  return paths.map(p => pathToFileURL(p).href).join('\r\n') + '\r\n';
}
function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {timeout:5000, maxBuffer:16384, windowsHide:true}, error => error ? reject(error) : resolve());
    child.stdin.on('error', () => {}); child.stdin.end(input || '');
  });
}
async function copyFiles(paths, clipboard) {
  const uris = fileUris(paths);
  if (paths.some(p => !fs.lstatSync(p).isFile())) throw new Error('An original file is missing or no longer a regular file.');
  if (process.platform === 'linux') {
    if (process.env.WAYLAND_DISPLAY) {
      // Chromium descriptors can survive a spawn. Close them before wl-copy
      // forks its clipboard owner, or it can keep browser/service sockets alive.
      const script = 'for p in /proc/$$/fd/*; do n=${p##*/}; case "$n" in 0|1|2) ;; *) eval "exec $n>&-" 2>/dev/null ;; esac; done; exec wl-copy --type text/uri-list';
      await run('/bin/sh', ['-c', script], uris);
    }
    else clipboard.writeBuffer('text/uri-list', Buffer.from(uris));
  } else if (process.platform === 'darwin') {
    const script = `ObjC.import('AppKit');const pb=$.NSPasteboard.generalPasteboard;pb.clearContents;const paths=${JSON.stringify(paths)};pb.writeObjects($(paths.map(p=>$.NSURL.fileURLWithPath($(p)))));`;
    await run('/usr/bin/osascript', ['-l', 'JavaScript'], script + '\n');
  } else if (process.platform === 'win32') {
    const encoded = Buffer.from(JSON.stringify(paths)).toString('base64');
    const script = `Add-Type -AssemblyName System.Windows.Forms;$list=New-Object System.Collections.Specialized.StringCollection;$paths=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')));foreach($p in $paths){[void]$list.Add($p)};[System.Windows.Forms.Clipboard]::SetFileDropList($list)`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', '-'], script + '\n');
  } else throw new Error('Native file clipboard is unavailable on this platform.');
  return {copied:paths.length};
}
module.exports = {fileUris, copyFiles};
