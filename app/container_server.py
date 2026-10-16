"""WSGI gateway for the existing FieldPos handlers; one process, bounded threads."""
import base64
import binascii
import hmac
import importlib.util
import io
import logging
import os
import re
import signal
import threading

from runtime import DATA_DIR, DATA_LOCK, ROOT, STOP, effective_wind_config


def load_server():
    spec = importlib.util.spec_from_file_location('fieldpos', ROOT / '2G_fieldpos_server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Application:
    def __init__(self):
        self.credentials = []
        for role in ('USER', 'ADMIN'):
            username = os.environ.get(f'FIELDPOS_{role}_USERNAME', '')
            password = os.environ.get(f'FIELDPOS_{role}_PASSWORD', '')
            if not username or not password or ':' in username:
                raise ValueError(f'Configure FIELDPOS_{role}_USERNAME and FIELDPOS_{role}_PASSWORD secrets')
            self.credentials.append((f'{username}:{password}'.encode(), role == 'ADMIN'))
        if self.credentials[0][0].split(b':')[0] == self.credentials[1][0].split(b':')[0]:
            raise ValueError('User and admin must have distinct usernames')
        effective_wind_config()  # Validate persisted user settings before accepting requests.
        self.backend = load_server()
        self.handler = self.backend.create_handler()

    def __call__(self, environ, start_response):
        path = environ.get('PATH_INFO', '/')
        if path == '/health' and environ['REQUEST_METHOD'] in ('GET', 'HEAD'):
            start_response('200 OK', [('Content-Type', 'application/json')])
            return [b'' if environ['REQUEST_METHOD'] == 'HEAD' else b'{"ok":true}']
        supplied = environ.get('HTTP_AUTHORIZATION', '')
        decoded = b''
        if supplied.startswith('Basic '):
            try:
                decoded = base64.b64decode(supplied[6:], validate=True)
            except (ValueError, binascii.Error):
                pass
        matched = [admin for expected, admin in self.credentials if hmac.compare_digest(decoded, expected)]
        if not matched:
            start_response('401 Unauthorized', [('WWW-Authenticate', 'Basic realm="DSAFieldPos", charset="UTF-8"'), ('Content-Type', 'text/plain')])
            return [b'Authentication required']
        if environ['REQUEST_METHOD'] != 'GET':
            start_response('405 Method Not Allowed', [('Allow', 'GET'), ('Content-Type', 'text/plain')])
            return [b'Method not supported']
        if environ.get('HTTP_SEC_FETCH_SITE') == 'cross-site':
            start_response('403 Forbidden', [('Content-Type', 'text/plain')])
            return [b'Cross-site requests are disabled']
        if path == '/api/access':
            start_response('200 OK', [('Content-Type', 'application/json')])
            return [b'{"admin":true}' if matched[0] else b'{"admin":false}']
        if path in ('/mobile', '/mobile/'):
            html = (ROOT / 'static/index.html').read_text(encoding='utf-8')
            html = html.replace('<head>', '<head>\n  <base href="/">')
            html = html.replace('</head>', '<link rel="stylesheet" href="/mobile.css?v=1">\n<script src="/mobile.js?v=1" defer></script>\n</head>')
            html = html.replace('<body>', '<body class="mobile-view">')
            # Mobile omits heavy optional overlays and their startup downloads.
            html = re.sub(r'  <script src="0[1-6]_[^\"]+"></script>\n', '', html)
            body = html.encode('utf-8')
            start_response('200 OK', [('Content-Type', 'text/html; charset=utf-8'), ('Cache-Control', 'no-store'), ('Content-Length', str(len(body)))])
            return [body]
        handler = self.handler.__new__(self.handler)
        handler.path = path + ('?' + environ['QUERY_STRING'] if environ.get('QUERY_STRING') else '')
        handler.command = 'GET'
        handler.request_version = 'HTTP/1.1'
        handler.directory = str(ROOT / 'static')
        handler.headers = {}
        handler.wfile = io.BytesIO()
        handler.is_admin = matched[0]
        response = {'status': '200 OK', 'headers': []}
        handler.send_response = lambda code, message=None: response.update(status=f'{code} {message or __import__("http").HTTPStatus(code).phrase}')
        def send_header(key, value):
            if key.lower() not in {'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer', 'te', 'proxy-authenticate', 'proxy-authorization'}:
                response['headers'].append((str(key), str(value)))
        handler.send_header = send_header
        handler.list_directory = lambda path: handler.send_error(404)
        handler.end_headers = lambda: None
        handler.log_message = lambda *args: None
        handler.log_error = lambda *args: logging.error('HTTP error on %s', path)
        try:
            with DATA_LOCK:
                if path.startswith('/data/online2/'):
                    # Only generated map layers are public to authenticated users.
                    name = path.removeprefix('/data/online2/')
                    if name in ('met_wind_nearby.geojson', 'met_wind_area.geojson'):
                        target = DATA_DIR / 'online2' / name
                        if target.exists():
                            handler.send_header('Content-Type', 'application/geo+json')
                            handler.wfile.write(target.read_bytes())
                        else:
                            handler.send_error(404)
                    elif name == 'ambient_gamma_stations.geojson':
                        handler.do_GET()
                    else:
                        handler.send_error(404)
                else:
                    # SimpleHTTPRequestHandler is used only for its response routing/file reader.
                    # No listening HTTP server is created here; Waitress owns HTTP parsing.
                    handler.do_GET()
            response['headers'].append(('Cache-Control', 'no-store'))
            start_response(response['status'], response['headers'])
            logging.info('request method=GET path=%s status=%s', path, response['status'].split()[0])
            return [handler.wfile.getvalue()]
        except Exception:
            logging.exception('Request failed: %s', path)
            start_response('500 Internal Server Error', [('Content-Type', 'application/json')])
            return [b'{"ok":false,"error":"Internal server error"}']


def wind_worker(backend):
    while not STOP.is_set():
        try:
            backend.trigger_met_wind_refresh('scheduled')
            cfg = effective_wind_config()
            if cfg.get('norwayWindEnabled'):
                backend.trigger_met_wind_area_refresh('norway')
        except Exception:
            logging.exception('Scheduled wind refresh failed')
        STOP.wait(float(effective_wind_config()['refreshMinutes']) * 60)


def main():
    from waitress import create_server
    application = Application()
    application.backend.initialize_state()
    worker = threading.Thread(target=wind_worker, args=(application.backend,), name='wind-scheduler', daemon=True)
    worker.start()
    server = create_server(application, host='0.0.0.0', port=8030, threads=4, clear_untrusted_proxy_headers=True)
    def stop(signum, frame):
        STOP.set()
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logging.info('DSAFieldPos listening on 0.0.0.0:8030')
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    finally:
        STOP.set()
        server.close()
        for thread in threading.enumerate():
            if thread.name.startswith(('fieldpos-', 'wind-')) and thread is not threading.current_thread():
                thread.join(timeout=10)
                if thread.is_alive():
                    logging.warning('Background task did not finish before shutdown: %s', thread.name)


if __name__ == '__main__':
    main()
