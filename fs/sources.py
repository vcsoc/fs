from __future__ import annotations

import re
import os
import subprocess
from urllib.parse import quote
from pathlib import Path
import threading
import time


def virtual_source(path):
    path = Path(path)
    if not any(path.is_relative_to(Path(root)) for root in ('/proc', '/sys', '/dev', '/run')):
        return False
    # GVFS and /run/media contain user-mounted network/removable volumes,
    # unlike the runtime sockets/process state elsewhere under /run.
    parts = path.parts
    if path.is_relative_to(Path('/run/media')) and len(parts) > 3:
        return False
    if len(parts) >= 6 and parts[1:3] == ('run', 'user') and parts[3].isdigit() and parts[4] == 'gvfs':
        return False
    return True


def volume_identity(root):
    try:
        entries = Path('/proc/self/mountinfo').read_text().splitlines()
    except OSError:
        return None
    selected = None
    for line in entries:
        left, separator, right = line.partition(' - ')
        fields, mount = left.split(), right.split()
        if not separator or len(fields) < 5 or len(mount) < 2:
            continue
        point = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        if Path(root).is_relative_to(Path(point)) and (selected is None or len(point) > selected[0]):
            selected = (len(point), point + '|' + mount[0] + '|' + mount[1])
    return selected[1] if selected else None


def external_env():
    env = os.environ.copy()
    # Frozen Python's library path must not leak into desktop system programs.
    original = env.pop('LD_LIBRARY_PATH_ORIG', None)
    env.pop('LD_LIBRARY_PATH', None)
    if original is not None:
        env['LD_LIBRARY_PATH'] = original
    return env


def file_manager_target(root):
    parts = Path(root).parts
    if len(parts) >= 6 and parts[1:3] == ('run', 'user') and parts[4] == 'gvfs' and parts[5].startswith('smb-share:'):
        options = dict(item.split('=', 1) for item in parts[5][10:].split(',') if '=' in item)
        if options.get('server') and options.get('share'):
            return 'smb://' + quote(options['server'], safe='[]:') + '/' + '/'.join(quote(part, safe='') for part in [options['share'], *parts[6:]])
    return str(root)


_bridge_lock = threading.Lock()
_bridge_checked = 0.0


def ensure_gvfs_bridge(root):
    global _bridge_checked
    if not hasattr(os, 'getuid'):
        return
    base = Path('/run/user') / str(os.getuid()) / 'gvfs'
    if not Path(root).is_relative_to(base) or not base.is_dir() or base.is_symlink() or base.is_mount():
        return
    with _bridge_lock:
        if _bridge_checked and time.monotonic() - _bridge_checked < 60:
            return
        _bridge_checked = time.monotonic()
        for binary in ('/usr/lib/gvfsd-fuse', '/usr/lib/gvfs/gvfsd-fuse', '/usr/libexec/gvfsd-fuse'):
            if Path(binary).is_file():
                try:
                    subprocess.run([binary, str(base)], env=external_env(), timeout=3, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                except (OSError, subprocess.TimeoutExpired):
                    pass
                break


class SourceMonitor:
    """Bounded background probes keep slow network stat calls off the HTTP thread."""
    def __init__(self):
        self.lock = threading.Lock()
        self.states = {}
        self.slots = threading.BoundedSemaphore(4)

    def status(self, root, expected_device=None, expected_volume=None, force=False):
        with self.lock:
            state = self.states.get(root)
            if state and (state['pending'] or (not force and time.monotonic() - state['checked'] < 15)):
                return state['status']
            if not self.slots.acquire(blocking=False):
                return state['status'] if state else 'checking'
            self.states[root] = {'pending': True, 'checked': time.monotonic(), 'status': state['status'] if state and not force else 'checking'}
        def probe():
            try:
                ensure_gvfs_bridge(root)
                path = Path(root)
                online = path.is_dir()
                # Reachability is separate from identity; indexing still guards
                # against replacement volumes before modifying cached records.
                value = 'online' if online else 'offline'
            except OSError:
                value = 'offline'
            finally:
                self.slots.release()
            with self.lock:
                self.states[root] = {'pending': False, 'checked': time.monotonic(), 'status': value}
        threading.Thread(target=probe, daemon=True).start()
        return 'checking' if state is None or force else state['status']

    def invalidate(self, root):
        with self.lock:
            self.states.pop(root, None)
