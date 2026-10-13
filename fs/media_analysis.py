"""Bounded local media decoding for direct multimodal embeddings."""
from __future__ import annotations

import io
from pathlib import Path
import re
import shutil
import subprocess
import threading

import numpy as np
from PIL import Image

from .media import kind
from .sources import external_env

# PDFium is not thread-safe, even when documents differ. Inference happens
# outside this lock, so independent file-analysis slots can still overlap.
_pdfium_lock = threading.Lock()


def ffmpeg_binary():
    host = shutil.which('ffmpeg')
    if host:
        return host
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def probe(path, threads):
    command = [ffmpeg_binary(), '-nostdin', '-hide_banner', '-threads', str(threads),
               '-protocol_whitelist', 'file,pipe', '-probesize', '1048576', '-analyzeduration', '3000000',
               '-i', str(path), '-t', '0', '-f', 'null', '-']
    result = subprocess.run(command, env=external_env(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15, check=False)
    text = result.stderr.decode('utf-8', errors='replace')
    match = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', text)
    duration = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3]) if match else None
    return duration, bool(re.search(r'^\s+Stream .*Audio:', text, re.MULTILINE)), bool(re.search(r'^\s+Stream .*Video:', text, re.MULTILINE))


def pcm(path, start, threads):
    command = [ffmpeg_binary(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', str(threads),
               '-protocol_whitelist', 'file,pipe', '-ss', str(start), '-i', str(path), '-t', '30',
               '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']
    result = subprocess.run(command, env=external_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45, check=False)
    if result.returncode or len(result.stdout) > 480000 * 4:
        raise ValueError('Audio decoding failed: ' + result.stderr.decode('utf-8', errors='replace')[-300:])
    samples = np.frombuffer(result.stdout, dtype='<f4').copy()
    return samples if len(samples) >= 321 else None


def frame(path, start, threads):
    command = [ffmpeg_binary(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', str(threads),
               '-protocol_whitelist', 'file,pipe', '-ss', str(start), '-i', str(path), '-frames:v', '1',
               '-vf', 'scale=768:768:force_original_aspect_ratio=decrease', '-threads', str(threads),
               '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']
    result = subprocess.run(command, env=external_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
    if result.returncode:
        raise ValueError('Video frame decoding failed: ' + result.stderr.decode('utf-8', errors='replace')[-300:])
    if not result.stdout:
        return None
    if len(result.stdout) > 8 * 1024 * 1024:
        raise ValueError('Decoded video frame exceeds the image budget.')
    with Image.open(io.BytesIO(result.stdout)) as image:
        return image.convert('RGB')


def inputs(path, budget, cancel, threads=2):
    path = Path(path)
    category = kind(path)
    if budget <= 0:
        return
    if category == 'image':
        with Image.open(path) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError('Image exceeds the 40-million-pixel analysis budget.')
            yield {'images': [image], 'description': 'Image content', 'timed': False}
        return
    if path.suffix.lower() == '.pdf':
        import pypdfium2 as pdfium
        with _pdfium_lock:
            document = pdfium.PdfDocument(str(path))
            pages = min(len(document), budget)
        try:
            for number in range(pages):
                if cancel.is_set():
                    return
                with _pdfium_lock:
                    page = document[number]
                    try:
                        scale = min(2.0, 1200 / max(page.get_size()))
                        bitmap = page.render(scale=scale)
                        try:
                            image = bitmap.to_pil().copy()
                        finally:
                            bitmap.close()
                    finally:
                        page.close()
                yield {'images': [image], 'description': 'Visual content of PDF page ' + str(number + 1), 'timed': False}
        finally:
            with _pdfium_lock:
                document.close()
        return
    if category not in {'audio', 'video'}:
        return
    duration, has_audio, has_video = probe(path, threads)
    if not has_audio and not has_video:
        raise ValueError('No decodable audio or video stream.')
    for index in range(budget):
        if cancel.is_set():
            return
        start = index * 30.0
        if duration is not None and start >= duration:
            break
        end = min(duration, start + 30) if duration is not None else start + 30
        audio = pcm(path, start, threads) if has_audio else None
        images = []
        if has_video:
            for position in [start, start + 10, start + 20]:
                if position >= end:
                    continue
                image = frame(path, position, threads)
                if image is not None:
                    images.append(image)
        if audio is None and not images:
            break
        if duration is None and audio is not None:
            end = start + len(audio) / 16000
        yield {'images': images, 'audio': audio, 'video': has_video, 'start': start, 'end': end,
               'description': 'Audio / sampled video content (embedding, not a transcript)' if has_video else 'Audio content (embedding, not a transcript)', 'timed': True}
        if duration is None:
            break
