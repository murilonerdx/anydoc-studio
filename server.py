#!/usr/bin/env python3
"""anydoc studio — local backend (database + file drive).

A single self-hosted process that serves the static app AND a small REST API
backed by SQLite (`data/anydoc.db`) plus an on-disk file drive (`data/files/`).
This moves document bytes, OCR results, translations, embeddings, the word
bank and settings OUT of the browser (IndexedDB/localStorage) and into a real
database on your machine — nothing is uploaded to any third party.

Zero third-party dependencies: standard library only (http.server + sqlite3).

Run:  python server.py 8777   →   http://127.0.0.1:8777

REST API (all JSON unless noted):
  GET    /api/health                 -> { ok, docs }
  GET    /api/docs                   -> [ {metadata, no heavy blobs} ]
  POST   /api/docs                   -> create (JSON metadata) -> {id, ...}
  GET    /api/docs/{id}              -> full record (incl. ocrPages/translations/ragIndex)
  PUT    /api/docs/{id}              -> partial update (JSON)
  DELETE /api/docs/{id}              -> delete row + file
  DELETE /api/docs                   -> clear all
  GET    /api/docs/{id}/bytes        -> raw file bytes (octet-stream)
  PUT    /api/docs/{id}/bytes        -> store raw file bytes (octet-stream body)
  GET    /api/kv/{key}               -> stored JSON value (glossary/config/…)
  PUT    /api/kv/{key}               -> store JSON value
  POST   /api/import-url             -> { url } fetch server-side into the drive
  GET    /api/sources                -> available file-source connectors
"""
import json
import os
import sqlite3
import sys
import threading
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, 'data')
FILES_DIR = os.path.join(DATA_DIR, 'files')
DB_PATH = os.path.join(DATA_DIR, 'anydoc.db')

# Columns that hold the light metadata (safe to return in a list) vs. the heavy
# JSON blobs (only returned when a single document is opened).
META_COLS = ['id', 'ord', 'name', 'size', 'format', 'is_web', 'source_url',
             'doc_type', 'ocr_lang', 'ocr_engine', 'tr_target', 'rag_for',
             'pdf_options', 'created_at', 'updated_at']
JSON_COLS = {'pdf_options', 'ocr_pages', 'translations', 'rag_index'}
HEAVY_COLS = ['ocr_markdown', 'ocr_pages', 'translations', 'rag_index', 'markdown']
# camelCase <-> snake_case for the fields the frontend speaks.
TO_SNAKE = {'ord': 'ord', 'name': 'name', 'size': 'size', 'format': 'format',
            'isWeb': 'is_web', 'sourceUrl': 'source_url', 'docType': 'doc_type',
            'ocrLang': 'ocr_lang', 'ocrEngine': 'ocr_engine', 'trTarget': 'tr_target',
            'ragFor': 'rag_for', 'pdfOptions': 'pdf_options', 'ocrMarkdown': 'ocr_markdown',
            'ocrPages': 'ocr_pages', 'translations': 'translations', 'ragIndex': 'rag_index',
            'markdown': 'markdown'}
TO_CAMEL = {v: k for k, v in TO_SNAKE.items()}

_db = None
_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def db():
    global _db
    if _db is None:
        os.makedirs(FILES_DIR, exist_ok=True)
        _db = sqlite3.connect(DB_PATH, check_same_thread=False)
        _db.row_factory = sqlite3.Row
        _db.execute('PRAGMA journal_mode=WAL')
        _db.execute('''CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY, ord TEXT, name TEXT NOT NULL, size INTEGER,
            format TEXT, is_web INTEGER DEFAULT 0, source_url TEXT, doc_type TEXT,
            ocr_lang TEXT, ocr_engine TEXT, tr_target TEXT, rag_for INTEGER,
            pdf_options TEXT, ocr_markdown TEXT, ocr_pages TEXT, translations TEXT,
            rag_index TEXT, markdown TEXT, created_at TEXT, updated_at TEXT)''')
        _db.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)')
        _db.commit()
    return _db


def row_to_doc(row, heavy=False):
    """Turn a DB row into the camelCase record the frontend expects."""
    out = {}
    cols = META_COLS + (HEAVY_COLS if heavy else [])
    for col in cols:
        if col not in row.keys():
            continue
        val = row[col]
        if col in JSON_COLS and val is not None:
            try:
                val = json.loads(val)
            except (ValueError, TypeError):
                val = None
        if col == 'is_web':
            val = bool(val)
        out[TO_CAMEL.get(col, col)] = val
    if not heavy:
        # cheap flags so the drive list can show badges without the heavy blobs
        out['hasOcr'] = row['ocr_markdown'] is not None or row['ocr_pages'] is not None
        out['hasTranslations'] = row['translations'] is not None
        out['hasRag'] = row['rag_index'] is not None
    return out


