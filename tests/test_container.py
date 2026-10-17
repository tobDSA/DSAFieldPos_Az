import base64
import importlib
import io
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import unittest
from unittest.mock import patch

SANDBOX = tempfile.TemporaryDirectory()
os.environ['FIELDPOS_DATA_DIR'] = SANDBOX.name
for role in ('USER', 'ADMIN'):
    os.environ[f'FIELDPOS_{role}_USERNAME'] = role.lower()
    os.environ[f'FIELDPOS_{role}_PASSWORD'] = secrets.token_urlsafe(24)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import runtime
from container_server import Application


class ContainerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = Application()
        cls.app.backend.CLIENTS_DIR.mkdir(parents=True, exist_ok=True)

    def request(self, path, role='USER', query='', **extra):
        env = {'PATH_INFO': path, 'QUERY_STRING': query, 'REQUEST_METHOD': 'GET'}
        if role:
            raw = f"{os.environ[f'FIELDPOS_{role}_USERNAME']}:{os.environ[f'FIELDPOS_{role}_PASSWORD']}".encode()
            env['HTTP_AUTHORIZATION'] = 'Basic ' + base64.b64encode(raw).decode()
        env.update(extra)
        result = {}
        body = b''.join(self.app(env, lambda status, headers: result.update(status=status, headers=headers)))
        return int(result['status'].split()[0]), body

    def test_open_access_without_environment(self):
        with patch.dict(os.environ):
            for key in list(os.environ):
                if key.startswith(('FIELDPOS_USER_', 'FIELDPOS_ADMIN_')):
                    os.environ.pop(key)
            application = Application()
        result = {}
        body = b''.join(application({'PATH_INFO': '/api/access', 'REQUEST_METHOD': 'GET'},
                                   lambda status, headers: result.update(status=status, headers=headers)))
        self.assertEqual(result['status'], '200 OK')
        self.assertTrue(json.loads(body)['admin'])
        self.assertFalse(any(key.lower() == 'www-authenticate' for key, _ in result['headers']))

    def test_health_and_auth(self):
        self.assertEqual(self.request('/health', None)[0], 200)
        self.assertEqual(self.request('/', None)[0], 200)
        self.assertEqual(self.request('/')[0], 200)
        self.assertEqual(self.request('/fieldpos.js')[0], 200)

    def test_mobile_route_and_assets(self):
        self.assertEqual(self.request('/mobile', None)[0], 200)
        for path in ('/mobile', '/mobile/'):
            code, body = self.request(path)
            self.assertEqual(code, 200)
            self.assertIn(b'<base href="/">', body)
            self.assertIn(b'class="mobile-view"', body)
            self.assertIn(b'<h1>DSA FieldPos Mobile</h1>', body)
            self.assertNotIn(b'<script src="03_kommuner_demografi.js', body)
        for path in ('/mobile/dosimeter', '/mobile/dosimeter/'):
            self.assertEqual(self.request(path, None)[0], 200)
            code, body = self.request(path)
            self.assertEqual(code, 200)
            self.assertIn(b'<base href="/">', body)
            self.assertIn(b'LCGT-01', body)
        for path in ('/mobile.css', '/mobile.js', '/07_dosimeter_lcars.html'):
            self.assertEqual(self.request(path)[0], 200)

    def test_embedded_instrument_and_measurement_navigation(self):
        code, embedded = self.request('/mobile/dosimeter', query='embedded=1')
        self.assertEqual(code, 200)
        self.assertIn(b'<body class="instrument-embedded">', embedded)
        self.assertIn(b'href="/mobile?view=measure-a"', embedded)
        self.assertIn(b'class="instrument-map-link" href="/mobile"', embedded)
        self.assertIn(b'disabled>LOGG</button>', embedded)
        self.assertIn(b'disabled>NEXUS<br />ONLINE</button>', embedded)
        code, standalone = self.request('/mobile/dosimeter')
        self.assertEqual(code, 200)
        self.assertNotIn(b'<body class="instrument-embedded">', standalone)
        self.assertEqual(self.request('/mobile', query='view=measure-a')[0], 200)

    def test_legacy_instrument_addresses_redirect(self):
        for path in ('/mobile/geigerteller', '/mobile/geigerteller/', '/07_geiger_lcars.html'):
            result = {}
            body = b''.join(self.app({'PATH_INFO': path, 'REQUEST_METHOD': 'GET'},
                                   lambda status, headers: result.update(status=status, headers=dict(headers))))
            self.assertEqual(result['status'], '308 Permanent Redirect')
            self.assertEqual(result['headers']['Location'], '/mobile/dosimeter')
            self.assertEqual(body, b'')

    def test_private_files_and_cross_site(self):
        for path in ('/config/DSAFieldPos.json', '/2G_fieldpos_server.py', '/data/online2/fieldpos_measurements.jsonl'):
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request('/api/measurements/clear')[0], 200)
        self.assertEqual(self.request('/api/my-position/presence', HTTP_SEC_FETCH_SITE='cross-site')[0], 403)

    def test_persistence_and_admin(self):
        code, body = self.request('/api/my-position/presence', query='clientId=test&presence=1&lat=60&lon=10')
        self.assertEqual(code, 200, body)
        self.assertTrue((runtime.DATA_DIR / 'online2/2g_presence_clients.json').exists())
        self.assertEqual(self.request('/api/report-settings', query='email=x')[0], 200)
        self.assertEqual(self.request('/api/measurements/clear', 'ADMIN')[0], 200)

    def test_configuration_failures_and_fallback(self):
        path = runtime.DATA_DIR / 'config-test.json'
        fallback = runtime.FALLBACK_PATH.read_bytes()
        with self.assertLogs(level='WARNING'):
            self.assertEqual(runtime.load_configuration(path)['schemaVersion'], 1)
        path.write_text('{invalid')
        with self.assertRaises(ValueError):
            runtime.load_configuration(path)
        with patch.object(runtime, 'read_object', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                runtime.load_configuration(path)
        self.assertEqual(runtime.FALLBACK_PATH.read_bytes(), fallback)

    def test_config_never_written_and_state_separate(self):
        with self.assertRaises(ValueError):
            runtime.atomic_json(runtime.CONFIG_PATH, {})
        with self.assertRaises(ValueError):
            runtime.atomic_json(runtime.DATA_DIR / 'config/other.json', {})
        runtime.save_wind_settings({'gridStepKm': 12, 'outputPath': '/bad'})
        self.assertEqual(runtime.effective_wind_config()['gridStepKm'], 12)
        self.assertNotEqual(runtime.effective_wind_config()['outputPath'], '/bad')
        self.assertFalse(runtime.CONFIG_PATH.exists())


if __name__ == '__main__':
    unittest.main()
