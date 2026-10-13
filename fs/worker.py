"""Isolated indexing worker; set budgets before importing numerical libraries."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import threading
from pathlib import Path

from .preferences import validate, worker_layout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--ollama-url", required=True)
    parser.add_argument("--no-semantic", action="store_true")
    parser.add_argument("root")
    args = parser.parse_args()
    with sqlite3.connect(Path(args.data_dir) / "index.sqlite3") as db:
        row = db.execute("SELECT value FROM meta WHERE key='preferences'").fetchone()
    prefs = validate(json.loads(row[0]) if row else {})
    _, inference_threads = worker_layout(prefs, args.model in {'embeddinggemma-2', 'embeddinggemma-2:latest', 'embeddinggemma-2:740m'})
    # Divide the CPU budget across slots rather than granting it to every file.
    for key in ["OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"]:
        os.environ[key] = str(inference_threads)
    os.environ["RAYON_NUM_THREADS"] = str(inference_threads)
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    ceiling = prefs["worker_memory_mb"] * 1024 * 1024
    if os.name == "posix":
        import resource
        try:
            os.nice(15)
        except OSError:
            pass
        if sys.platform != "darwin":
            _, hard = resource.getrlimit(resource.RLIMIT_AS)
            resource.setrlimit(resource.RLIMIT_AS, (min(ceiling, hard) if hard != resource.RLIM_INFINITY else ceiling, hard))
        # Disk I/O also yields to interactive work when Linux supports ioprio.
        if sys.platform.startswith("linux"):
            import ctypes
            import platform
            syscall = {"x86_64": 251, "aarch64": 30}.get(platform.machine())
            if syscall:
                ctypes.CDLL(None).syscall(syscall, 1, 0, 3 << 13)
    else:
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.windll.kernel32
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x00004000)
    cancel = threading.Event()
    finished = threading.Event()

    def control():
        for line in sys.stdin:
            if line.strip() == "cancel":
                cancel.set()
                break
        # EOF means the parent app exited; do not leave an orphan holding
        # the index lock and continuing expensive media analysis.
        cancel.set()
        if not finished.wait(2):
            # Parent loss must also stop blocked decoder calls, not merely
            # wait for the next file/chunk cancellation checkpoint.
            try:
                import psutil
                for child in psutil.Process().children(recursive=True):
                    try:
                        child.kill()
                    except psutil.Error:
                        pass
            finally:
                os._exit(0)
    threading.Thread(target=control, daemon=True).start()

    output_lock = threading.Lock()
    def emit(payload):
        with output_lock:
            print(json.dumps(payload), flush=True)

    import psutil
    process = psutil.Process()
    def rss_bytes():
        total = process.memory_info().rss
        for child in process.children(recursive=True):
            try:
                total += child.memory_info().rss
            except psutil.NoSuchProcess:
                pass
        return total

    def memory_watch():
        while not cancel.wait(0.25):
            try:
                if rss_bytes() > ceiling:
                    emit({"state": "error", "error": "Indexing stopped at the worker memory budget. Increase it in Preferences, or reduce file/chunk limits. Completed files remain saved."})
                    for child in process.children(recursive=True):
                        try:
                            child.kill()
                        except psutil.Error:
                            pass
                    os._exit(75)
            except (OSError, psutil.Error):
                pass
    threading.Thread(target=memory_watch, daemon=True).start()
    try:
        from .core import Embedder, Store
        store = Store(args.data_dir, Embedder(args.model, args.ollama_url))
        result = {'cancelled': True} if cancel.is_set() else store.index(args.root, semantic=not args.no_semantic, progress=lambda state: emit({**state, 'resource_enforcement': os.environ.get('FS_WORKER_ENFORCEMENT', 'thread budgets + aggregate RSS watchdog'), "state": "running"}), cancel=cancel)
        result['cancelled'] = result['cancelled'] or cancel.is_set()
        emit({**result, 'resource_enforcement': os.environ.get('FS_WORKER_ENFORCEMENT', 'thread budgets + aggregate RSS watchdog'), "state": "cancelled" if result["cancelled"] else "complete"})
        return 0
    except Exception as exc:
        message = "Worker memory ceiling reached. Increase it in Preferences or reduce extraction limits." if isinstance(exc, MemoryError) else str(exc)
        emit({"state": "error", "error": message})
        return 1
    finally:
        finished.set()


if __name__ == "__main__":
    raise SystemExit(main())