def file_path(doc_id):
    # doc ids are app-generated slugs; keep only filename-safe chars.
    safe = ''.join(c for c in str(doc_id) if c.isalnum() or c in '-_')
    return os.path.join(FILES_DIR, safe or 'unnamed')


class Handler(SimpleHTTPRequestHandler):
    # Correct MIME regardless of host registry; ES modules need a JS type and
    # ONNX Runtime streams the .wasm (needs application/wasm).
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
    }
    NO_CACHE = ('.html', '.js', '.mjs', '.css')
    LONG_CACHE = ('.wasm', '.onnx', '.woff2', '.woff', '.ttf', '.svg', '.png', '.jpg', '.jpeg')

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass  # quiet

    # ---- helpers ----
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        return self.rfile.read(length) if length else b''

    def _read_json(self):
        raw = self._read_body()
        return json.loads(raw or b'{}')

    def end_headers(self):
        # Static caching policy (API responses set their own Cache-Control above).
        if not self.path.startswith('/api/'):
            p = self.path.split('?', 1)[0].lower()
            if p.endswith(self.NO_CACHE) or p.endswith('/'):
                self.send_header('Cache-Control', 'no-cache, must-revalidate')
            elif p.endswith(self.LONG_CACHE):
                self.send_header('Cache-Control', 'public, max-age=604800')
        super().end_headers()

    # ---- routing ----
    def do_GET(self):
        if self.path.startswith('/api/'):
            return self._api('GET')
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/'):
            return self._api('POST')
        self._send_json({'error': 'not found'}, 404)

    def do_PUT(self):
        if self.path.startswith('/api/'):
            return self._api('PUT')
        self._send_json({'error': 'not found'}, 404)

    def do_DELETE(self):
        if self.path.startswith('/api/'):
            return self._api('DELETE')
        self._send_json({'error': 'not found'}, 404)

    def _api(self, method):
        try:
            path = urllib.parse.urlparse(self.path).path
            parts = [p for p in path.split('/') if p][1:]  # drop 'api'
            with _lock:
                self._route(method, parts)
        except BrokenPipeError:
            pass
        except Exception as e:  # never crash the server on a bad request
            try:
                self._send_json({'error': str(e)}, 500)
            except Exception:
                pass

    def _route(self, method, parts):
        conn = db()
        # /api/health
        if parts == ['health'] and method == 'GET':
            n = conn.execute('SELECT COUNT(*) c FROM documents').fetchone()['c']
            return self._send_json({'ok': True, 'docs': n})

        # /api/sources — connector registry (skeleton; Drive wired later)
        if parts == ['sources'] and method == 'GET':
            return self._send_json({'sources': [
                {'id': 'upload', 'name': 'Upload', 'ready': True},
                {'id': 'url', 'name': 'URL', 'ready': True},
                {'id': 'gdrive', 'name': 'Google Drive', 'ready': False, 'needs': 'oauth-client-id'},
            ]})

        # /api/import-url
        if parts == ['import-url'] and method == 'POST':
            return self._import_url(conn)

        # /api/kv/{key}
        if len(parts) == 2 and parts[0] == 'kv':
            return self._kv(conn, method, parts[1])

        # /api/docs...
        if parts and parts[0] == 'docs':
            return self._docs(conn, method, parts[1:])

        self._send_json({'error': 'not found'}, 404)

    # ---- documents ----
    def _docs(self, conn, method, rest):
        # /api/docs
        if not rest:
            if method == 'GET':
                rows = conn.execute('SELECT * FROM documents ORDER BY ord').fetchall()
                return self._send_json({'docs': [row_to_doc(r) for r in rows]})
            if method == 'POST':
                return self._create_doc(conn, self._read_json())
            if method == 'DELETE':
                for r in conn.execute('SELECT id FROM documents').fetchall():
                    self._rm_file(r['id'])
                conn.execute('DELETE FROM documents')
                conn.commit()
                return self._send_json({'ok': True})
            return self._send_json({'error': 'method not allowed'}, 405)

        doc_id = rest[0]
        # /api/docs/{id}/bytes
        if len(rest) == 2 and rest[1] == 'bytes':
            if method == 'GET':
                return self._get_bytes(doc_id)
            if method == 'PUT':
                return self._put_bytes(conn, doc_id)
            return self._send_json({'error': 'method not allowed'}, 405)

        # /api/docs/{id}
        if len(rest) == 1:
            if method == 'GET':
                row = conn.execute('SELECT * FROM documents WHERE id=?', (doc_id,)).fetchone()
                if not row:
                    return self._send_json({'error': 'not found'}, 404)
                return self._send_json(row_to_doc(row, heavy=True))
            if method == 'PUT':
                return self._update_doc(conn, doc_id, self._read_json())
            if method == 'DELETE':
                conn.execute('DELETE FROM documents WHERE id=?', (doc_id,))
                conn.commit()
                self._rm_file(doc_id)
                return self._send_json({'ok': True})
        self._send_json({'error': 'not found'}, 404)

    def _create_doc(self, conn, data):
        doc_id = data.get('id') or ('d' + os.urandom(6).hex())
        cols, vals = ['id', 'created_at', 'updated_at'], [doc_id, now_iso(), now_iso()]
        for camel, snake in TO_SNAKE.items():
            if camel in data:
                v = data[camel]
                if snake in JSON_COLS and v is not None:
                    v = json.dumps(v)
                if snake == 'is_web':
                    v = 1 if v else 0
                cols.append(snake)
                vals.append(v)
        placeholders = ','.join('?' * len(cols))
        conn.execute(f'INSERT OR REPLACE INTO documents ({",".join(cols)}) VALUES ({placeholders})', vals)
        conn.commit()
        row = conn.execute('SELECT * FROM documents WHERE id=?', (doc_id,)).fetchone()
        self._send_json(row_to_doc(row, heavy=True), 201)

    def _update_doc(self, conn, doc_id, data):
        sets, vals = [], []
        for camel, snake in TO_SNAKE.items():
            if camel in data:
                v = data[camel]
                if snake in JSON_COLS and v is not None:
                    v = json.dumps(v)
                if snake == 'is_web':
                    v = 1 if v else 0
                sets.append(f'{snake}=?')
                vals.append(v)
        if not sets:
            return self._send_json({'ok': True})
        sets.append('updated_at=?')
        vals.append(now_iso())
        vals.append(doc_id)
        conn.execute(f'UPDATE documents SET {",".join(sets)} WHERE id=?', vals)
        conn.commit()
        self._send_json({'ok': True})

    def _get_bytes(self, doc_id):
        fp = file_path(doc_id)
        if not os.path.exists(fp):
            return self._send_json({'error': 'no bytes'}, 404)
        data = open(fp, 'rb').read()
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _put_bytes(self, conn, doc_id):
        raw = self._read_body()
        with open(file_path(doc_id), 'wb') as f:
            f.write(raw)
        conn.execute('UPDATE documents SET size=?, updated_at=? WHERE id=?',
                     (len(raw), now_iso(), doc_id))
        conn.commit()
        self._send_json({'ok': True, 'size': len(raw)})

    def _rm_file(self, doc_id):
        try:
            os.remove(file_path(doc_id))
        except FileNotFoundError:
            pass

    # ---- key/value (glossary, config, scrape, theme) ----
    def _kv(self, conn, method, key):
        if method == 'GET':
            row = conn.execute('SELECT value FROM kv WHERE key=?', (key,)).fetchone()
            val = json.loads(row['value']) if row and row['value'] else None
            return self._send_json({'key': key, 'value': val})
        if method == 'PUT':
            val = self._read_json()
            conn.execute('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)',
                         (key, json.dumps(val.get('value') if isinstance(val, dict) and 'value' in val else val)))
            conn.commit()
            return self._send_json({'ok': True})
        self._send_json({'error': 'method not allowed'}, 405)

    # ---- import a file from a URL, server-side (bypasses CORS) ----
    def _import_url(self, conn):
        data = self._read_json()
        url = (data.get('url') or '').strip()
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            return self._send_json({'error': 'apenas URLs http/https'}, 400)
        req = urllib.request.Request(url, headers={'User-Agent': 'anydoc-studio'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read(200 * 1024 * 1024)  # 200 MB cap
            disp = resp.headers.get('Content-Disposition', '')
        name = None
        if 'filename=' in disp:
            name = disp.split('filename=')[-1].strip().strip('"; ')
        if not name:
            name = os.path.basename(parsed.path) or 'download'
        doc_id = 'd' + os.urandom(6).hex()
        conn.execute('INSERT INTO documents (id, ord, name, size, source_url, created_at, updated_at) '
                     'VALUES (?,?,?,?,?,?,?)',
                     (doc_id, doc_id, name, len(content), url, now_iso(), now_iso()))
        conn.commit()
        with open(file_path(doc_id), 'wb') as f:
            f.write(content)
        row = conn.execute('SELECT * FROM documents WHERE id=?', (doc_id,)).fetchone()
        self._send_json(row_to_doc(row, heavy=True), 201)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    db()  # initialize schema up front
    print(f'anydoc studio -> http://127.0.0.1:{port}  (db: {DB_PATH})')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
