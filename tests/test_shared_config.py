import json
import subprocess
import sys

from fs.core import Store
from fs.preferences import DEFAULTS


def test_cli_and_running_desktop_store_share_preferences(tmp_path):
    desktop = Store(tmp_path / 'db')
    desktop.save_preferences({'accuracy': 0.71, 'result_layout': 'hybrid', 'cpu_threads': 3})
    command = [sys.executable, '-m', 'fs', '--data-dir', str(desktop.directory), 'preferences']
    saved = json.loads(subprocess.check_output(command, text=True))
    assert saved['accuracy'] == 0.71 and saved['result_layout'] == 'hybrid'
    subprocess.check_output(command + ['--accuracy', '0.62', '--model', 'embeddinggemma-2:270m'], text=True)
    assert desktop.status()['model'] == 'embeddinggemma-2:270m'
    assert desktop.status()['preferences']['accuracy'] == 0.62
    assert desktop.status()['preferences']['result_layout'] == 'hybrid'
    desktop.save_preferences({'result_layout': 'grid'})
    assert desktop.status()['preferences']['result_layout'] == 'grid'
    assert desktop.preferences()['accuracy'] == 0.62
    assert desktop.preferences()['cpu_threads'] == 3
    assert DEFAULTS['accuracy'] == 0.68
    with desktop.connect() as db:
        legacy = json.loads(desktop._meta(db, 'preferences'))
        assert 'accuracy' not in legacy and 'result_layout' not in legacy
