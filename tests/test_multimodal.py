import json

import numpy as np
from PIL import Image
import pytest

from fs.core import Store, DEFAULT_MODEL
from fs.gemma_media import image_inputs, audio_inputs
from fs.native_model import NativeModel
from fs.preferences import DEFAULTS
from tests.test_core import FakeEmbedder


def test_full_model_and_direct_runtime_are_defaults():
    assert DEFAULT_MODEL == DEFAULTS['model'] == 'embeddinggemma-2:740m'
    assert DEFAULTS['embedding_backend'] == 'direct'


def test_vision_preprocessing_matches_patch_and_position_contract():
    data = image_inputs(Image.new('RGB', (80, 60), 'white'))
    assert data['pixel_values'].shape == (1, 2520, 768)
    assert data['pixel_position_ids'].shape == (1, 2520, 2)
    valid = data['pixel_position_ids'][0, :, 0] >= 0
    assert valid.sum() % 9 == 0
    assert np.all(data['pixel_values'][0, valid] == 1)
    assert np.all(data['pixel_position_ids'][0, ~valid] == -1)


def test_audio_preprocessing_is_finite_without_torch():
    data = audio_inputs(np.zeros(16000, dtype=np.float32))
    assert data['input_features'].shape == (1, 99, 128)
    assert data['input_features_mask'].dtype == bool
    assert np.isfinite(data['input_features']).all()
    with pytest.raises(ValueError):
        audio_inputs(np.array([np.nan] * 400))


def test_full_ready_requires_verified_encoders_not_just_downloads(tmp_path):
    model = NativeModel(tmp_path, full=True)
    for name, (size, _) in model.files().items():
        target = model.directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('wb') as stream:
            stream.truncate(size)
    from fs.native_model import IDENTITY
    marker = {'identity': IDENTITY}
    (model.directory / 'ready.json').write_text(json.dumps(marker))
    assert model.assets_ready() and not model.ready()
    marker['verified_modalities'] = ['text', 'image', 'audio', 'video']
    (model.directory / 'ready.json').write_text(json.dumps(marker))
    assert model.ready()


def test_media_vector_is_indexed_within_chunk_budget(tmp_path):
    class Multimodal(FakeEmbedder):
        supports_media = True
        def embed_media(self, **inputs):
            assert inputs['images']
            return self.embed(['solar'])
    root = tmp_path / 'docs'
    root.mkdir()
    Image.new('RGB', (80, 60)).save(root / 'opaque.jpg')
    store = Store(tmp_path / 'db', Multimodal())
    store.save_preferences({'max_chunks': 1, 'scan_duty_percent': 100})
    assert store.index(root)['errors'] == 0
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM vectors').fetchone()[0] == 1
        assert db.execute('SELECT text FROM vectors').fetchone()[0] == 'Image content'


def test_cancelled_media_file_is_not_committed_as_fully_analysed(tmp_path):
    import threading
    cancel = threading.Event()
    class Interrupted(FakeEmbedder):
        supports_media = True
        def embed_media(self, **inputs):
            cancel.set()
            return self.embed(['solar'])
    root = tmp_path / 'docs'
    root.mkdir()
    Image.new('RGB', (80, 60)).save(root / 'partial.jpg')
    store = Store(tmp_path / 'db', Interrupted())
    result = store.index(root, cancel=cancel)
    assert result['cancelled'] and store.status()['files'] == 0


def test_model_setup_job_id_survives_failure_and_following_jobs(tmp_path, monkeypatch):
    from fs.server import Application
    import time
    app = Application(Store(tmp_path / 'db'))
    def fail(**kwargs):
        kwargs['progress']({'phase': 'downloading', 'downloaded': 10, 'download_total': 20})
        raise RuntimeError('fixture download failed')
    monkeypatch.setattr(app.models, 'prepare', fail)
    result = app.start_index(None, True, 'direct')
    for _ in range(100):
        if not app.busy:
            break
        time.sleep(.01)
    assert app.job['id'] == result['job_id']
    assert app.job['state'] == 'error' and app.job['downloaded'] == 10
    assert app.completed_jobs[-1]['id'] == result['job_id']

def test_512_chunks_extend_native_video_coverage(tmp_path, monkeypatch):
    from fs import media_analysis
    class Multimodal(FakeEmbedder):
        supports_media = True
        def embed_media(self, **inputs):
            return self.embed(["solar"])
    monkeypatch.setattr(media_analysis, "probe", lambda *args: (20000, True, False))
    monkeypatch.setattr(media_analysis, "pcm", lambda *args: np.zeros(160, dtype=np.float32))
    root = tmp_path / "video"; root.mkdir(); (root / "long.mp4").write_bytes(b"fixture")
    store = Store(tmp_path / "db", Multimodal())
    store.save_preferences({"max_chunks": 512, "scan_duty_percent": 100})
    assert store.index(root)["errors"] == 0
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM vectors").fetchone()[0] == 512
        assert db.execute("SELECT count(*),max(end) FROM media_segments").fetchone()[:] == (511, 15330)
