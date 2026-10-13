"""Explicit recovery of failed media analysis from a verified identical file."""
import hashlib
from pathlib import Path
import time

from .locking import writer_lock
from .media import kind, caption_path

NATIVE_SEGMENTS = {'Audio content (embedding, not a transcript)', 'Audio / sampled video content (embedding, not a transcript)'}


def _verified_hash(row):
    path = Path(row['path'])
    if path.is_symlink() or not path.resolve().is_relative_to(Path(row['root']).resolve()):
        raise ValueError('Duplicate is outside its indexed source.')
    before = path.stat()
    if row['fingerprint'].split(':')[:3] != [str(before.st_mtime_ns), str(before.st_size), str(before.st_ctime_ns)]:
        raise ValueError('File changed since analysis; reindex before repairing duplicates.')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    after = path.stat()
    if (before.st_mtime_ns, before.st_ctime_ns, before.st_size, before.st_ino) != (after.st_mtime_ns, after.st_ctime_ns, after.st_size, after.st_ino):
        raise ValueError('File changed during duplicate verification.')
    return digest.digest()


def repair_duplicate(store, source_id, target_id):
    if source_id == target_id:
        raise ValueError('Select two different files.')
    with writer_lock(store.directory / 'writer.lock'):
        with store.connect() as db:
            source = db.execute('SELECT * FROM files WHERE id=?', (source_id,)).fetchone()
            target = db.execute('SELECT * FROM files WHERE id=?', (target_id,)).fetchone()
            if not source or not target:
                raise ValueError('Duplicate is not in the index.')
            if source['error'] or not target['error']:
                raise ValueError('Recovery requires a successful source and an incomplete target.')
            if not store.embedder.supports_media or store._meta(db, 'model') != store.embedder.identity:
                raise ValueError('Recovery requires the matching direct multimodal model.')
            if kind(source['path']) not in {'audio', 'video'} or kind(source['path']) != kind(target['path']):
                raise ValueError('Recovery supports identical audio/video files.')
            if source['fingerprint'].split(':')[3:] != target['fingerprint'].split(':')[3:]:
                raise ValueError('Analysis settings differ; reindex with matching settings.')
            if caption_path(source['path']) or caption_path(target['path']):
                raise ValueError('Captioned duplicates must be reanalysed independently.')
            rows = db.execute('SELECT v.part,v.text,v.embedding,s.start,s.end,s.text AS segment_text FROM vectors v JOIN media_segments s ON s.file_id=v.file_id AND s.part=v.part WHERE v.file_id=? ORDER BY v.part', (source_id,)).fetchall()
            if not rows or any(row['segment_text'] not in NATIVE_SEGMENTS for row in rows):
                raise ValueError('Source has no reusable direct media analysis.')
        if _verified_hash(source) != _verified_hash(target):
            raise ValueError('Files are not byte-identical; recovery refused.')
        for row in (source, target):
            current = Path(row['path']).stat()
            if row['fingerprint'].split(':')[:3] != [str(current.st_mtime_ns), str(current.st_size), str(current.st_ctime_ns)]:
                raise ValueError('Duplicate changed before commit; recovery refused.')
        # Hashes and model/settings agree. Reuse only content vectors, retaining
        # the target's own filename/text metadata and immutable first-added time.
        with store.connect() as db:
            old_parts = [row[0] for row in db.execute('SELECT part FROM media_segments WHERE file_id=?', (target_id,))]
            db.executemany('DELETE FROM vectors WHERE file_id=? AND part=?', [(target_id, part) for part in old_parts])
            db.execute('DELETE FROM media_segments WHERE file_id=?', (target_id,))
            next_part = db.execute('SELECT COALESCE(MAX(part),-1)+1 FROM vectors WHERE file_id=?', (target_id,)).fetchone()[0]
            for offset, row in enumerate(rows):
                part = next_part + offset
                db.execute('INSERT INTO vectors VALUES(?,?,?,?)', (target_id, part, row['text'], row['embedding']))
                db.execute('INSERT INTO media_segments VALUES(?,?,?,?,?)', (target_id, part, row['start'], row['end'], row['segment_text']))
            db.execute('UPDATE files SET error=NULL,analyzed_at=? WHERE id=?', (time.time(), target_id))
            store._bump(db)
        return {'repaired_id': target_id, 'verified_source_id': source_id, 'reused_segments': len(rows), 'verification': 'SHA-256 byte identity + matching model/settings'}
