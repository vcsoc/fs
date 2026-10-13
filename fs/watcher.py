"""Incremental, non-destructive location polling; no per-file background threads."""
from __future__ import annotations

import os
from pathlib import Path
import threading
import time

from .core import EXCLUDED, VIRTUAL_ROOTS


class LocationWatcher:
    def __init__(self, store, enqueue, interval=1, settle=5, revisit=30):
        self.store, self.enqueue = store, enqueue
        self.interval, self.settle, self.revisit = interval, settle, revisit
        self.stop_event = threading.Event()
        self.states = {}
        self.walks = {}
        self.pending = {}
        self.retry = {}
        self.thread = None
        self.cursor = 0

    def start(self):
        self.thread = threading.Thread(target=self._run, name='fs-location-watcher', daemon=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)

    def _files(self, root, scope):
        if scope == 'selected':
            with self.store.connect() as db:
                paths = [row[0] for row in db.execute('SELECT path FROM location_files WHERE root=?', (root,))]
            yield from (Path(path) for path in paths if 'vault' not in Path(path).parts and not Path(path).is_relative_to(self.store.directory.resolve()))
            return
        own = self.store.directory.resolve()
        def walk(directory):
            with os.scandir(directory) as entries:
                for entry in entries:
                    if self.stop_event.is_set():
                        return
                    path = Path(entry.path)
                    yield None  # Every directory entry consumes discovery capacity.
                    if entry.is_symlink() or entry.name in EXCLUDED or path == own or path in VIRTUAL_ROOTS:
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        yield from walk(path)
                    elif entry.is_file(follow_symlinks=False):
                        yield path
        yield from walk(root)

    def tick(self):
        now = time.monotonic()
        with self.store.connect() as db:
            roots = [dict(row) for row in db.execute('SELECT * FROM locations')]
        if roots:
            offset = self.cursor % len(roots)
            roots = roots[offset:] + roots[:offset]
            self.cursor += 1
        enabled = {row['root'] for row in roots if row['watch_enabled']}
        for root in list(self.walks):
            if root not in enabled:
                self.walks.pop(root)[0].close()
        self.pending = {path: item for path, item in self.pending.items() if item[0] in enabled}
        budget, deadline = 256, now + .015
        for row in roots:
            root = row['root']
            if 'vault' in Path(root).parts or Path(root).is_relative_to(self.store.directory.resolve()):
                self.states[root] = 'Protected location; not watched'
                continue
            if not row['watch_enabled']:
                self.states[root] = 'Paused'
                continue
            if self.store.sources.status(root, row['device'], row['volume']) != 'online':
                self.states[root] = 'Offline; waiting for location'
                if root in self.walks:
                    self.walks.pop(root)[0].close()
                continue
            if root not in self.walks:
                self.walks[root] = (self._files(root, row['scope']), 0)
            walker, next_visit = self.walks[root]
            if now < next_visit:
                continue
            candidates = []
            try:
                # Share discovery capacity fairly across all locations.
                quota = max(1, 256 // max(1, len(enabled)))
                while quota and budget and time.monotonic() < deadline:
                    path = next(walker)
                    quota -= 1; budget -= 1
                    if path is not None:
                        stat = path.stat()
                        candidates.append((str(path), stat.st_size, stat.st_mtime))
            except StopIteration:
                self.walks[root] = (self._files(root, row['scope']), now + self.revisit)
            except (OSError, RecursionError):
                self.walks.pop(root)[0].close()
                self.states[root] = 'Retrying inaccessible location'
                continue
            if candidates:
                with self.store.connect() as db:
                    query = 'SELECT path,size,modified FROM files WHERE path IN (' + ','.join('?' for _ in candidates) + ')'
                    known = {r['path']: (r['size'], r['modified']) for r in db.execute(query, [c[0] for c in candidates])}
                for path, size, modified in candidates:
                    stamp = (size, modified)
                    if known.get(path) == stamp:
                        self.pending.pop(path, None)
                    elif len(self.pending) < 1000:
                        previous = self.pending.get(path)
                        if not previous or previous[1] != stamp:
                            self.pending[path] = (root, stamp, now)
            self.states[root] = 'Watching selected files' if row['scope'] == 'selected' else 'Watching for new and changed files'
        ready = {}
        for path, (root, stamp, noticed) in list(self.pending.items()):
            if now - noticed < self.settle or now < self.retry.get(root, 0):
                continue
            try:
                stat = Path(path).stat()
            except OSError:
                self.pending.pop(path, None)
                continue
            current = (stat.st_size, stat.st_mtime)
            if current != stamp:
                self.pending[path] = (root, current, now)
                continue
            source = next((row for row in roots if row['root'] == root), None)
            if source is None or self.store.sources.status(root, source['device'], source['volume']) != 'online':
                continue
            ready.setdefault(root, []).append(path)
        for root, paths in ready.items():
            if self.enqueue(root, paths[:200]):
                for path in paths[:200]:
                    self.pending.pop(path, None)
                self.retry[root] = now + 60
                self.states[root] = 'New files queued for analysis and thumbnails'
            else:
                self.states[root] = 'Waiting for current scan or model setup'

    def _run(self):
        while not self.stop_event.wait(self.interval):
            try:
                self.tick()
            except Exception:
                # A disconnected mount must not kill watching other locations.
                self.stop_event.wait(self.revisit)
        for walker, _ in self.walks.values():
            walker.close()
