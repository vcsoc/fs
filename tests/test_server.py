import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest

from fs.core import Store


@pytest.fixture
def server(tmp_path):
    root = tmp_path / "docs"
    root.mkdir()
    (root / "sample.txt").write_text("unique searchable sentence")
    store = Store(tmp_path / "db")
    store.index(root, semantic=False)
    process = subprocess.Popen([sys.executable, "-m", "fs", "--data-dir", str(store.directory), "serve"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        url = json.loads(process.stdout.readline())["url"]
        html = urllib.request.urlopen(url, timeout=5).read().decode()
        token = re.search(r'name="fs-token" content="([^"]+)"', html)[1]
        yield url, token
    finally:
        process.terminate()
        process.wait(timeout=5)


def request(server, endpoint, body=None, authorized=True, origin=None):
    url, token = server
    headers = {"Content-Type": "application/json"}
    if authorized:
        headers["Authorization"] = "Bearer " + token
    if origin:
        headers["Origin"] = origin
    req = urllib.request.Request(url + "/api/" + endpoint, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    return urllib.request.urlopen(req, timeout=5)


def test_api_and_security(server):
    assert json.load(request(server, "status"))["files"] == 1
    found = json.load(request(server, "search", {"query": "unique", "mode": "text"}))
    assert found["results"][0]["name"] == "sample.txt"
    for authorized, origin in [(False, None), (True, "https://evil.example")]:
        with pytest.raises(urllib.error.HTTPError) as exc:
            request(server, "search", {"query": "unique"}, authorized=authorized, origin=origin)
        assert exc.value.code == 403
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(server, "search", {"query": "[", "mode": "regex"})
    assert exc.value.code == 400
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(server, "open", {"id": -1})
    assert exc.value.code == 400
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(server, 'source/open', {'root': '/unregistered'})
    assert exc.value.code == 400


def test_preferences_and_async_index(server):
    saved = json.load(request(server, "preferences", {"theme": "light", "cpu_threads": 1, "max_file_mb": 0}))
    assert saved["theme"] == "light" and saved["max_file_mb"] == 0
    status = json.load(request(server, "status"))
    root = status["roots"][0]["root"]
    started = json.load(request(server, "index", {"root": root, "semantic": False}))
    assert started["started"]
    # The service stays responsive while a separately budgeted worker runs.
    for _ in range(100):
        status = json.load(request(server, "status"))
        if status["job"]["state"] == "complete":
            break
        assert status["job"]["state"] != "error", status["job"]
        time.sleep(0.05)
    assert status["job"]["state"] == "complete"
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(server, "preferences", {"cpu_threads": 0})
    assert exc.value.code == 400


def test_viewer_favourites_and_media_security(server):
    found = json.load(request(server, 'search', {'query': 'unique', 'mode': 'text'}))['results'][0]
    preview = json.load(request(server, 'preview', {'id': found['id'], 'query': 'unique', 'mode': 'text'}))
    assert preview['matches'][0]['start'] == 0
    assert preview['text'].startswith('unique')
    assert 'Bearer' not in preview['media_url']
    assert json.load(request(server, 'favourites', {'action': 'add', 'ids': [found['id']]}))[0]['id'] == found['id']
    assert len(json.load(request(server, 'favourites'))) == 1
    url, _ = server
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(url + '/media/' + str(found['id']) + '/file?expires=9999999999&signature=invalid')
    assert error.value.code == 403
    with pytest.raises(urllib.error.HTTPError) as error:
        request(server, 'preview', {'id': found['id']}, authorized=False)
    assert error.value.code == 403


def test_media_range_and_thumbnail(server):
    from pathlib import Path
    from PIL import Image
    root = Path(json.load(request(server, 'status'))['roots'][0]['root'])
    picture = root / 'sample.png'
    Image.new('RGB', (80, 50), 'blue').save(picture)
    request(server, 'preferences', {'scan_duty_percent': 100})
    request(server, 'index', {'root': str(root), 'semantic': False})
    for _ in range(100):
        state = json.load(request(server, 'status'))['job']['state']
        if state == 'complete':
            break
        assert state != 'error'
        time.sleep(0.03)
    file = json.load(request(server, 'search', {'file_type': 'image'}))['results'][0]
    url, _ = server
    with urllib.request.urlopen(urllib.request.Request(url + file['media_url'], headers={'Range': 'bytes=0-7'})) as response:
        assert response.status == 206
        assert response.read() == picture.read_bytes()[:8]
        assert response.headers['Content-Range'].startswith('bytes 0-7/')
    with urllib.request.urlopen(url + file['thumbnail_url']) as response:
        assert response.headers['Content-Type'] == 'image/jpeg'
        assert response.read().startswith(b'\xff\xd8')
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(urllib.request.Request(url + file['media_url'], headers={'Range': 'bytes=999999-'}))
    assert error.value.code == 416


def test_static_assets_and_csp(server):
    url, _ = server
    for asset in ["/", "/app.js", "/style.css", "/icon.svg", "/fonts/JetBrainsMono-Regular.ttf"]:
        with urllib.request.urlopen(url + asset, timeout=5) as response:
            assert response.status == 200
            assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
    with pytest.raises(urllib.error.HTTPError):
        urllib.request.urlopen(url + "/../core.py", timeout=5)
