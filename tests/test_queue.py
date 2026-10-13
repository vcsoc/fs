import threading
import time

from fs.core import Store
from fs.server import Application
from tests.test_core import FakeEmbedder


def test_locations_queue_and_continue_after_failure(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []
    roots = [tmp_path / name for name in ('first', 'second', 'third')]
    for root in roots:
        root.mkdir()
    def index(store, root, **kwargs):
        calls.append(root)
        if len(calls) == 1:
            entered.set()
            assert release.wait(3)
            raise RuntimeError('First source failed')
        return {'scanned': 0, 'updated': 0, 'removed': 0, 'errors': 0, 'cancelled': False}
    monkeypatch.setattr('fs.server.run_index', index)
    app = Application(Store(tmp_path / 'db', FakeEmbedder()))
    assert not app.start_index(str(roots[0]), False)['queued']
    assert entered.wait(3)
    assert app.start_index(str(roots[1]), False) == {'queued': True, 'position': 1}
    assert app.start_index(str(roots[2]), False) == {'queued': True, 'position': 2}
    release.set()
    for _ in range(300):
        if not app.busy:
            break
        time.sleep(.01)
    assert calls == [str(root) for root in roots]
    assert not app.busy and not app.queue
    assert [job['state'] for job in app.completed_jobs] == ['error', 'complete', 'complete']
