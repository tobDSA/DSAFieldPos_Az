"""Run inside the image with writable /data and /tmp only; no real secrets."""
import base64
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import time
import urllib.error
import urllib.request

assert os.getuid() == 10001
for role in ('USER', 'ADMIN'):
    os.environ[f'FIELDPOS_{role}_USERNAME'] = role.lower()
    os.environ[f'FIELDPOS_{role}_PASSWORD'] = secrets.token_urlsafe(32)
config = Path('/data/DSAFieldPos_Az/config/DSAFieldPos.json')
base = 'http://127.0.0.1:8030'


def request(path, authenticated=True):
    req = urllib.request.Request(base + path)
    if authenticated:
        credentials = ('user:' + os.environ['FIELDPOS_USER_PASSWORD']).encode()
        req.add_header('Authorization', 'Basic ' + base64.b64encode(credentials).decode())
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def start():
    proc = subprocess.Popen(['python', '/app/container_server.py'])
    for _ in range(100):
        if proc.poll() is not None:
            raise AssertionError(f'Server exited: {proc.returncode}')
        try:
            if request('/health', False)[0] == 200:
                return proc
        except OSError:
            pass
        time.sleep(.1)
    proc.kill()
    raise AssertionError('Server did not become ready')


def stop(proc):
    proc.send_signal(signal.SIGTERM)
    assert proc.wait(timeout=20) == 0


proc = start()
try:
    assert request('/')[0] == 200
    assert request('/', False)[0] == 401
    assert request('/config/DSAFieldPos.json')[0] == 404
    def position(i):
        return request(f'/api/my-position/presence?clientId=smoke-{i}&presence=1&lat=60&lon=10')[0]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(position, range(20))) == [200] * 20
    saved = json.loads(Path('/data/DSAFieldPos_Az/online2/2g_presence_clients.json').read_text())
    assert len(saved['clients']) == 20
    assert not config.exists(), 'Fallback must never be copied to share'
finally:
    stop(proc)
proc = start()
try:
    assert len(json.loads(request('/api/my-position/presence')[1])['activeClients']) == 20
finally:
    stop(proc)
config.parent.mkdir(parents=True)
config.write_bytes(Path('/app/defaults/DSAFieldPos.json').read_bytes())
digest = hashlib.sha256(config.read_bytes()).hexdigest()
proc = start()
try:
    assert request('/')[0] == 200
finally:
    stop(proc)
assert hashlib.sha256(config.read_bytes()).hexdigest() == digest
config.write_text('{broken')
assert subprocess.run(['python', '/app/container_server.py'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode != 0
config.write_bytes(Path('/app/defaults/DSAFieldPos.json').read_bytes())
config.chmod(0)
try:
    assert subprocess.run(['python', '/app/container_server.py'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode != 0
finally:
    config.chmod(0o600)
print('PASS: UID 10001, read-only image, HTTP, auth, 20 concurrent writes, restart persistence, SIGTERM, immutable config, invalid and unreadable config')
