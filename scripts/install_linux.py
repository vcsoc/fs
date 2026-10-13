"""Install an existing standalone build for the current user, without sudo."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
source = root / "dist/linux-unpacked"
version = json.loads((root / "package.json").read_text())["version"]
home = Path.home()
base = home / ".local/opt/fs"
release = base / "releases" / version
bin_dir = home / ".local/bin"
data = Path(os.environ.get("XDG_DATA_HOME", home / ".local/share"))
launcher = data / "applications/fs.desktop"
command = bin_dir / "fs"

for required in [source / "fs", source / "resources/backend/fs-service"]:
    if not required.is_file():
        raise SystemExit(f"Missing standalone build: {required}. Run the backend build and npm run pack first.")
for destination in [release, command, launcher]:
    if destination.exists() or destination.is_symlink():
        raise SystemExit(f"Refusing to overwrite existing installation: {destination}")

base.mkdir(parents=True, exist_ok=True)
(release.parent).mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="install-", dir=base) as temporary:
    staged = Path(temporary) / "application"
    # Copy only the packaged allowlist, never the source checkout or vault.
    shutil.copytree(source, staged, symlinks=True)
    os.replace(staged, release)
current = base / "current"
if current.exists() or current.is_symlink():
    raise SystemExit(f"Refusing to replace an existing current link: {current}")
current.symlink_to(release, target_is_directory=True)
bin_dir.mkdir(parents=True, exist_ok=True)
command.write_text("#!/bin/sh\n" +
    "# Standalone fs; no Python, Node, or source checkout needed.\n" +
    f"application={shlex.quote(str(current))}\n" +
    'if [ "${1:-}" = "desktop" ]; then\n  shift\n  exec "$application/fs" "$@"\nfi\n' +
    'exec "$application/resources/backend/fs-service" "$@"\n')
command.chmod(0o755)
icon = data / "icons/hicolor/512x512/apps/fs.png"
icon.parent.mkdir(parents=True, exist_ok=True)
if icon.exists():
    raise SystemExit(f"Refusing to overwrite an existing icon: {icon}")
shutil.copy2(root / "desktop/icon.png", icon)
launcher.parent.mkdir(parents=True, exist_ok=True)
# Desktop-entry quoting is not shell quoting.
executable = str(current / "fs").replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$").replace("%", "%%")
launcher.write_text(
    "[Desktop Entry]\nType=Application\nName=fs\nGenericName=File Search\n"
    "Comment=Local semantic, content, filename, date and regex file search\n"
    f'Exec="{executable}"\nIcon=fs\nTerminal=false\nCategories=Utility;FileTools;\n'
    "Keywords=files;search;semantic;embedding;\nStartupNotify=true\n"
)
for tool, arguments in [("desktop-file-validate", [str(launcher)]), ("update-desktop-database", [str(launcher.parent)])]:
    if shutil.which(tool):
        subprocess.run([tool, *arguments], check=True)
print(json.dumps({"cli": str(command), "desktop_entry": str(launcher), "application": str(current), "release": str(release)}, indent=2))
