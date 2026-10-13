import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import numpy as np

from fs.core import Store
from fs.native_model import NativeModel
from fs.preferences import DEFAULTS, worker_layout
from fs.resource_limits import budget_command


def test_file_workers_overlap_but_submission_and_threads_are_bounded(tmp_path):
    class Embedder:
        model = identity = 'parallel-test'
        active = peak = 0
        lock = threading.Lock()
        def embed(self, texts, query=False):
            with self.lock:
                self.active += 1
                self.peak = max(self.peak, self.active)
            try:
                time.sleep(.03)
                return np.ones((len(texts), 768), dtype=np.float32)
            finally:
                with self.lock:
                    self.active -= 1
    root = tmp_path / 'files'
    root.mkdir()
    for n in range(6):
        (root / f'{n}.txt').write_text('a file to analyse')
    embedder = Embedder()
    store = Store(tmp_path / 'db', embedder)
    store.save_preferences({'file_workers': 4, 'cpu_threads': 2, 'scan_duty_percent': 100})
    events = []
    result = store.index(root, progress=events.append)
    assert embedder.peak == 2
    assert embedder.options['num_thread'] == 1
    assert result['file_workers'] == 2
    assert result['processed'] == result['scanned'] == result['total'] == 6
    assert all(event['scanned'] - event['processed'] <= 2 for event in events)
    assert [event['processed'] for event in events] == sorted(event['processed'] for event in events)
    assert store.status()['files'] == 6


def test_layout_reduces_workers_to_fit_memory_and_total_cpu():
    assert worker_layout(DEFAULTS, full=True) == (2, 1)
    assert worker_layout({**DEFAULTS, 'worker_memory_mb': 1024}, full=True) == (1, 2)
    for cpu in range(1, 9):
        workers, threads = worker_layout({**DEFAULTS, 'file_workers': 64, 'cpu_threads': cpu})
        assert workers * threads <= cpu


def test_native_session_is_loaded_once_and_runs_concurrently(tmp_path):
    barrier = threading.Barrier(2)
    class Session:
        def get_inputs(self):
            return [SimpleNamespace(name='input_ids'), SimpleNamespace(name='attention_mask')]
        def get_outputs(self):
            return [SimpleNamespace(name='sentence_embedding')]
        def run(self, names, inputs):
            barrier.wait(timeout=3)
            return [np.ones((1, 768), dtype=np.float32)]
    class Model(NativeModel):
        loads = 0
        def _load(self):
            self.loads += 1
            self.session = Session()
            self.controls = ()
            self.tokenizer = SimpleNamespace(encode=lambda text: SimpleNamespace(ids=[1], attention_mask=[1]))
    model = Model(tmp_path, threads=1)
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(model.embed, [['a'], ['b']]))
    assert model.loads == 1
    assert all(row.shape == (1, 768) for row in results)


def test_cgroup_budget_is_aggregate_and_does_not_forward_secrets(monkeypatch):
    monkeypatch.setattr('fs.resource_limits.cgroup_caps_available', lambda: True)
    monkeypatch.setattr('fs.resource_limits.shutil.which', lambda name: '/usr/bin/' + name)
    command, env, unit = budget_command(['fs-service', '--worker'], DEFAULTS,
                                       {'PATH': '/bin', 'FS_WORKER_TMP': '/tmp/owned', 'API_KEY': 'private-test'})
    assert 'MemoryMax=2048M' in command and 'CPUQuota=200%' in command
    assert 'OOMPolicy=kill' in command and 'MemorySwapMax=0' in command
    assert unit.startswith('fs-index-')
    assert not any('API_KEY' in item or 'private-test' in item for item in command)
    assert command[-2:] == ['fs-service', '--worker']
