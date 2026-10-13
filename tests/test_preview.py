import pytest

from fs.core import Store, extract
from fs.media import captions
from fs.preview import Preview


def test_caption_index_timestamps_and_incremental_updates(tmp_path):
    root = tmp_path / 'docs'
    root.mkdir()
    video = root / 'lesson.mp4'
    video.write_bytes(b'not a real video')
    subtitle = root / 'lesson.srt'
    subtitle.write_text('1\n00:00:01,250 --> 00:00:03,500\nSolar energy project\n\n2\n00:00:04,000 --> 00:00:06,000\nCooking soup\n')
    assert captions(video)[0]['start'] == 1.25
    assert 'Solar' in extract(video, max_bytes=1)
    store = Store(tmp_path / 'db')
    store.index(root, semantic=False)
    result = store.search('solar', mode='text', file_type='video')
    assert result['total'] == 1
    preview = Preview(store, 'secret')
    response = preview.get(result['results'][0]['id'], 'solar', 'text')
    assert response['sections'][0]['start'] == 1.25
    assert response['sections'][0]['end'] == 3.5
    assert response['sections'][0]['type'] == 'caption'
    subtitle.write_text('1\n00:00:02,000 --> 00:00:05,000\nLunar research\n')
    store.index(root, semantic=False)
    assert store.search('lunar', mode='text', file_type='video')['total'] == 1
    assert store.search('solar', mode='text', file_type='video')['total'] == 0


def test_highlights_are_all_occurrences_and_unicode_codepoints():
    result = Preview.ranges('😀 Solar then solar and SOLAR', 'solar', 'text')
    assert len(result) == 3
    assert result[0]['start'] == 2
    assert len(Preview.ranges('red 12, red 34', r'red \d+', 'regex')) == 2
    with pytest.raises(ValueError):
        Preview.ranges('text', '[', 'regex')


def test_favourites_persistence_and_folders(tmp_path):
    root = tmp_path / 'files'
    root.mkdir()
    (root / 'alpha.txt').write_text('hello')
    store = Store(tmp_path / 'db')
    store.index(root, semantic=False)
    fid = store.search()['results'][0]['id']
    preview = Preview(store, 'secret')
    preview.favourite('add', [fid])
    preview.favourite('add', path=str(root))
    reopened = Preview(Store(tmp_path / 'db'), 'another secret')
    assert len(reopened.favourites()) == 2
    assert reopened.store.search(favourites_only=True)['total'] == 1
    assert reopened.store.search(folder=str(root))['total'] == 1
    reopened.favourite('remove', path=str(root / 'alpha.txt'))
    assert reopened.store.search(favourites_only=True)['total'] == 0


def test_media_capabilities_and_symlink_escape(tmp_path):
    root = tmp_path / 'files'
    root.mkdir()
    file = root / 'photo.png'
    file.write_bytes(b'png')
    store = Store(tmp_path / 'db')
    store.index(root, semantic=False)
    preview = Preview(store, 'secret')
    fid = store.search()['results'][0]['id']
    from urllib.parse import parse_qs, urlparse
    url = preview.url(fid)
    query = parse_qs(urlparse(url).query)
    assert preview.verify(fid, 'file', query['expires'][0], query['signature'][0])
    assert not preview.verify(fid + 1, 'file', query['expires'][0], query['signature'][0])
    assert not preview.verify(fid, 'thumbnail', query['expires'][0], query['signature'][0])
    outside = tmp_path / 'outside.png'
    outside.write_bytes(b'secret')
    file.unlink()
    file.symlink_to(outside)
    with pytest.raises(ValueError):
        preview.file(fid)


def test_sort_is_global_before_limit_and_unknown_dates_last(tmp_path):
    root = tmp_path / 'files'
    root.mkdir()
    for name, text in [('beta.txt', 'hello world'), ('alpha.txt', 'hello'), ('charlie.txt', 'hello longer text')]:
        (root / name).write_text(text)
    store = Store(tmp_path / 'db')
    store.index(root, semantic=False)
    assert store.search('hello', mode='text', sort_by='name', sort_desc=False, limit=1)['results'][0]['name'] == 'alpha.txt'
    assert store.search('hello', mode='text', sort_by='size', sort_desc=True, limit=1)['results'][0]['name'] == 'charlie.txt'
    result = store.search('hello', mode='text')['results'][0]
    assert 0 <= result['relevance'] <= 100
    assert 'not confidence' in result['relevance_type']
    with pytest.raises(ValueError):
        store.search(sort_by='DROP TABLE files')
