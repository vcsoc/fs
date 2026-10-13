"""Pinned, checksum-verified EmbeddingGemma 2 inference without Ollama."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import threading
import urllib.request

import numpy as np

REPOSITORY = "onnx-community/embeddinggemma-2-ONNX"
REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0"
IDENTITY = f"embeddinggemma-2:onnx-q4:{REVISION}:768"
FILES = {
    "onnx/model_q4.onnx": (490742, "f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9"),
    "onnx/model_q4.onnx_data": (174028800, "c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49"),
    "tokenizer.json": (32170510, "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4"),
}

MEDIA_FILES = {
    'onnx/vision_encoder_q4.onnx': (159400, '7ea284226d4938f0ad921ab091f1d80a9ca699aa802984ef5cd5eec4f4761d96'),
    'onnx/vision_encoder_q4.onnx_data': (108957696, '0a9d6c927334f152a33dd90874f65d6ea5228999abe6a450d3f7813677fa704c'),
    'onnx/audio_encoder_q4.onnx': (245543, 'c4cce3370e72262280d00293cac038896050a03a8e9a27e10b061ca97510296e'),
    'onnx/audio_encoder_q4.onnx_data': (189075968, 'ba9328e6341360974083085b44b2bba265003bda564740f7c4c23ed9928f17e2'),
}
FULL_MODELS = {'embeddinggemma-2', 'embeddinggemma-2:latest', 'embeddinggemma-2:740m'}
DIRECT_MODELS = FULL_MODELS | {'embeddinggemma-2:270m'}


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def download(url, target, size, checksum, progress, cancel):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    progress({'phase': 'checking', 'path': 'Checking ' + target.name})
    if target.exists() and target.stat().st_size == size and digest(target) == checksum:
        return
    partial = target.with_name(target.name + ".partial")
    offset = partial.stat().st_size if partial.exists() else 0
    if offset >= size:
        partial.unlink()
        offset = 0
    request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 206:
            offset = 0
        with partial.open("ab" if offset else "wb") as stream:
            while True:
                if cancel.is_set():
                    raise InterruptedError("Model setup cancelled. Partial downloads are retained for resume.")
                block = response.read(1024 * 1024)
                if not block:
                    break
                stream.write(block)
                offset += len(block)
                if offset > size:
                    raise RuntimeError("Download exceeds the published artifact size.")
                progress({"phase": "downloading", "path": target.name, "downloaded": offset, "download_total": size})
    progress({'phase': 'verifying', 'path': 'Verifying SHA-256 - ' + target.name})
    if offset != size or digest(partial) != checksum:
        partial.unlink(missing_ok=True)
        raise RuntimeError("Model artifact failed its size/SHA-256 check. Retry setup.")
    os.replace(partial, target)


class NativeModel:
    def __init__(self, directory, threads=2, full=False):
        self.directory = Path(directory) / "models" / "embeddinggemma-2" / REVISION
        self.threads = threads
        self.full = full
        self.encoders = {}
        self.session = None
        self.tokenizer = None
        self.lock = threading.Lock()
        self.controls = ("<|image|>", "<|video|>", "<|audio|>")

    def assets_ready(self):
        marker = self.directory / "ready.json"
        try:
            manifest = json.loads(marker.read_text())
            return manifest.get("identity") == IDENTITY and all((self.directory / name).stat().st_size == size for name, (size, _) in self.files().items())
        except (OSError, ValueError):
            return False

    def ready(self):
        if not self.assets_ready():
            return False
        if self.full:
            return json.loads((self.directory / 'ready.json').read_text()).get('verified_modalities') == ['text', 'image', 'audio', 'video']
        return True

    def files(self):
        return {**FILES, **(MEDIA_FILES if self.full else {})}

    def prepare(self, progress=None, cancel=None):
        progress = progress or (lambda state: None)
        cancel = cancel or threading.Event()
        from .locking import writer_lock
        self.directory.mkdir(parents=True, exist_ok=True)
        with writer_lock(self.directory / "download.lock"):
            completed = 0
            total = sum(size for size, _ in self.files().values())
            for name, (size, checksum) in self.files().items():
                url = f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{name}"
                def item_progress(state):
                    if state.get('phase') == 'downloading':
                        state = {**state, 'downloaded': completed + state.get('downloaded', 0), 'download_total': total}
                    progress(state)
                download(url, self.directory / name, size, checksum, item_progress, cancel)
                completed += size
            progress({'phase': 'installing', 'path': 'Installing verified model components and provenance'})
            # Retain provenance/license notices alongside the pinned model weights.
            with urllib.request.urlopen(f"https://huggingface.co/{REPOSITORY}/raw/{REVISION}/README.md", timeout=20) as response:
                (self.directory / "MODEL_CARD.md").write_bytes(response.read(100_000))
            temporary = self.directory / "ready.partial"
            temporary.write_text(json.dumps({"identity": IDENTITY, "repository": REPOSITORY, "revision": REVISION, "license": "Apache-2.0"}))
            os.replace(temporary, self.directory / "ready.json")

    def _load(self):
        if not self.assets_ready():
            raise RuntimeError("EmbeddingGemma 2 direct runtime needs setup. Add a semantic location or run `fs model setup --direct`.")
        import onnxruntime as ort
        from tokenizers import Tokenizer
        options = ort.SessionOptions()
        options.intra_op_num_threads = self.threads
        options.inter_op_num_threads = 1
        options.enable_cpu_mem_arena = False
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(self.directory / "onnx/model_q4.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
        self.tokenizer = Tokenizer.from_file(str(self.directory / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=1024)
        self.tokenizer.no_padding()
        self.controls = tuple(value for token_id in [255999, 256000, 258880, 258881, 258882, 258883, 258884]
                              if (value := self.tokenizer.id_to_token(token_id)))

    def _encoder(self, name):
        with self.lock:
            if name not in self.encoders:
                import onnxruntime as ort
                options = ort.SessionOptions()
                options.intra_op_num_threads = self.threads
                options.inter_op_num_threads = 1
                options.enable_cpu_mem_arena = False
                options.log_severity_level = 3
                self.encoders[name] = ort.InferenceSession(str(self.directory / ('onnx/' + name + '_encoder_q4.onnx')), sess_options=options, providers=['CPUExecutionProvider'])
            return self.encoders[name]

    def embed_media(self, images=None, audio=None, video=False):
        if not self.full:
            raise RuntimeError('Media inference requires the full embeddinggemma-2:740m direct model.')
        from .gemma_media import image_inputs, audio_inputs
        with self.lock:
            if self.session is None:
                self._load()
        features = {name: np.empty((0, 512), dtype=np.float32) for name in ['image_features', 'video_features', 'audio_features']}
        ids = [2]
        visual = []
        for image in images or []:
            value = self._encoder('vision').run(None, image_inputs(image, 140 if video else 280))[0]
            if value.ndim != 2 or value.shape[1] != 512:
                raise RuntimeError('Vision encoder returned an incompatible feature shape.')
            visual.append(value)
            ids.extend([255999] + [258884 if video else 258880] * len(value) + [258882])
        if visual:
            features['video_features' if video else 'image_features'] = np.concatenate(visual).astype(np.float32)
        if audio is not None:
            value = self._encoder('audio').run(None, audio_inputs(audio))[0]
            if value.ndim != 2 or value.shape[1] != 512:
                raise RuntimeError('Audio encoder returned an incompatible feature shape.')
            features['audio_features'] = value.astype(np.float32)
            ids.extend([256000] + [258881] * len(value) + [258883])
        ids.append(1)
        if len(ids) <= 2 or len(ids) > 8192:
            raise ValueError('Media input is empty or exceeds the model context budget.')
        features['input_ids'] = np.asarray([ids], dtype=np.int64)
        features['attention_mask'] = np.ones((1, len(ids)), dtype=np.int64)
        output_names = [item.name for item in self.session.get_outputs()]
        outputs = self.session.run(None, features)
        result = np.asarray(outputs[output_names.index('sentence_embedding')], dtype=np.float32)
        norms = np.linalg.norm(result, axis=1, keepdims=True)
        if result.shape != (1, 768) or not np.isfinite(result).all() or np.any(norms == 0):
            raise RuntimeError('Multimodal inference returned invalid embeddings.')
        return result / norms

    def verify_media(self, progress, cancel):
        if not self.full:
            return
        from PIL import Image
        for label, kwargs in [('vision', {'images': [Image.new('RGB', (96, 96), 'gray')]}), ('audio', {'audio': np.zeros(16000, dtype=np.float32)})]:
            if cancel.is_set():
                raise InterruptedError('Setup cancelled.')
            progress({'phase': 'checking', 'path': 'Verifying ' + label + ' encoder with local test input'})
            self.embed_media(**kwargs)
        if cancel.is_set():
            raise InterruptedError('Setup cancelled.')
        marker = json.loads((self.directory / 'ready.json').read_text())
        marker['verified_modalities'] = ['text', 'image', 'audio', 'video']
        temporary = self.directory / 'ready.verified.partial'
        temporary.write_text(json.dumps(marker))
        os.replace(temporary, self.directory / 'ready.json')

    def embed(self, texts):
        with self.lock:
            if self.session is None:
                self._load()
            # Sequential tokenization avoids an unbounded Rust/Rayon thread pool.
            sanitized = []
            for text in texts:
                # Literal media markers in source files are text, not multimodal input.
                for control in self.controls:
                    text = text.replace(control, control[:1] + " " + control[1:])
                sanitized.append(text)
            encodings = [self.tokenizer.encode(text) for text in sanitized]
        width = max(len(item.ids) for item in encodings)
        ids = np.zeros((len(texts), width), dtype=np.int64)
        mask = np.zeros_like(ids)
        for row, item in enumerate(encodings):
            ids[row, :len(item.ids)] = item.ids
            mask[row, :len(item.ids)] = item.attention_mask
        inputs = {"input_ids": ids, "attention_mask": mask}
        for name in ["image_features", "video_features", "audio_features"]:
            inputs[name] = np.empty((0, 512), dtype=np.float32)
        names = {item.name for item in self.session.get_inputs()}
        if names - inputs.keys():
            raise RuntimeError(f"Unsupported pinned model inputs: {sorted(names - inputs.keys())}")
        outputs = self.session.run(None, {name: inputs[name] for name in names})
        output_names = [item.name for item in self.session.get_outputs()]
        if "sentence_embedding" not in output_names:
            raise RuntimeError(f"Pinned model has no sentence_embedding output: {output_names}")
        embeddings = np.asarray(outputs[output_names.index("sentence_embedding")], dtype=np.float32)
        if embeddings.shape != (len(texts), 768) or not np.isfinite(embeddings).all():
            raise RuntimeError("Direct model returned invalid embeddings.")
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        if np.any(norms == 0):
            raise RuntimeError("Direct model returned zero embeddings.")
        return embeddings / norms
