import time

from fs.core import Store
from fs.server import Application
from fs.sources import SourceMonitor, virtual_source, file_manager_target, external_env, ensure_gvfs_bridge
from tests.test_core import FakeEmbedder


def test_missing_gvfs_bridge_starts_once_with_host_libraries(monkeypatch):
    from pathlib import Path
    import fs.sources as sources
    calls = []
    monkeypatch.setattr(sources.os, 'getuid', lambda: 1000, raising=False)
    monkeypatch.setattr(sources, '_bridge_checked', 0)
    monkeypatch.setattr(Path, 'is_dir', lambda _: True)
    monkeypatch.setattr(Path, 'is_file', lambda _: True)
    monkeypatch.setattr(Path, 'is_mount', lambda _: False)
    monkeypatch.setattr(Path, 'is_symlink', lambda _: False)
    monkeypatch.setattr(sources.subprocess, 'run', lambda args, **kwargs: calls.append((args, kwargs)))
    root = '/run/user/1000/gvfs/smb-share:server=host,share=docs'
    ensure_gvfs_bridge(root)
    ensure_gvfs_bridge(root)
    ensure_gvfs_bridge('/home/alice/docs')
    assert len(calls) == 1
    assert calls[0][0] == ['/usr/lib/gvfsd-fuse', '/run/user/1000/gvfs']
    assert calls[0][1]['timeout'] == 3


def test_slow_probe_is_checking_not_falsely_offline():
    monitor = SourceMonitor()
    monitor.states['slow'] = {'pending': True, 'checked': time.monotonic() - 10, 'status': 'checking'}
    assert monitor.status('slow') == 'checking'


def test_gvfs_file_manager_uri_works_without_fuse():
    root = '/run/user/1000/gvfs/smb-share:server=192.168.40.101,share=visser4tb/.vcsoc/my docs'
    assert file_manager_target(root) == 'smb://192.168.40.101/visser4tb/.vcsoc/my%20docs'
    assert file_manager_target('/home/alice/docs') == '/home/alice/docs'


def test_system_opener_environment_does_not_inherit_frozen_libraries(monkeypatch):
    monkeypatch.setenv('LD_LIBRARY_PATH', '/app/_internal')
    monkeypatch.setenv('LD_LIBRARY_PATH_ORIG', '/usr/local/lib')
    assert external_env()['LD_LIBRARY_PATH'] == '/usr/local/lib'
    monkeypatch.delenv('LD_LIBRARY_PATH_ORIG')
    assert 'LD_LIBRARY_PATH' not in external_env()


def test_reachable_directory_not_mislabelled_offline_after_identity_change(tmp_path):
    monitor = SourceMonitor()
    monitor.status(str(tmp_path), expected_device=-1, expected_volume='old mount identity')
    for _ in range(100):
        if monitor.status(str(tmp_path)) == 'online':
            break
        time.sleep(.01)
    assert monitor.status(str(tmp_path)) == 'online'
    store = Store(tmp_path / 'db', FakeEmbedder())
    root = tmp_path / 'docs'
    root.mkdir()
    (root / 'one.txt').write_text('one')
    store.index(root)
    with store.connect() as db:
        db.execute('UPDATE locations SET volume=?', ('old mount identity',))
    import pytest
    with pytest.raises(ValueError, match='identity changed'):
        store.index(root)
    assert store.status()['files'] == 1


def test_virtual_exclusions_allow_explicit_mounted_sources():
    assert not virtual_source('/run/user/1000/gvfs/smb-share:server=192.168.40.101,share=visser4tb/.vcsoc/docs')
    assert not virtual_source('/run/media/alice/USB/docs')
    assert virtual_source('/run/user/1000/bus')
    assert virtual_source('/proc/self')


def test_offline_source_keeps_searchable_metadata_and_vectors(tmp_path):
    root = tmp_path / 'mounted'
    root.mkdir()
    (root / 'solar.txt').write_text('solar solar renewable power')
    store = Store(tmp_path / 'db', FakeEmbedder())
    store.index(root)
    root.rename(tmp_path / 'disconnected')
    app = Application(store)
    app.start_index(str(root), semantic=True)
    for _ in range(100):
        if app.job['state'] == 'offline':
            break
        time.sleep(.01)
    assert app.job['state'] == 'offline'
    assert store.search('solar', mode='text')['total'] == 1
    assert store.status()['chunks'] == 1
    store.sources.invalidate(str(root))
    monitor = SourceMonitor()
    monitor.status(str(root))
    for _ in range(100):
        if monitor.status(str(root)) == 'offline':
            break
        time.sleep(.01)
    assert monitor.status(str(root)) == 'offline'
    (tmp_path / 'disconnected').rename(root)
    assert store.index(root)['unchanged'] == 1


def test_forced_check_detects_reconnection_without_waiting_for_cache(tmp_path):
    root = tmp_path / 'network'
    monitor = SourceMonitor()
    def wait_for(expected):
        for _ in range(100):
            if monitor.status(str(root)) == expected:
                return
            time.sleep(.01)
        assert monitor.status(str(root)) == expected
    monitor.status(str(root))
    wait_for('offline')
    root.mkdir()
    assert monitor.status(str(root)) == 'offline'
    monitor.status(str(root), force=True)
    wait_for('online')


def test_can_save_a_new_offline_source(tmp_path):
    store = Store(tmp_path / 'db', FakeEmbedder())
    root = tmp_path / 'offline-share' / 'docs'
    app = Application(store)
    app.start_index(str(root), semantic=False)
    for _ in range(100):
        if app.job['state'] == 'offline':
            break
        time.sleep(.01)
    assert app.job['state'] == 'offline'
    assert store.status()['roots'][0]['root'] == str(root)
