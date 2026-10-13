import json
import subprocess
import sys

from fs.core import Store


def test_worker_cancels_when_parent_control_pipe_closes(tmp_path):
    root = tmp_path / 'files'
    root.mkdir()
    (root / 'one.txt').write_text('one')
    store = Store(tmp_path / 'db')
    command = [sys.executable, '-m', 'fs.worker', '--data-dir', str(store.directory), '--model', 'embeddinggemma-2:740m', '--ollama-url', 'http://127.0.0.1:11434', '--no-semantic', str(root)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    process.stdin.close()
    process.stdin = None
    output, error = process.communicate(timeout=15)
    assert process.returncode == 0, error
    assert json.loads(output.splitlines()[-1])['state'] == 'cancelled'
    assert store.status()['files'] == 0
