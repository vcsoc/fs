from __future__ import annotations

import hashlib
import hmac
import mimetypes
import os
from pathlib import Path
import shutil
import subprocess
import threading
import tempfile
import time
import warnings

import numpy as np
import regex

from .core import extract
from .media import captions, kind


class Preview:
    def __init__(self, store, secret):
        self.store, self.secret = store, secret.encode()
        self.thumbnail_slots = threading.BoundedSemaphore(2)
        self.directory = store.directory / 'thumbnails'
        self.directory.mkdir(exist_ok=True)

    def file(self, fid):
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM files WHERE id=?', (int(fid),)).fetchone()
        if not row:
            raise ValueError('File is not in the index.')
        path = Path(row['path'])
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(Path(row['root']).resolve()):
            raise ValueError('File is unavailable or moved outside its indexed location.')
        return dict(row), path

    def url(self, fid, purpose='file'):
        expiry = int(time.time()) + 3600
        message = f'{fid}:{purpose}:{expiry}'
        signature = hmac.new(self.secret, message.encode(), hashlib.sha256).hexdigest()
        return f'/media/{fid}/{purpose}?expires={expiry}&signature={signature}'

    def verify(self, fid, purpose, expiry, signature):
        try:
            expiry = int(expiry)
        except (TypeError, ValueError):
            return False
        if not int(time.time()) <= expiry <= int(time.time()) + 3600:
            return False
        expected = hmac.new(self.secret, f'{fid}:{purpose}:{expiry}'.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature or '')

    def decorate(self, file):
        return {**file, 'kind': kind(file['name']), 'media_url': self.url(file['id']), 'thumbnail_url': self.url(file['id'], 'thumbnail')}

    @staticmethod
    def ranges(text, query, mode):
        if not query.strip():
            return []
        if len(query) > 1000:
            raise ValueError('Query is too long.')
        if mode == 'regex':
            expression = query
        else:
            terms = regex.findall(r'[\p{L}\p{N}_]+', query)
            if not terms:
                return []
            expression = '|'.join(regex.escape(term) for term in sorted(set(terms), key=len, reverse=True))
        try:
            pattern = regex.compile(expression, regex.IGNORECASE | regex.MULTILINE)
            result = []
            for match in pattern.finditer(text, timeout=0.08):
                if match.end() > match.start():
                    result.append({'start': match.start(), 'end': match.end(), 'type': 'literal'})
                if len(result) >= 2000:
                    break
            return result
        except (regex.error, TimeoutError) as exc:
            raise ValueError('Invalid or too expensive preview pattern.') from exc

    def get(self, fid, query='', mode='hybrid', minimum_relevance=0.75):
        if mode not in {'hybrid', 'semantic', 'text', 'filename', 'regex'}:
            raise ValueError('Unknown search mode.')
        minimum_relevance = float(minimum_relevance)
        if not 0 <= minimum_relevance <= 1:
            raise ValueError('Minimum similarity must be between 0 and 1.')
        row, path = self.file(fid)
        category = kind(path)
        # Never execute HTML, scripts, SVG, or office macros in the viewer.
        text = row['content']
        if category not in {'image', 'video', 'audio'}:
            text = extract(path, 20 * 1024 * 1024)
        timed = captions(path) if category in {'video', 'audio'} else []
        matches = self.ranges(text, query, mode) if mode != 'filename' else []
        sections = [{**cue, 'type': 'caption'} for cue in timed if self.ranges(cue['text'], query, mode)] if query.strip() and mode != 'filename' else []
        warning = ''
        if query.strip() and mode in {'semantic', 'hybrid'}:
            with self.store.connect() as db:
                identity = self.store._meta(db, 'model')
                vectors = db.execute('SELECT part,text,embedding FROM vectors WHERE file_id=?', (int(fid),)).fetchall()
                segments = {r['part']: dict(r) for r in db.execute('SELECT * FROM media_segments WHERE file_id=?', (int(fid),))}
            if vectors and identity == getattr(self.store.embedder, 'identity', self.store.embedder.model):
                try:
                    q = self.store.embedder.embed([query], query=True)[0]
                    scores = [(float(np.frombuffer(v['embedding'], dtype='<f4') @ q), v) for v in vectors]
                    best = max(score for score, _ in scores)
                    for score, vector in sorted(scores, key=lambda item: -item[0])[:20]:
                        if score < max(minimum_relevance, best - 0.04):
                            continue
                        if vector['part'] in segments:
                            segment = segments[vector['part']]
                            sections.append({'start': segment['start'], 'end': segment['end'], 'text': segment['text'], 'type': 'semantic', 'score': round(score, 3)})
                        elif (offset := text.find(vector['text'])) >= 0:
                            matches.append({'start': offset, 'end': offset + len(vector['text']), 'type': 'semantic', 'score': round(score, 3)})
                except (RuntimeError, ValueError) as exc:
                    warning = 'Semantic highlighting unavailable: ' + str(exc)
        sections.sort(key=lambda item: (item['start'], item['end']))
        unique = {}
        for section in sections:
            unique.setdefault((section['start'], section['end']), section)
        result = self.decorate({k: row[k] for k in ['id', 'name', 'path', 'size', 'modified', 'created', 'indexed_at', 'analyzed_at']})
        if not text and category not in {'image', 'video', 'audio'}:
            with path.open('rb') as stream:
                raw = stream.read(4096)
            text = '\n'.join(f'{offset:08x}  ' + ' '.join(f'{byte:02x}' for byte in raw[offset:offset + 16]) for offset in range(0, len(raw), 16))
            warning = 'No readable text: showing the first 4 KiB as hexadecimal.'
        if category in {'video', 'audio'} and not timed:
            with self.store.connect() as db:
                native_segments = db.execute('SELECT count(*) FROM media_segments WHERE file_id=? AND text IN (?,?)', (int(fid), 'Audio content (embedding, not a transcript)', 'Audio / sampled video content (embedding, not a transcript)')).fetchone()[0]
            warning = 'Direct multimodal embeddings support semantic matches in analysed audio / sampled video segments. No verbatim transcript or literal speech highlights are available without captions.' if native_segments else 'No media-content analysis is recorded yet. Rescan with the full direct 740m model for audio / sampled-frame semantic matches, or add a same-name .srt / .vtt file for caption text matches.'
        result.update(text=text, matches=matches, name_matches=self.ranges(row['name'], query, mode), sections=list(unique.values()), captions=timed, warning=warning,
                      truncated=len(text) >= 100_000, pdf=path.suffix.lower() == '.pdf')
        return result

    def favourites(self):
        with self.store.connect() as db:
            return [dict(row) for row in db.execute('SELECT f.path,f.kind,files.id FROM favourites f LEFT JOIN files ON files.path=f.path ORDER BY f.kind,f.path')]

    def favourite(self, action, ids=None, path=None):
        if action not in {'add', 'remove'}:
            raise ValueError('Unknown favourite action.')
        entries = []
        if ids is not None:
            if not isinstance(ids, list) or len(ids) > 200:
                raise ValueError('Select at most 200 files.')
            for fid in ids:
                row, _ = self.file(fid)
                entries.append((row['path'], 'file'))
        if path:
            if len(str(path)) > 4096:
                raise ValueError('Folder path is too long.')
            resolved = Path(path).expanduser().resolve()
            if action == 'add' and not resolved.is_dir():
                raise ValueError('Select an existing folder.')
            entries.append((str(resolved), 'folder'))
        with self.store.connect() as db:
            for entry, category in entries:
                if action == 'add':
                    db.execute('INSERT OR REPLACE INTO favourites VALUES(?,?)', (entry, category))
                else:
                    db.execute('DELETE FROM favourites WHERE path=?', (entry,))
        return self.favourites()

    def thumbnail(self, fid):
        row, path = self.file(fid)
        if kind(path) not in {'image', 'video'}:
            raise ValueError('No thumbnail for this file type.')
        stat = path.stat()
        key = hashlib.sha256(f'{path}:{stat.st_mtime_ns}:{stat.st_size}:thumb1'.encode()).hexdigest()
        target = self.directory / (key + '.jpg')
        if target.exists():
            return target
        if not self.thumbnail_slots.acquire(timeout=15):
            raise ValueError('Thumbnail generator busy.')
        with tempfile.NamedTemporaryFile(suffix='.jpg', dir=self.directory, delete=False) as partial:
            temporary = Path(partial.name)
        try:
            if kind(path) == 'image':
                from PIL import Image, ImageOps
                with warnings.catch_warnings():
                    warnings.simplefilter('error', Image.DecompressionBombWarning)
                    with Image.open(path) as image:
                        if image.width * image.height > 32_000_000:
                            raise ValueError('Image exceeds the thumbnail pixel budget.')
                        image.thumbnail((360, 240))
                        ImageOps.exif_transpose(image).convert('RGB').save(temporary, 'JPEG', quality=80)
            else:
                executable = shutil.which('ffmpeg')
                if not executable:
                    raise ValueError('Video poster unavailable: ffmpeg is not installed. Hover can still preview browser-supported videos.')
                flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
                subprocess.run([executable, '-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1', '-ss', '0.1', '-i', str(path), '-frames:v', '1', '-vf', 'scale=360:240:force_original_aspect_ratio=decrease', '-y', str(temporary)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12, check=True, creationflags=flags)
            os.replace(temporary, target)
            cached = list(self.directory.glob('*.jpg'))
            if len(cached) > 1000:
                try:
                    for old in sorted(cached, key=lambda item: item.stat().st_mtime)[:len(cached) - 1000]:
                        old.unlink(missing_ok=True)
                except OSError:
                    pass
            return target
        finally:
            temporary.unlink(missing_ok=True)
            self.thumbnail_slots.release()

    @staticmethod
    def content_type(path):
        category = kind(path)
        if category not in {'image', 'video', 'audio'} and Path(path).suffix.lower() != '.pdf':
            raise ValueError('This file cannot be served as active browser content.')
        return mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
