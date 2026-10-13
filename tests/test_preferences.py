import threading

import pytest

from fs.core import Store
from fs.jobs import run_index
from fs.locking import writer_lock


def test_preferences_persist_and_validate(tmp_path):
    store = Store(tmp_path / "db")
    assert store.preferences()["theme"] == "dark"
    saved = store.save_preferences({"theme": "light", "cpu_threads": 1, "max_file_mb": 0, "model": "embeddinggemma"})
    assert saved["max_file_mb"] == 0
    assert Store(store.directory).preferences() == saved
    assert store.embedder.model == "embeddinggemma"
    assert store.embedder.options == {"num_thread": 1, "num_gpu": 0}
    store.save_preferences({'max_chunks': 512})
    assert Store(store.directory).preferences()['max_chunks'] == 512
    for invalid in [{'max_chunks': 513}, {'max_chunks': 0}, {"cpu_threads": 0}, {"worker_memory_mb": 1}, {"theme": "purple"}, {"use_gpu": 1}, {"unknown": 42}, {"model": "bad model"}]:
        with pytest.raises(ValueError):
            store.save_preferences(invalid)


def test_unlimited_size_orders_smallest_first(tmp_path):
    root = tmp_path / "files"
    root.mkdir()
    large = root / "a-large.txt"
    large.write_text("large searchable document\n" + "x" * (2 * 1024 * 1024))
    small = root / "z-small.txt"
    small.write_text("small searchable document")
    store = Store(tmp_path / "db")
    store.save_preferences({"max_file_mb": 1, "scan_duty_percent": 100})
    store.index(root, semantic=False)
    assert store.search("large", mode="text")["results"][0]["excerpt"] == ""
    store.save_preferences({"max_file_mb": 0})
    order = []
    store.index(root, semantic=False, progress=lambda state: order.append(state["path"]) if state.get('scanned', 0) else None)
    assert order[0].endswith("z-small.txt")
    assert order[1].endswith("a-large.txt")
    assert store.search("large", mode="text")["results"][0]["excerpt"].startswith("large searchable")


def test_worker_isolation_and_lock(tmp_path):
    root = tmp_path / "files"
    root.mkdir()
    (root / "doc.txt").write_text("isolated worker test")
    store = Store(tmp_path / "db")
    store.save_preferences({"scan_duty_percent": 100, "cpu_threads": 1})
    with writer_lock(store.directory / "writer.lock"):
        with pytest.raises(RuntimeError, match="Another fs process"):
            store.index(root, semantic=False)
    result = run_index(store, root, semantic=False)
    assert result["state"] == "complete"
    assert store.search("isolated", mode="text")["total"] == 1
    empty = tmp_path / "empty"
    empty.mkdir()
    store.index(empty, semantic=False)
    assert any(r["root"] == str(empty) and r["files"] == 0 for r in store.status()["roots"])


def test_worker_cancellation_saves_completed_files(tmp_path):
    root = tmp_path / "files"
    root.mkdir()
    for i in range(30):
        (root / f"file-{i}.txt").write_text("text " * 2000)
    store = Store(tmp_path / "db")
    store.save_preferences({"scan_duty_percent": 5})
    cancel = threading.Event()
    def progress(state):
        if state.get("updated", 0) >= 1:
            cancel.set()
    result = run_index(store, root, semantic=False, progress=progress, cancel=cancel)
    assert result["cancelled"]
    assert store.status()["files"] >= 1
