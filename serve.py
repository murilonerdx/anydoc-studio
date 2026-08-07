#!/usr/bin/env python3
"""Static server for anydoc studio.

Sends `Cache-Control: no-cache` for code (HTML/JS/CSS) so a plain browser
refresh always picks up the latest build — the default http.server caches
these aggressively, which made updates (and IndexedDB persistence) look
broken across reloads. Heavy immutable assets (wasm, onnx, fonts) keep a
long cache so they are not re-downloaded every time.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
NO_CACHE = ('.html', '.js', '.mjs', '.css')
LONG_CACHE = ('.wasm', '.onnx', '.woff2', '.woff', '.ttf', '.svg', '.png', '.jpg', '.jpeg')


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.split('?', 1)[0].lower()
        if path.endswith(NO_CACHE) or path.endswith('/'):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        elif path.endswith(LONG_CACHE):
            self.send_header('Cache-Control', 'public, max-age=604800')
        super().end_headers()

    def log_message(self, *args):
        pass  # quiet


if __name__ == '__main__':
    print(f'anydoc studio -> http://127.0.0.1:{PORT}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
