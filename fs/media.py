from __future__ import annotations

import html
import re
from pathlib import Path

VIDEO = set('mp4 m4v mov webm mkv avi mpg mpeg m2ts 3gp ogv'.split())
AUDIO = set('mp3 wav ogg flac m4a aac opus'.split())
IMAGE = set('jpg jpeg png gif webp bmp avif tif tiff'.split())
DOCUMENT = set('pdf docx doc odt rtf txt md rst csv tsv'.split())
CODE = set('py js jsx ts tsx rs go c cpp h java html css json yaml yml toml sh sql'.split())


def kind(path):
    extension = Path(path).suffix.lower().lstrip('.')
    for label, values in [('video', VIDEO), ('audio', AUDIO), ('image', IMAGE), ('document', DOCUMENT), ('code', CODE)]:
        if extension in values:
            return label
    return 'other'


def caption_path(path):
    path = Path(path)
    for suffix in ['.vtt', '.srt']:
        candidate = path.with_suffix(suffix)
        if candidate.is_file() and not candidate.is_symlink():
            return candidate
    return None


def caption_fingerprint(path):
    candidate = caption_path(path) if kind(path) in {'video', 'audio'} else None
    if candidate:
        stat = candidate.stat()
        return f':captions2:{stat.st_mtime_ns}:{stat.st_size}:{stat.st_ctime_ns}'
    return ':captions2' if kind(path) in {'video', 'audio'} else ''


def seconds(value):
    parts = value.replace(',', '.').split(':')
    return sum(float(part) * 60 ** position for position, part in enumerate(reversed(parts)))


def captions(path):
    candidate = caption_path(path)
    if not candidate or candidate.stat().st_size > 4 * 1024 * 1024:
        return []
    text = candidate.read_bytes().decode('utf-8-sig', errors='replace')
    stamp = r'(?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3}'
    cues = []
    for block in re.split(r'\r?\n\s*\r?\n', text):
        match = re.search(rf'({stamp})\s*-->\s*({stamp})[^\r\n]*[\r\n]+([\s\S]+)', block)
        if not match:
            continue
        start, end = seconds(match[1]), seconds(match[2])
        body = html.unescape(re.sub(r'<[^>]*>', '', match[3])).strip()
        if body and 0 <= start < end and len(body) <= 8000:
            cues.append({'start': start, 'end': end, 'text': body})
        if len(cues) >= 5000:
            break
    return sorted(cues, key=lambda cue: (cue['start'], cue['end']))


def passages(path, maximum=64):
    groups = []
    for cue in captions(path):
        if groups and cue['start'] - groups[-1]['end'] < 5 and cue['end'] - groups[-1]['start'] <= 30 and len(groups[-1]['text']) + len(cue['text']) < 1400:
            groups[-1]['end'] = max(groups[-1]['end'], cue['end'])
            groups[-1]['text'] += '\n' + cue['text']
        else:
            groups.append(dict(cue))
    return groups[:maximum]
