from __future__ import annotations

import json
from collections import deque
import secrets
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import re

from .core import Store
from .jobs import run_index
from .model_manager import ModelManager
from .preview import Preview


class Application:
    def __init__(self, store):
        self.store = store
        self.models = ModelManager(store)
        self.token = secrets.token_urlsafe(32)
        self.preview = Preview(store, self.token)
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.job = {"state": "idle"}
        self.queue = deque()
        self.busy = False
        self.batch_completed = 0
        self.batch_total = 0
        self.completed_jobs = deque(maxlen=20)

    def start_index(self, root, semantic, setup_choice=None):
        if root is not None:
            root = self.store.add_location(root)
        with self.lock:
            if len(self.queue) >= 100:
                raise ValueError('The indexing queue is full (100 locations).')
            if not self.busy:
                self.batch_completed = 0
                self.batch_total = 0
            self.batch_total += 1
            job_id = secrets.token_hex(12)
            self.store.apply_preferences()
            selected_model = self.store.embedder.model
            self.queue.append((root, semantic, setup_choice, job_id, selected_model))
            queued = self.busy
            if not self.busy:
                self._next_locked()
            result = {'queued': queued, 'position': len(self.queue)}
            if root is None:
                result['job_id'] = job_id
            return result

    def _next_locked(self):
        root, semantic, setup_choice, job_id, selected_model = self.queue.popleft()
        self.busy = True
        self.cancel.clear()
        self.job = {'id': job_id, 'kind': 'model' if root is None else 'index', 'model': selected_model, 'state': 'running', 'scanned': 0, 'updated': 0, 'path': root, 'root': root}
        threading.Thread(target=self._run_index, args=(root, semantic, setup_choice), daemon=True).start()

    def _run_index(self, root, semantic, setup_choice):
        def progress(state):
            with self.lock:
                self.job = {**self.job, **state, "phase": state.get("phase", "indexing"), "state": "running"}
        def run():
            try:
                if root is not None:
                    from .sources import ensure_gvfs_bridge
                    ensure_gvfs_bridge(root)
                if root is not None and not Path(root).is_dir():
                    with self.lock:
                        self.job = {**self.job, 'state': 'offline', 'message': 'Location saved offline. Connect or mount it, then refresh. Cached results are preserved.'}
                    return
                self.store.apply_preferences()
                if root is None and self.store.embedder.model != self.job['model']:
                    raise ValueError('Selected model changed while setup was queued. Retry setup for the new selection.')
                if semantic:
                    self.models.prepare(choice=setup_choice, progress=progress, cancel=self.cancel)
                result = run_index(self.store, root, semantic=semantic, progress=progress, cancel=self.cancel) if root is not None else {"scanned": 0, "updated": 0, "removed": 0, "errors": 0, "cancelled": self.cancel.is_set()}
                with self.lock:
                    self.job = {**self.job, **result, "state": "cancelled" if result["cancelled"] else "complete"}
            except Exception as exc:
                with self.lock:
                    self.job = {**self.job, "state": "cancelled" if self.cancel.is_set() else "error", "error": str(exc)}
            finally:
                with self.lock:
                    self.completed_jobs.append(dict(self.job))
                    self.batch_completed += 1
                    self.busy = False
                    if self.queue:
                        self._next_locked()
        run()


