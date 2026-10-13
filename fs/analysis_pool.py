"""Bounded file analysis; the coordinator alone updates SQLite and progress."""
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from queue import Empty, Full, Queue
import time

import numpy as np

from .media import caption_fingerprint, kind, passages, captions


def analyse_file(path, prefs, embedder, semantic, existing, embedded, cancel, notify):
    from .core import chunks, extract
    started = time.monotonic()
    result = {'errors': 0}
    try:
        if cancel.is_set():
            return result
        stat = path.stat()
        caption_stamp = caption_fingerprint(path)
        fingerprint = f"{stat.st_mtime_ns}:{stat.st_size}:{stat.st_ctime_ns}:{prefs['max_file_mb']}:{prefs['max_chunks']}:timestamps-v1:multimodal-v1:timed-cues-v1" + caption_stamp
        if kind(path) == 'image':
            fingerprint += ':oriented-images-v2'
        old = existing.get(str(path))
        if old and old['fingerprint'] == fingerprint and not old['error'] and (not semantic or old['id'] in embedded):
            result['unchanged'] = True
            return result
        error = None
        try:
            content = extract(path, prefs['max_file_mb'] * 1024 * 1024)
        except MemoryError:
            raise
        except Exception as exc:
            content, error = '', str(exc)[:400]
            result['errors'] += 1
        media_enabled = semantic and getattr(embedder, 'supports_media', False) and (kind(path) in {'image', 'audio', 'video'} or path.suffix.lower() == '.pdf')
        if prefs['max_file_mb'] and stat.st_size > prefs['max_file_mb'] * 1024 * 1024 and kind(path) not in {'audio', 'video'}:
            media_enabled = False
        media_budget = max(1, prefs['max_chunks'] // 2) if media_enabled else 0
        text_budget = prefs['max_chunks'] - media_budget
        segments = passages(path, text_budget) if kind(path) in {'video', 'audio'} and text_budget else []
        parts = ([segment['text'] for segment in segments] or chunks(content, text_budget) or [path.name]) if text_budget else []
        # Keep exact caption cues independently of grouped embedding passages.
        # Negative part IDs are metadata-only and cannot alias vector parts.
        if kind(path) in {'video', 'audio'}:
            segments.extend({**cue, 'part': -index - 1} for index, cue in enumerate(captions(path)))
        vectors = None
        if semantic:
            rows = []
            for i in range(0, len(parts), 8):
                if cancel.is_set():
                    return result
                rows.append(embedder.embed([f'title: {path.name} | text: {part}' for part in parts[i:i + 8]]))
            if media_enabled:
                try:
                    from .media_analysis import inputs
                    for item in inputs(path, prefs['max_chunks'] - len(parts), cancel, prefs['cpu_threads']):
                        notify(str(path) + ' - ' + item['description'])
                        row = embedder.embed_media(**{key: item[key] for key in ['images', 'audio', 'video'] if key in item})
                        part = len(parts)
                        parts.append(item['description'])
                        rows.append(row)
                        if item['timed']:
                            segments.append({'part': part, 'start': item['start'], 'end': item['end'], 'text': item['description']})
                except MemoryError:
                    raise
                except Exception as exc:
                    error = 'Media analysis failed: ' + str(exc)[:350]
                    result['errors'] += 1
            if cancel.is_set():
                return result
            if not rows:
                parts = [path.name]
                rows = [embedder.embed([f'title: {path.name} | text: {path.name}'])]
            vectors = np.concatenate(rows)
        if not cancel.is_set():
            result['record'] = (stat, caption_stamp, fingerprint, content, error, segments, parts, vectors)
        return result
    except OSError:
        result['errors'] += 1
        return result
    finally:
        # Each slot sleeps independently; total useful CPU remains bounded by
        # the divided thread budget and the process-tree OS quota where available.
        duty = prefs['scan_duty_percent'] / 100
        if duty < 1:
            cancel.wait((time.monotonic() - started) * (1 / duty - 1))


def run_files(paths, analyse, workers, cancel, submitted, report):
    messages = Queue(maxsize=max(1, workers * 2))
    def notify(path):
        try:
            messages.put_nowait(path)
        except Full:
            # Progress is advisory; never block cancellation on a full queue.
            pass
    paths = iter(paths)
    exhausted = False
    pending = {}
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix='fs-analysis')
    try:
        while pending or not exhausted:
            while not exhausted and not cancel.is_set() and len(pending) < workers:
                try:
                    path = next(paths)
                except StopIteration:
                    exhausted = True
                    break
                submitted(path)
                pending[pool.submit(analyse, path, notify)] = path
            if cancel.is_set():
                break
            if not pending:
                continue
            done, _ = wait(pending, timeout=.1, return_when=FIRST_COMPLETED)
            while True:
                try:
                    report(messages.get_nowait())
                except Empty:
                    break
            for future in done:
                path = pending.pop(future)
                yield path, future.result()
    finally:
        if pending:
            cancel.set()
        pool.shutdown(wait=True, cancel_futures=True)
        close = getattr(paths, 'close', None)
        if close:
            close()
