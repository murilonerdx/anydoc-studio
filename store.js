// ============================================================
//  store.js — client for the local backend (server.py).
//
//  Persistence now lives in a real database + file drive on your
//  machine (SQLite via server.py), not in the browser. This module is
//  the thin fetch layer the app talks to. If the backend is not
//  running, checkBackend() returns false and the app degrades to an
//  in-memory session (with a banner) instead of persisting.
// ============================================================

async function jfetch(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res;
}

/** Is the backend reachable? Sets the mode for the whole session. */
export async function checkBackend() {
  try {
    const r = await fetch('/api/health');
    return r.ok;
  } catch {
    return false;
  }
}

// ---- documents ----
export async function listDocs() { return (await jfetch('GET', '/api/docs')).docs; }
export async function getDoc(id) { return jfetch('GET', `/api/docs/${encodeURIComponent(id)}`); }
export async function createDoc(meta) { return jfetch('POST', '/api/docs', meta); }
export async function updateDoc(id, patch) { return jfetch('PUT', `/api/docs/${encodeURIComponent(id)}`, patch); }
export async function deleteDoc(id) { return jfetch('DELETE', `/api/docs/${encodeURIComponent(id)}`); }
export async function clearDocs() { return jfetch('DELETE', '/api/docs'); }

export async function putBytes(id, bytes) {
  const res = await fetch(`/api/docs/${encodeURIComponent(id)}/bytes`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  if (!res.ok) throw new Error(`putBytes → ${res.status}`);
  return res.json();
}
export async function getBytes(id) {
  const res = await fetch(`/api/docs/${encodeURIComponent(id)}/bytes`);
  if (!res.ok) throw new Error(`getBytes → ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---- key/value (glossary, config, scrape settings, migration marker) ----
export async function getKV(key) { return (await jfetch('GET', `/api/kv/${encodeURIComponent(key)}`)).value; }
export async function putKV(key, value) { return jfetch('PUT', `/api/kv/${encodeURIComponent(key)}`, value); }

// ---- file sources (connectors) + server-side URL import ----
export async function getSources() { return (await jfetch('GET', '/api/sources')).sources; }
export async function importUrl(url) { return jfetch('POST', '/api/import-url', { url }); }
