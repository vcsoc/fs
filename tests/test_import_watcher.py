import time

import pytest
from PIL import Image

from fs.core import Store
from fs.preview import Preview
from fs.server import Application
from fs.watcher import LocationWatcher


def test_selected_index_never_scans_siblings_or_prunes_existing(tmp_path):
    root = tmp_path / 'files'; root.mkdir()
    a = root / 'a.txt'; b = root / 'b.txt'
    a.write_text('first'); b.write_text('unrelated')
    store = Store(tmp_path / 'db')
    store.index(root, semantic=False)
    a.write_text('updated')
    result = store.index(root, semantic=False, paths=[str(a)])
    assert result['scanned'] == 1 and result['removed'] == 0
    assert store.status()['files'] == 2
    with pytest.raises(ValueError):
        store.index(root, semantic=False, paths=[str(tmp_path / 'outside.txt')])


def test_import_scope_survives_reopening_and_refresh(tmp_path, monkeypatch):
    root = tmp_path / 'files'; root.mkdir()
    chosen = root / 'chosen.txt'; chosen.write_text('chosen')
    (root / 'unrelated.txt').write_text('unrelated')
    store = Store(tmp_path / 'db'); app = Application(store)
    calls = []
    monkeypatch.setattr(app, 'start_index', lambda root, semantic, **kw: calls.append((root, kw)))
    assert app.import_paths([str(chosen)], False)['files'] == 1
    reopened = Store(tmp_path / 'db'); reopened.index(root, semantic=False)
    assert reopened.status()['files'] == 1
    assert reopened.status()['roots'][0]['scope'] == 'selected'
    assert calls[0][1]['paths'] == [str(chosen)]


def online(store):
    store.sources.status = lambda *args, **kw: 'online'


def test_watcher_detects_new_nested_files_and_waits_for_stability(tmp_path):
    root = tmp_path / 'files'; root.mkdir()
    store = Store(tmp_path / 'db'); store.add_location(root); online(store)
    calls = []
    watcher = LocationWatcher(store, lambda root, paths: calls.append(paths) or True, settle=.02, revisit=0)
    nested = root / 'nested'; nested.mkdir(); new = nested / 'new.txt'; new.write_text('new')
    watcher.tick(); assert not calls
    time.sleep(.03); watcher.tick(); assert calls == [[str(new)]]
    watcher.close()


def test_selected_watcher_does_not_expand_to_siblings_and_pause_is_persistent(tmp_path):
    root = tmp_path / 'files'; root.mkdir()
    a = root / 'a.txt'; a.write_text('a'); (root / 'b.txt').write_text('b')
    store = Store(tmp_path / 'db'); store.add_location(root, scope='selected'); online(store)
    with store.connect() as db:
        db.execute('INSERT INTO location_files VALUES(?,?)', (str(root), str(a)))
    calls = []; watcher = LocationWatcher(store, lambda root, paths: calls.extend(paths) or True, settle=0, revisit=0)
    watcher.tick(); assert calls == [str(a)]
    with store.connect() as db:
        db.execute('UPDATE locations SET watch_enabled=0')
    watcher.tick(); assert watcher.states[str(root)] == 'Paused'; assert not watcher.pending
    watcher.close()


def test_offline_watcher_preserves_cached_entries_and_skips_io(tmp_path):
    root = tmp_path / 'files'; root.mkdir(); (root / 'a.txt').write_text('a')
    store = Store(tmp_path / 'db'); store.index(root, semantic=False)
    store.sources.status = lambda *args, **kw: 'offline'
    watcher = LocationWatcher(store, lambda *args: pytest.fail('queued offline file'))
    watcher.tick(); assert store.status()['files'] == 1
    assert not watcher.walks
    watcher.close()


@pytest.mark.parametrize('extension', ['jpg','png','gif','webp','bmp','tiff','ico','avif','heic','ppm','tga'])
def test_common_image_thumbnails(tmp_path, extension):
    root = tmp_path / 'files'; root.mkdir(); path = root / ('sample.' + extension)
    if extension == 'heic':
        import pillow_heif
        pillow_heif.register_heif_opener()
    image = Image.new('RGB', (64, 48), 'red'); image.save(path)
    store = Store(tmp_path / 'db'); store.index(root, semantic=False)
    preview = Preview(store, 'test'); file = store.search(mode='filename')['results'][0]
    with Image.open(preview.thumbnail(file['id'])) as poster:
        assert poster.format == 'JPEG' and poster.width <= 360 and poster.height <= 240
    path.unlink(); assert preview.decorate(file)['thumbnail_state'] == 'missing'


def test_document_thumbnail_and_alpha_compositing(tmp_path):
    root = tmp_path / 'files'; root.mkdir()
    (root / 'text.md').write_text('Readable local document')
    Image.new('RGBA', (20, 20), (0, 0, 0, 0)).save(root / 'alpha.png')
    store = Store(tmp_path / 'db'); store.index(root, semantic=False); preview = Preview(store, 'test')
    for file in store.search(mode='filename')['results']:
        with Image.open(preview.thumbnail(file['id'])) as poster:
            if file['name'] == 'alpha.png':
                assert min(poster.getpixel((10,10))) > 240
            else:
                assert poster.size == (180, 240)
