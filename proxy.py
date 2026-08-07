#!/usr/bin/env python3
"""Tiny local CORS proxy for anydoc studio scraping.

The browser can't read most cross-origin pages directly (no CORS header).
This fetches the page server-side and returns it with permissive CORS, so the
app can scrape any URL — still fully local, nothing goes to a cloud service.

    python proxy.py 8788

Then in the app's scraping settings set the proxy URL to:
    http://localhost:8788

Only meant for local, single-user use.
"""
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
UA = 'Mozilla/5.0 (anydoc-studio local proxy)'


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != '/proxy':
            self.send_response(404); self._cors(); self.end_headers(); return
        target = (parse_qs(parsed.query).get('url') or [''])[0]
        if not target.startswith(('http://', 'https://')):
            self.send_response(400); self._cors(); self.end_headers()
            self.wfile.write(b'bad url'); return
        try:
            req = urllib.request.Request(target, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                body = r.read()
                ctype = r.headers.get('Content-Type', 'text/html; charset=utf-8')
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:  # noqa: BLE001
            self.send_response(502); self._cors(); self.end_headers()
            self.wfile.write(str(e).encode('utf-8', 'replace'))

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    print(f'anydoc studio proxy -> http://localhost:{PORT}/proxy?url=...')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
