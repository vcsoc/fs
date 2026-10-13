import numpy as np
import pytest

from fs.core import Store
from fs.duplicates import repair_duplicate, NATIVE_SEGMENTS


class Embedder:
    model = identity = 'timed-test'
    supports_media = True
    def embed(self, texts, query=False):
        result = np.zeros((len(texts), 768), dtype=np.float32)
        result[:, 0] = 1
        return result


def test_search_exposes_multiple_real_intervals_not_filename_matches(tmp_path):
    root = tmp_path / 'files'; root.mkdir()
    (root / 'movie.mp4').write_bytes(b'fixture')
    (root / 'movie.srt').write_text('1\n00:00:03,000 --> 00:00:04,000\nsolar\n\n2\n00:00:05,000 --> 00:00:06,000\nsolar again\n')
    embedder = Embedder(); embedder.supports_media = False
    store = Store(tmp_path / 'db', embedder)
    store.save_preferences({'scan_duty_percent': 100})
    store.index(root)
    result = store.search('solar', mode='text')['results']
    video = next(file for file in result if file['name'] == 'movie.mp4')
    assert [(row['start'], row['end']) for row in video['matched_sections']] == [(3, 4), (5, 6)]
    assert store.search('movie.mp4', mode='filename')['results'][0]['matched_sections'] == []


def test_duplicate_recovery_reuses_content_only_and_preserves_first_added(tmp_path):
    root = tmp_path / 'files'; root.mkdir()
    (root / 'source.webm').write_bytes(b'identical media')
    (root / 'target.webm').write_bytes(b'identical media')
    store = Store(tmp_path / 'db', Embedder())
    store.save_preferences({'scan_duty_percent': 100})
    store.index(root, semantic=False)
    vector = np.zeros(768, dtype='<f4'); vector[0] = 1
    other = np.zeros(768, dtype='<f4'); other[1] = 1
    label = sorted(NATIVE_SEGMENTS)[0]
    with store.connect() as db:
        rows = {row['name']: dict(row) for row in db.execute('SELECT * FROM files')}
        source, target = rows['source.webm'], rows['target.webm']
        db.execute("INSERT OR REPLACE INTO meta VALUES('model',?)", (store.embedder.identity,))
        for row in (source, target):
            db.execute('INSERT INTO vectors VALUES(?,?,?,?)', (row['id'], 0, row['name'], vector.tobytes()))
            db.execute('INSERT INTO vectors VALUES(?,?,?,?)', (row['id'], 1, label, other.tobytes()))
            db.execute('INSERT INTO media_segments VALUES(?,?,?,?,?)', (row['id'], 1, 0, 30, label))
        db.execute('INSERT INTO vectors VALUES(?,?,?,?)', (source['id'], 2, label, vector.tobytes()))
        db.execute('INSERT INTO media_segments VALUES(?,?,?,?,?)', (source['id'], 2, 30, 60, label))
        db.execute('UPDATE files SET error=? WHERE id=?', ('out of memory', target['id']))
        store._bump(db)
    # Filename fallback must not masquerade as media-content evidence.
    before = store.search('unrelated title', mode='semantic', minimum_relevance=.5)['results']
    assert [file['id'] for file in before] == [source['id']]
    repair = repair_duplicate(store, source['id'], target['id'])
    assert repair['reused_segments'] == 2
    after = store.search('unrelated title', mode='semantic', minimum_relevance=.5)['results']
    assert len(after) == 2 and after[0]['relevance'] == after[1]['relevance'] == 100
    with store.connect() as db:
        fixed = db.execute('SELECT * FROM files WHERE id=?', (target['id'],)).fetchone()
        assert fixed['indexed_at'] == target['indexed_at'] and fixed['error'] is None
    with pytest.raises(ValueError, match='incomplete target'):
        repair_duplicate(store, source['id'], target['id'])
    # A newly indexed failed file with identical size but different bytes must
    # never receive another file's content embeddings.
    path = root / 'target.webm'; path.write_bytes(b'different media')
    stat = path.stat()
    fingerprint = ':'.join([str(stat.st_mtime_ns), str(stat.st_size), str(stat.st_ctime_ns), *target['fingerprint'].split(':')[3:]])
    with store.connect() as db:
        db.execute('UPDATE files SET error=?,fingerprint=? WHERE id=?', ('out of memory', fingerprint, target['id']))
    with pytest.raises(ValueError, match='not byte-identical'):
        repair_duplicate(store, source['id'], target['id'])
    with store.connect() as db:
        assert db.execute('SELECT error FROM files WHERE id=?', (target['id'],)).fetchone()[0] == 'out of memory'
