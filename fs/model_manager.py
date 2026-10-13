from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import threading
import urllib.request
import zipfile

from .native_model import NativeModel, download, DIRECT_MODELS, FULL_MODELS


class SetupConsentRequired(RuntimeError):
    pass


class ModelManager:
    def __init__(self, store):
        self.store = store
        self.directory = store.directory
        self.process = None
        self.logs = None

    def binary(self):
        own = self.directory / "runtime/ollama"
        for path in [own / "bin/ollama", own / "ollama", own / "ollama.exe", own / "Ollama.app/Contents/Resources/ollama"]:
            if path.is_file():
                return str(path.resolve())
        return shutil.which("ollama")

    def status(self, probe=False):
        self.store.apply_preferences()
        reachable = False
        if probe:
            try:
                with urllib.request.urlopen(self.store.embedder.url + "/api/version", timeout=2) as response:
                    reachable = response.status == 200
            except OSError:
                pass
        native = NativeModel(self.directory, full=self.store.embedder.model in FULL_MODELS)
        installed = self.binary() is not None or reachable
        direct_ready = native.ready() and self.store.embedder.model in DIRECT_MODELS
        prefer_ollama = self.store.preferences()["embedding_backend"] == "ollama"
        return {"ollama_installed": installed, "ollama_reachable": reachable,
                "direct_ready": direct_ready, "needs_install_consent": not installed and self.store.preferences()['embedding_backend'] != 'direct' and (not direct_ready or prefer_ollama),
                "backend": getattr(self.store.embedder, "provider", "ollama"),
                "model": self.store.embedder.model, "modalities": (['text', 'image', 'audio', 'video'] if native.full else ['text']) if direct_ready else [],
                "repository": "onnx-community/embeddinggemma-2-ONNX",
                "model_directory": str(native.directory)}

    def install_ollama(self, progress, cancel):
        # Install a private, portable runtime; no sudo, shell installer, or PATH changes.
        with urllib.request.urlopen("https://api.github.com/repos/ollama/ollama/releases/latest", timeout=20) as response:
            release = json.load(response)
        machine = platform.machine().lower()
        arch = "arm64" if machine in {"arm64", "aarch64"} else "amd64" if machine in {"x86_64", "amd64"} else None
        if not arch:
            raise RuntimeError("No supported Ollama portable build for this architecture. Use direct inference.")
        name = "ollama-darwin.tgz" if platform.system() == "Darwin" else f"ollama-windows-{arch}.zip" if os.name == "nt" else f"ollama-linux-{arch}.tar.zst"
        asset = next((item for item in release["assets"] if item["name"] == name), None)
        if not asset or not asset.get("digest", "").startswith("sha256:"):
            raise RuntimeError("The official release lacks a verifiable portable artifact. Use direct inference.")
        url = asset["browser_download_url"]
        if not url.startswith("https://github.com/ollama/ollama/releases/download/"):
            raise RuntimeError("Unexpected official runtime download origin.")
        runtime = self.directory / "runtime"
        runtime.mkdir(parents=True, exist_ok=True)
        archive = runtime / name
        download(url, archive, asset["size"], asset["digest"].split(":", 1)[1], progress, cancel)
        progress({"phase": "installing", "path": "Unpacking verified portable Ollama runtime"})
        with tempfile.TemporaryDirectory(prefix="install-", dir=runtime) as folder:
            target = Path(folder) / "ollama"
            target.mkdir()
            if name.endswith(".zip"):
                with zipfile.ZipFile(archive) as bundle:
                    for item in bundle.infolist():
                        if cancel.is_set():
                            raise InterruptedError("Setup cancelled.")
                        destination = (target / item.filename).resolve()
                        if not destination.is_relative_to(target.resolve()):
                            raise RuntimeError("Unsafe archive member.")
                        bundle.extract(item, target)
            else:
                if name.endswith(".zst"):
                    import zstandard
                    with archive.open("rb") as source, (Path(folder) / "bundle.tar").open("wb") as output:
                        zstandard.ZstdDecompressor().copy_stream(source, output)
                    source_archive = Path(folder) / "bundle.tar"
                else:
                    source_archive = archive
                with tarfile.open(source_archive) as bundle:
                    for member in bundle:
                        if cancel.is_set():
                            raise InterruptedError("Setup cancelled.")
                        bundle.extract(member, target, filter="data")
            for candidate in [target / "ollama", target / "bin/ollama"]:
                if candidate.exists() and os.name != "nt":
                    candidate.chmod(0o755)
            destination = runtime / "ollama"
            if destination.exists():
                raise RuntimeError("An app-managed runtime already exists; it was not overwritten.")
            os.replace(target, destination)
        archive.unlink(missing_ok=True)
        if not self.binary():
            raise RuntimeError("The downloaded runtime did not contain the expected Ollama executable.")

    def _start_ollama(self, cancel):
        from urllib.parse import urlparse
        endpoint = urlparse(self.store.embedder.url)
        if endpoint.hostname not in {"127.0.0.1", "localhost"}:
            raise RuntimeError("Only local Ollama services can be started automatically.")
        binary = self.binary()
        if not binary:
            raise RuntimeError("Ollama is not installed.")
        self.logs = tempfile.TemporaryFile()
        env = {**os.environ, "OLLAMA_HOST": endpoint.netloc, "OLLAMA_NUM_PARALLEL": "1", "OLLAMA_MAX_LOADED_MODELS": "1"}
        if str(self.directory / "runtime") in binary:
            env["OLLAMA_MODELS"] = str((self.directory / "models/ollama").resolve())
        self.process = subprocess.Popen([binary, "serve"], env=env, stdout=self.logs, stderr=self.logs)
        for _ in range(100):
            if cancel.wait(0.1):
                raise InterruptedError("Setup cancelled.")
            if self.status(probe=True)["ollama_reachable"]:
                return
            if self.process.poll() is not None:
                break
        raise RuntimeError("The managed Ollama service could not start. Direct inference is available instead.")

    def _pull(self, progress, cancel):
        request = urllib.request.Request(self.store.embedder.url + "/api/pull",
            data=json.dumps({"model": self.store.embedder.model, "stream": True}).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=120) as response:
            for line in response:
                if cancel.is_set():
                    raise InterruptedError("Model setup cancelled.")
                value = json.loads(line)
                if value.get("error"):
                    raise RuntimeError(value["error"])
                message = value.get('status', '')
                phase = 'downloading' if value.get('total') else 'verifying' if 'verifying' in message.lower() else 'installing'
                progress({"phase": phase, "path": "Ollama: " + message,
                          "downloaded": value.get("completed", 0), "download_total": value.get("total", 0)})

    def _select(self, provider):
        temporary = self.directory / "runtime.partial"
        temporary.write_text(json.dumps({"model": self.store.embedder.model, "provider": provider}))
        os.replace(temporary, self.directory / "runtime.json")
        self.store.apply_preferences()

    def prepare(self, choice=None, progress=None, cancel=None):
        progress = progress or (lambda state: None)
        cancel = cancel or threading.Event()
        from .core import Embedder
        from .locking import writer_lock
        if choice is not None:
            self.store.save_preferences({"embedding_backend": choice})
        prefs = self.store.apply_preferences()
        selected_model = self.store.embedder.model
        native = NativeModel(self.directory, prefs["cpu_threads"], full=self.store.embedder.model in FULL_MODELS)
        if choice not in {None, "direct", "ollama"}:
            raise ValueError("Unknown model setup choice.")
        with writer_lock(self.directory / "model-setup.lock"), writer_lock(self.directory / "writer.lock"):
            if choice == "direct" or (choice is None and prefs["embedding_backend"] == "direct") or (choice is None and prefs["embedding_backend"] == "auto" and native.ready() and self.store.embedder.provider == "direct" and self.store.embedder.model in DIRECT_MODELS):
                provider = "direct"
            else:
                state = self.status(probe=True)
                if state["needs_install_consent"] and choice is None:
                    raise SetupConsentRequired("Ollama is not installed. Choose installation or direct EmbeddingGemma 2 inference.")
                provider = "ollama"
                try:
                    if not state["ollama_installed"]:
                        if choice != "ollama":
                            raise SetupConsentRequired("Ollama installation requires your approval.")
                        self.install_ollama(progress, cancel)
                    if not state["ollama_reachable"]:
                        self._start_ollama(cancel)
                    progress({"phase": "checking", "path": "Checking the selected Ollama embedding model"})
                    probe = Embedder(self.store.embedder.model, self.store.embedder.url)
                    probe.options = self.store.embedder.options
                    try:
                        probe.embed(["title: fs | text: file search"])
                    except RuntimeError as exc:
                        if "MLX" in str(exc):
                            raise
                        self._pull(progress, cancel)
                        probe.embed(["title: fs | text: file search"])
                except SetupConsentRequired:
                    raise
                except InterruptedError:
                    raise
                except (RuntimeError, OSError) as exc:
                    if self.store.embedder.model not in DIRECT_MODELS:
                        raise
                    provider = "direct"
                    progress({"phase": "checking", "path": "Ollama is incompatible; preparing the same EmbeddingGemma 2 model directly", "runtime_warning": str(exc)[:500]})
            if provider == "direct":
                if self.store.embedder.model not in DIRECT_MODELS:
                    raise RuntimeError('Select embeddinggemma-2:740m for full direct multimodal inference, or embeddinggemma-2:270m for text-only direct inference.')
                if not native.ready():
                    native.prepare(progress, cancel)
                progress({"phase": "checking", "path": "Verifying direct EmbeddingGemma 2 CPU inference"})
                native.embed(["title: fs | text: file search"])
                native.verify_media(progress, cancel)
                self.store.embedder.native = native
            if cancel.is_set():
                raise InterruptedError("Model setup cancelled.")
            self.store.apply_preferences()
            if self.store.embedder.model != selected_model:
                raise RuntimeError('Model preference changed during setup. Retry for the new selection.')
            self._select(provider)
            return {"provider": provider, "model": self.store.embedder.model, "ready": True}

    def close(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self.logs:
            self.logs.close()
