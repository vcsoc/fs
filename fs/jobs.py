from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading

from .resource_limits import budget_command, terminate_tree


def run_index(store, root, semantic=True, progress=None, cancel=None):
    """Run expensive extraction and embedding in a separately budgeted process."""
    cancel = cancel or threading.Event()
    progress = progress or (lambda state: None)
    command = [sys.executable] + (["--worker"] if getattr(sys, "frozen", False) else ["-m", "fs.worker"]) + ["--data-dir", str(store.directory.resolve()), "--model", store.embedder.model, "--ollama-url", store.embedder.url]
    if not semantic:
        command.append("--no-semantic")
    command.append(str(root))
    done = threading.Event()
    with tempfile.TemporaryDirectory(prefix="worker-", dir=store.directory) as workspace, tempfile.TemporaryFile(mode="w+") as errors:
        command, env, unit = budget_command(command, store.preferences(), {**os.environ, 'FS_WORKER_TMP': workspace})
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True,
                                   env=env, start_new_session=os.name == "posix")
        def control():
            while not done.wait(0.1):
                if cancel.is_set():
                    try:
                        process.stdin.write("cancel\n")
                        process.stdin.flush()
                    except (BrokenPipeError, OSError, ValueError):
                        pass
                    if not done.wait(2):
                        terminate_tree(process, unit)
                    break
        threading.Thread(target=control, daemon=True).start()
        last = {}
        try:
            for line in process.stdout:
                last = json.loads(line)
                progress(dict(last))
            code = process.wait()
            if cancel.is_set():
                return {**last, "cancelled": True, "state": "cancelled"}
            if code or last.get("state") != "complete":
                errors.seek(0)
                detail = errors.read()[-1500:]
                raise RuntimeError(last.get("error") or f"Index worker stopped ({code}). Check its memory budget in Preferences. {detail}")
            return last
        except BaseException:
            terminate_tree(process, unit)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise
        finally:
            done.set()
            process.stdout.close()
            process.stdin.close()
