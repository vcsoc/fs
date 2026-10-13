from __future__ import annotations

import re

DEFAULTS = {
    "theme": "dark",
    "accuracy": 0.68,
    "result_layout": "list",
    "model": "embeddinggemma-2:740m",
    "embedding_backend": "direct",
    "cpu_threads": 2,
    "file_workers": 2,
    "scan_duty_percent": 25,
    "worker_memory_mb": 2048,
    "max_file_mb": 8,
    "max_chunks": 64,
    "use_gpu": False,
}
LIMITS = {
    "cpu_threads": (1, 64),
    "file_workers": (1, 64),
    "scan_duty_percent": (5, 100),
    "worker_memory_mb": (256, 65536),
    "max_file_mb": (0, 1048576),
    "max_chunks": (1, 256),
}


def worker_layout(prefs, full=False):
    # Reserve shared model memory, then bound per-file buffers and native threads.
    reserve = 768 if full else 256
    slots = max(1, (prefs['worker_memory_mb'] - reserve) // 512)
    workers = min(prefs['file_workers'], prefs['cpu_threads'], slots)
    return workers, max(1, prefs['cpu_threads'] // workers)


def validate(values):
    if not isinstance(values, dict) or set(values) - set(DEFAULTS):
        raise ValueError("Unknown preference.")
    result = {**DEFAULTS, **values}
    if not isinstance(result["model"], str) or not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,128}", result["model"]):
        raise ValueError("Enter a valid Ollama model name.")
    if result["embedding_backend"] not in {"auto", "direct", "ollama"}:
        raise ValueError("Embedding backend must be auto, direct, or ollama.")
    if type(result['accuracy']) not in (int, float) or not 0 <= result['accuracy'] <= 1:
        raise ValueError('Accuracy must be between 0 and 1.')
    if result['result_layout'] not in {'list', 'hybrid', 'grid'}:
        raise ValueError('Unknown result layout.')
    if result["theme"] not in {"dark", "light"}:
        raise ValueError("Theme must be dark or light.")
    if type(result["use_gpu"]) is not bool:
        raise ValueError("GPU preference must be true or false.")
    for key, (low, high) in LIMITS.items():
        value = result[key]
        if type(value) is not int or not low <= value <= high:
            raise ValueError(f"{key} must be an integer from {low} to {high}.")
    return result
