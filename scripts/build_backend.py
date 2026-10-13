"""Build on each target OS; PyInstaller binaries are not cross-compiled."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
subprocess.run([
    sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "fs-service", "--distpath", str(root / "build/backend"),
    "--workpath", str(root / "build/pyinstaller"), "--specpath", str(root / "build"),
    "--paths", str(root), "--collect-all", "numpy", "--collect-all", "pypdf",
    "--collect-all", "docx", "--collect-all", "regex", "--collect-all", "onnxruntime",
    "--collect-all", "tokenizers", "--collect-all", "zstandard", "--collect-all", "PIL", '--collect-all', 'pillow_heif',
    '--collect-all', 'pypdfium2', '--collect-all', 'pypdfium2_raw',
    '--collect-all', 'imageio_ffmpeg', '--copy-metadata', 'imageio-ffmpeg',
    '--collect-data', 'transformers', '--recursive-copy-metadata', 'transformers',
    '--hidden-import', 'transformers.models.gemma4.feature_extraction_gemma4',
    "--add-data", f"{root / 'fs/web'}{os.pathsep}fs/web",
    str(root / "scripts/service_entry.py"),
], cwd=root, check=True)
