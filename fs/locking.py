from contextlib import contextmanager
from functools import partial
import os


@contextmanager
def writer_lock(path):
    """OS-managed lock: serializes CLI/desktop writes and releases on process exit."""
    with open(path, "a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0, 2)
            if not handle.tell():
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            acquire = partial(msvcrt.locking, handle.fileno(), msvcrt.LK_NBLCK, 1)
            release = partial(msvcrt.locking, handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            acquire = partial(fcntl.flock, handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            release = partial(fcntl.flock, handle, fcntl.LOCK_UN)
        try:
            acquire()
        except OSError as exc:
            raise RuntimeError("Another fs process is updating this index.") from exc
        try:
            yield
        finally:
            handle.seek(0)
            release()
