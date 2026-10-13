"""True filesystem birth times without mislabeling Unix ctime."""
import ctypes
from functools import lru_cache
import os
import struct
import sys


@lru_cache(maxsize=1)
def _libc():
    library = ctypes.CDLL(None, use_errno=True)
    function = getattr(library, "statx", None)
    if function is not None:
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
        function.restype = ctypes.c_int
    return function


def birth_time(path, stat):
    existing = getattr(stat, "st_birthtime", None)
    if existing is not None:
        return existing
    if sys.platform.startswith("linux"):
        function = _libc()
        if function is None:
            return None
        buffer = ctypes.create_string_buffer(256)
        # statx has a stable 256-byte kernel ABI; btime begins at byte 80.
        if function(-100, os.fsencode(path), 0x100, 0x800, buffer) == 0:
            if struct.unpack_from("I", buffer.raw)[0] & 0x800:
                seconds, nanoseconds = struct.unpack_from("qI", buffer.raw, 80)
                return seconds + nanoseconds / 1_000_000_000
        return None
    if os.name == "nt":
        from ctypes import wintypes
        class Attributes(ctypes.Structure):
            _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME),
                        ("accessed", wintypes.FILETIME), ("modified", wintypes.FILETIME),
                        ("size_high", wintypes.DWORD), ("size_low", wintypes.DWORD)]
        attributes = Attributes()
        function = ctypes.windll.kernel32.GetFileAttributesExW
        function.argtypes = [wintypes.LPCWSTR, ctypes.c_int, ctypes.POINTER(Attributes)]
        function.restype = wintypes.BOOL
        if function(str(path), 0, ctypes.byref(attributes)):
            ticks = attributes.created.dwLowDateTime | (attributes.created.dwHighDateTime << 32)
            return ticks / 10_000_000 - 11_644_473_600
    return None
