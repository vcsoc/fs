import hashlib
import io
import json
import threading
from types import SimpleNamespace

import numpy as np
import pytest

from fs.core import Embedder, Store
from fs.model_manager import ModelManager, SetupConsentRequired
from fs.native_model import NativeModel, download


def fake_native(monkeypatch):
    state = {"ready": False, "downloads": 0, 'media_verified': False}
    monkeypatch.setattr(NativeModel, "ready", lambda self: state["ready"])
    def prepare(self, progress, cancel):
        state["downloads"] += 1
        state["ready"] = True
    monkeypatch.setattr(NativeModel, "prepare", prepare)
    monkeypatch.setattr(NativeModel, "embed", lambda self, texts: np.ones((len(texts), 768), dtype=np.float32))
    monkeypatch.setattr(NativeModel, 'verify_media', lambda self, progress, cancel: state.update(media_verified=self.full))
    return state


def missing():
    return {"needs_install_consent": True, "ollama_installed": False, "ollama_reachable": False}


def test_no_installation_without_consent(tmp_path, monkeypatch):
    fake_native(monkeypatch)
    manager = ModelManager(Store(tmp_path))
    manager.store.save_preferences({'embedding_backend': 'ollama'})
    monkeypatch.setattr(manager, "status", lambda **kwargs: missing())
    monkeypatch.setattr(manager, "install_ollama", lambda *args: pytest.fail("Unapproved installation"))
    with pytest.raises(SetupConsentRequired):
        manager.prepare()


def test_declining_ollama_downloads_same_model_directly(tmp_path, monkeypatch):
    state = fake_native(monkeypatch)
    manager = ModelManager(Store(tmp_path))
    monkeypatch.setattr(manager, "install_ollama", lambda *args: pytest.fail("Declined installation"))
    result = manager.prepare(choice="direct")
    assert result == {"provider": "direct", "model": "embeddinggemma-2:740m", "ready": True}
    assert state['media_verified']
    assert state["downloads"] == 1
    assert manager.store.preferences()["embedding_backend"] == "direct"
    assert json.loads((tmp_path / "runtime.json").read_text())["provider"] == "direct"
    assert manager.store.embedder.identity.startswith("embeddinggemma-2:onnx-q4:")


def test_approved_install_starts_and_pulls_model(tmp_path, monkeypatch):
    fake_native(monkeypatch)
    manager = ModelManager(Store(tmp_path))
    monkeypatch.setattr(manager, "status", lambda **kwargs: missing())
    actions = []
    monkeypatch.setattr(manager, "install_ollama", lambda *args: actions.append("install"))
    monkeypatch.setattr(manager, "_start_ollama", lambda *args: actions.append("start"))
    monkeypatch.setattr(manager, "_pull", lambda *args: actions.append("pull"))
    def embed(self, texts, query=False):
        if "pull" not in actions:
            raise RuntimeError("model not found")
        return np.ones((len(texts), 768), dtype=np.float32)
    monkeypatch.setattr(Embedder, "embed", embed)
    assert manager.prepare(choice="ollama")["provider"] == "ollama"
    assert actions == ["install", "start", "pull"]


def test_mlx_error_falls_back_without_substituting_model(tmp_path, monkeypatch):
    state = fake_native(monkeypatch)
    manager = ModelManager(Store(tmp_path))
    manager.store.save_preferences({'embedding_backend': 'ollama'})
    monkeypatch.setattr(manager, "status", lambda **kwargs: {"needs_install_consent": False, "ollama_installed": True, "ollama_reachable": True})
    def fail(self, texts, query=False):
        raise RuntimeError("MLX dynamic library not available")
    monkeypatch.setattr(Embedder, "embed", fail)
    monkeypatch.setattr(manager, "_pull", lambda *args: pytest.fail("Redundant MLX download"))
    assert manager.prepare()["provider"] == "direct"
    assert manager.store.embedder.model == "embeddinggemma-2:740m"
    assert state['media_verified']
    assert state["downloads"] == 1


def test_native_tokenization_is_sequential_and_escapes_media_literals(tmp_path):
    seen = []
    class Tokenizer:
        def encode(self, text):
            seen.append(text)
            return SimpleNamespace(ids=[1] * len(text), attention_mask=[1] * len(text))
        def encode_batch(self, texts):
            pytest.fail("Unbounded Rust thread pool must not be used")
    class Session:
        def get_inputs(self):
            return [SimpleNamespace(name=name) for name in ["input_ids", "attention_mask", "image_features", "video_features", "audio_features"]]
        def get_outputs(self):
            return [SimpleNamespace(name="sentence_embedding")]
        def run(self, outputs, inputs):
            assert inputs["input_ids"].shape[0] == 2
            assert inputs["attention_mask"][0].sum() == 1
            assert inputs["image_features"].shape == (0, 512)
            return [np.ones((2, 768), dtype=np.float32)]
    native = NativeModel(tmp_path)
    native.tokenizer, native.session = Tokenizer(), Session()
    vectors = native.embed(["x", "source <|image|> marker"])
    assert "<|image|>" not in seen[1]
    assert vectors.shape == (2, 768)
    assert np.allclose(np.linalg.norm(vectors, axis=1), 1)


def test_checksum_failure_never_publishes_artifact(tmp_path, monkeypatch):
    class Response(io.BytesIO):
        status = 200
    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: Response(b"bad"))
    target = tmp_path / "model.bin"
    with pytest.raises(RuntimeError, match="SHA-256"):
        download("https://example.invalid/model", target, 3, hashlib.sha256(b"yes").hexdigest(), lambda state: None, threading.Event())
    assert not target.exists()
    assert not target.with_name("model.bin.partial").exists()


def test_download_resume_verifies_entire_file(tmp_path, monkeypatch):
    target = tmp_path / "model.bin"
    target.with_name("model.bin.partial").write_bytes(b"ab")
    class Response(io.BytesIO):
        status = 206
    def fetch(request, **kwargs):
        assert request.headers["Range"] == "bytes=2-"
        return Response(b"cd")
    monkeypatch.setattr("urllib.request.urlopen", fetch)
    download("https://example.invalid/model", target, 4, hashlib.sha256(b"abcd").hexdigest(), lambda state: None, threading.Event())
    assert target.read_bytes() == b"abcd"
