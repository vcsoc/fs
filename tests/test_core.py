import threading
from datetime import datetime

import numpy as np
import pytest

from fs.core import Store


class FakeEmbedder:
    model = "test-model"

    def embed(self, texts, query=False):
        vectors = []
        for text in texts:
            value = text.lower()
            weight = 8 if query else 1
            v = np.array([1 + weight * value.count("solar"), 1 + weight * value.count("budget"), 1 + weight * value.count("recipe")], dtype=np.float32)
            vectors.append(v / np.linalg.norm(v))
        return np.stack(vectors)


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "files"
    root.mkdir()
    (root / "solar-notes.txt").write_text("solar solar solar solar energy project proposal")
    (root / "budget-2025.md").write_text("budget budget budget expense review 2025")
    (root / "image.png").write_bytes(b"\x89PNG\x00\x01")
    store = Store(tmp_path / "db", FakeEmbedder())
    store.index(root)
    return store, root


def test_modes_and_persistence(workspace):
    store, root = workspace
    assert store.status()["files"] == 3
    for mode, query, expected in [("text", "energy", "solar-notes.txt"), ("filename", "budget", "budget-2025.md"), ("regex", r"budget-\d{4}", "budget-2025.md"), ("semantic", "solar", "solar-notes.txt"), ("hybrid", "solar", "solar-notes.txt")]:
        result = store.search(query, mode=mode)
        assert result["results"][0]["name"] == expected
    reopened = Store(store.directory, FakeEmbedder())
    assert reopened.search("energy", mode="text")["total"] == 1
    assert reopened.search("solar", mode="semantic")["results"][0]["name"] == "solar-notes.txt"
    assert reopened.search("", root=str(root))["total"] == 3


def test_index_and_analysis_timestamps_and_progress(workspace):
    store, root = workspace
    original = store.search('solar', mode='filename')['results'][0]
    assert original['indexed_at'] <= original['analyzed_at']
    events = []
    store.index(root, progress=events.append)
    unchanged = store.search('solar', mode='filename')['results'][0]
    assert unchanged['indexed_at'] == original['indexed_at']
    assert unchanged['analyzed_at'] == original['analyzed_at']
    assert events[-1]['total'] == events[-1]['scanned'] == events[-1]['processed'] == 3
    assert store.status()['roots'][0]['total_files'] == 3
    (root / 'solar-notes.txt').write_text('solar newer analysis')
    store.index(root)
    updated = store.search('solar', mode='filename')['results'][0]
    assert updated['indexed_at'] == original['indexed_at']
    assert updated['analyzed_at'] >= original['analyzed_at']


def test_incremental_change_and_deletion(workspace):
    store, root = workspace
    assert store.index(root)["unchanged"] == 3
    (root / "solar-notes.txt").write_text("recipe recipe recipe soup instructions")
    (root / "budget-2025.md").unlink()
    result = store.index(root)
    assert result["updated"] == 1 and result["removed"] == 1
    assert store.search("energy", mode="text")["total"] == 0
    assert store.search("budget", mode="filename")["total"] == 0
    assert store.search("recipe", mode="semantic")["results"][0]["name"] == "solar-notes.txt"


def test_filters_and_birth_time(workspace):
    store, _ = workspace
    today = datetime.now().date().isoformat()
    assert store.search("", modified_after=today, modified_before=today)["total"] == 3
    assert store.search("", modified_before="2000-01-01")["total"] == 0
    assert store.search("solar", mode="semantic", filename="budget")["total"] == 1
    with store.connect() as db:
        db.execute("UPDATE files SET created=NULL")
    assert store.search("", created_after="2000-01-01")["total"] == 0
    with pytest.raises(ValueError):
        store.search("", modified_after="nonsense")


def test_cancel_does_not_prune(workspace):
    store, root = workspace
    (root / "solar-notes.txt").unlink()
    cancel = threading.Event()
    cancel.set()
    result = store.index(root, cancel=cancel)
    assert result["cancelled"]
    assert store.status()["files"] == 3


def test_text_only_and_remove(tmp_path):
    root = tmp_path / "docs"
    root.mkdir()
    (root / "doc.txt").write_text("offline searchable content")
    store = Store(tmp_path / "db", FakeEmbedder())
    store.index(root, semantic=False)
    assert store.search("offline", mode="text")["total"] == 1
    assert store.status()["chunks"] == 0
    store.index(root)
    assert store.status()["chunks"] == 1
    store.remove_root(root)
    assert store.status()["files"] == 0
    assert (root / "doc.txt").exists()


def test_invalid_regex_and_literal_fts(workspace):
    store, _ = workspace
    with pytest.raises(ValueError):
        store.search("[", mode="regex")
    assert isinstance(store.search('" AND NOT OR : *', mode="text")["results"], list)
    with pytest.raises(ValueError):
        store.search("a" * 1001)


def test_model_failure_falls_back(workspace):
    store, _ = workspace
    def fail(*args, **kwargs):
        raise RuntimeError("Ollama is offline")
    store.embedder.embed = fail
    result = store.search("energy", mode="hybrid")
    assert result["total"] == 1 and "offline" in result["warning"]
    with pytest.raises(RuntimeError):
        store.search("energy", mode="semantic")


def test_exclusions_and_symlinks(tmp_path):
    root = tmp_path / "docs"
    root.mkdir()
    (root / "node_modules").mkdir()
    (root / "node_modules" / "hidden.txt").write_text("dependency")
    (root / "ok.txt").write_text("visible")
    try:
        (root / "link.txt").symlink_to(root / "ok.txt")
    except OSError:
        pytest.skip("Symlink creation requires privileges on this Windows installation")
    store = Store(root / "db", FakeEmbedder())
    store.index(root, semantic=False)
    assert store.status()["files"] == 1
