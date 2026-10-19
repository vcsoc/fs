import pytest
from fs.core import Store


def test_alias_is_persistent_metadata_not_a_filesystem_rename(tmp_path):
    root = tmp_path / 'folder'; root.mkdir(); file = root / 'document.txt'; file.write_text('original')
    store = Store(tmp_path / 'db'); store.index(root, semantic=False)
    store.rename_location(str(root), 'My documents')
    reopened = Store(store.directory)
    source = reopened.status()['roots'][0]
    assert source['alias'] == 'My documents' and source['root'] == str(root)
    assert file.read_text() == 'original'
    assert reopened.search('original', mode='text')['results'][0]['path'] == str(file)
    reopened.rename_location(str(root), '')
    assert reopened.status()['roots'][0]['alias'] == ''
    for alias in ['x' * 121, 'line\nbreak', None]:
        with pytest.raises(ValueError):
            store.rename_location(str(root), alias)
    with pytest.raises(ValueError):
        store.rename_location('/not-an-indexed-location', 'alias')


def test_display_preferences_persist_separately_from_worker_settings(tmp_path):
    store = Store(tmp_path / 'db')
    assert store.preferences()['show_thumbnails'] is True
    prefs = store.save_preferences({'show_thumbnails':False, 'column_widths':{'name':320,'path':250}})
    assert Store(store.directory).preferences() == prefs
    with store.connect() as db:
        assert 'column_widths' not in store._meta(db, 'preferences')
        assert 'column_widths' in store._meta(db, 'search_preferences')
    for invalid in [{'show_thumbnails':1}, {'column_widths':{'name':59}}, {'column_widths':{'unknown':100}}, {'column_widths':{'name':1501}}, {'column_widths':{'path':100.5}}, {'column_widths':[]}]:
        with pytest.raises(ValueError):
            store.save_preferences(invalid)


def test_unlink_removes_index_and_watch_registration_not_originals(tmp_path):
    root = tmp_path / 'folder'; root.mkdir(); file = root / 'document.txt'; file.write_text('keep')
    store = Store(tmp_path / 'db'); store.index(root, semantic=False)
    store.rename_location(str(root), 'Alias')
    store.remove_root(str(root))
    assert not store.status()['roots'] and store.status()['files'] == 0
    assert file.read_text() == 'keep'


def test_unlink_does_not_interrupt_a_locked_scan(tmp_path):
    from fs.locking import writer_lock
    root = tmp_path / "folder"; root.mkdir(); file = root / "document.txt"; file.write_text("keep")
    store = Store(tmp_path / "db"); store.index(root, semantic=False)
    with writer_lock(store.directory / 'writer.lock'):
        with pytest.raises(RuntimeError):
            store.remove_root(str(root))
    assert store.status()["roots"] and file.read_text() == "keep"