def serve(store: Store, port=0, browser=False):
    app = Application(store)
    web = Path(__file__).parent / "web"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, payload, content_type="application/json"):
            data = json.dumps(payload).encode() if content_type == "application/json" else payload
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            # Reject DNS rebinding as well as cross-origin browser access.
            host = f"127.0.0.1:{self.server.server_port}"
            if self.headers.get("Host") != host:
                return False
            origin = self.headers.get("Origin")
            if origin and origin != f"http://{host}":
                return False
            return self.headers.get("Authorization") == f"Bearer {app.token}"

        def do_GET(self):
            path = urlparse(self.path).path
            if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
                return self.reply(403, {"error": "Invalid host"})
            if path.startswith('/media/'):
                return self.media()
            if path.startswith("/api/"):
                if not self.authorized():
                    return self.reply(403, {"error": "Unauthorized"})
                if path == "/api/status":
                    with app.lock:
                        job = {**app.job, 'queued': [item[0] for item in app.queue], 'queued_jobs': [{'id': item[3], 'kind': 'model' if item[0] is None else 'index'} for item in app.queue], 'completed': list(app.completed_jobs), 'batch_completed': app.batch_completed, 'batch_total': app.batch_total}
                    return self.reply(200, {**store.status(), "job": job, "model_runtime": app.models.status()})
                if path == '/api/favourites':
                    return self.reply(200, app.preview.favourites())
                if path == "/api/model/status":
                    return self.reply(200, app.models.status(probe=True))
                return self.reply(404, {"error": "Not found"})
            assets = {"/": ("index.html", "text/html; charset=utf-8"), "/style.css": ("style.css", "text/css"), "/app.js": ("app.js", "text/javascript"), "/browser.js": ("browser.js", "text/javascript"), "/layouts.css": ("layouts.css", "text/css"), "/icon.svg": ("icon.svg", "image/svg+xml")}
            assets["/fonts/JetBrainsMono-Regular.ttf"] = ("fonts/JetBrainsMono-Regular.ttf", "font/ttf")
            for asset in ['pdf.mjs', 'pdf.worker.mjs']:
                assets['/vendor/' + asset] = ('vendor/' + asset, 'text/javascript')
            if path not in assets:
                return self.reply(404, {"error": "Not found"})
            filename, kind = assets[path]
            data = (web / filename).read_bytes()
            if filename == "index.html":
                data = data.replace(b"__FS_TOKEN__", app.token.encode())
            self.reply(200, data, kind)

        def media(self):
            parts = urlparse(self.path).path.split('/')
            query = parse_qs(urlparse(self.path).query)
            try:
                if len(parts) != 4 or parts[3] not in {'file', 'thumbnail'}:
                    raise ValueError('Invalid media URL.')
                fid, purpose = int(parts[2]), parts[3]
                if not app.preview.verify(fid, purpose, query.get('expires', [None])[0], query.get('signature', [''])[0]):
                    return self.reply(403, {'error': 'Media link expired or unauthorized.'})
                if purpose == 'thumbnail':
                    path = app.preview.thumbnail(fid)
                    content_type = 'image/jpeg'
                else:
                    _, path = app.preview.file(fid)
                    content_type = app.preview.content_type(path)
                with path.open('rb') as stream:
                    length = path.stat().st_size
                    start, end, code = 0, length - 1, 200
                    requested = self.headers.get('Range')
                    if requested:
                        match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
                        if not match or not any(match.groups()):
                            return self.range_error(length)
                        if match[1]:
                            start = int(match[1])
                            end = min(int(match[2]), end) if match[2] else end
                        else:
                            start = max(0, length - int(match[2]))
                        if start > end or start >= length:
                            return self.range_error(length)
                        code = 206
                    self.send_response(code)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Length', str(max(0, end - start + 1)))
                    self.send_header('Accept-Ranges', 'bytes')
                    self.send_header('Cache-Control', 'private, max-age=300')
                    self.send_header('X-Content-Type-Options', 'nosniff')
                    self.send_header('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'")
                    if code == 206:
                        self.send_header('Content-Range', f'bytes {start}-{end}/{length}')
                    self.end_headers()
                    stream.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        data = stream.read(min(256 * 1024, remaining))
                        if not data:
                            break
                        self.wfile.write(data)
                        remaining -= len(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (ValueError, OSError, subprocess.SubprocessError) as exc:
                self.reply(404, {'error': str(exc)})

        def range_error(self, length):
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{length}')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def do_POST(self):
            if not self.authorized():
                return self.reply(403, {"error": "Unauthorized"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16384:
                    raise ValueError("Invalid request size")
                body = json.loads(self.rfile.read(length))
                path = urlparse(self.path).path
                if path == "/api/search":
                    result = store.search(**body)
                    result['results'] = [app.preview.decorate(file) for file in result['results']]
                elif path == '/api/preview':
                    result = app.preview.get(body['id'], body.get('query', ''), body.get('mode', 'hybrid'), body.get('minimum_relevance', store.preferences()['accuracy']))
                elif path == '/api/favourites':
                    result = app.preview.favourite(body['action'], body.get('ids'), body.get('path'))
                elif path == '/api/source/open':
                    from .sources import external_env, file_manager_target
                    with store.connect() as db:
                        source = db.execute('SELECT root FROM locations WHERE root=?', (body['root'],)).fetchone()
                    if source is None:
                        raise ValueError('Unknown indexed location.')
                    target = file_manager_target(source['root'])
                    if sys.platform == 'win32':
                        import os
                        os.startfile(target)
                    else:
                        subprocess.Popen(['open' if sys.platform == 'darwin' else 'xdg-open', target], env=external_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    result = {'opened': True}
                elif path == '/api/source/check':
                    with store.connect() as db:
                        source = db.execute('SELECT root,device,volume FROM locations WHERE root=?', (body['root'],)).fetchone()
                    if source is None:
                        raise ValueError('Unknown indexed location.')
                    result = {'root': source['root'], 'availability': store.sources.status(source['root'], source['device'], source['volume'], force=True)}
                elif path == "/api/index":
                    result = {"started": True, **app.start_index(body["root"], body.get("semantic", True), body.get("setup_choice"))}
                elif path == "/api/model/setup":
                    result = {"started": True, **app.start_index(None, True, body.get("choice"))}
                elif path == "/api/preferences":
                    result = store.save_preferences(body)
                elif path == "/api/cancel":
                    with app.lock:
                        app.batch_total -= len(app.queue)
                        for item in app.queue:
                            app.completed_jobs.append({'id': item[3], 'kind': 'model' if item[0] is None else 'index', 'model': item[4], 'state': 'cancelled'})
                        app.queue.clear()
                        app.cancel.set()
                    result = {"cancelled": True}
                elif path == "/api/remove":
                    with app.lock:
                        if app.busy:
                            raise ValueError("Wait for indexing to finish.")
                    store.remove_root(body["root"])
                    result = {"removed": True}
                elif path == "/api/open":
                    with store.connect() as db:
                        row = db.execute("SELECT path FROM files WHERE id=?", (int(body["id"]),)).fetchone()
                    if not row or not Path(row[0]).is_file():
                        raise ValueError("File no longer exists.")
                    if sys.platform == "win32":
                        import os
                        os.startfile(row[0])
                    else:
                        from .sources import external_env
                        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", row[0]], env=external_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    result = {"opened": True}
                else:
                    return self.reply(404, {"error": "Not found"})
                self.reply(200, result)
            except (ValueError, TypeError, KeyError) as exc:
                self.reply(400, {"error": str(exc)})
            except Exception as exc:
                self.reply(500, {"error": str(exc)})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_port}"
    print(json.dumps({"url": url}), flush=True)
    if browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.cancel.set()
        server.server_close()
        app.models.close()
