// ============================================================
//  anydoc studio — app logic (main thread / UI)
//
//  Parsing is delegated to a Web Worker running two Rust/WASM
//  engines (anydoc + pdf-inspector), so the interface never
//  blocks. This module owns state, the request/response bridge
//  to the worker, and every view: rendered preview, live source,
//  parsed structure, embedded assets, and PDF analysis.
// ============================================================

import { marked } from './vendor/marked/marked.esm.js';
import { paddleRecognize, terminatePaddle } from './paddle.js';
import { loadCfg, saveCfg, translateText, translateBatch, testConnection, DEFAULT_CFG, detectLang, loadGlossary, recordGlossary, listOllamaModels, loadGlossaryBank, saveGlossaryBank, TARGET_LANGS } from './translate.js';
import { scrapeUrl, loadScrapeCfg, saveScrapeCfg } from './scrape.js';
import { buildIndex, retrieve, answerStream as ragAnswerStream } from './rag.js';
import { exportTranslatedPDF } from './export.js';

// ---- tiny helpers ----
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const nf = (n) => n.toLocaleString('pt-BR');

// Instant format guess from extension (badge paints before the worker replies).
const EXT_FMT = {
  doc: 'doc', docx: 'docx', docm: 'docx', dot: 'doc',
  ppt: 'ppt', pps: 'ppt', pot: 'ppt', pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', ppsm: 'pptx',
  xls: 'xlsx', xlsx: 'xlsx', xlsm: 'xlsx', xlsb: 'xlsx',
  odt: 'odt', ods: 'ods', odp: 'odp', rtf: 'rtf', epub: 'epub', csv: 'csv', pdf: 'pdf',
};
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

const FMT_COLOR = {
  doc: '#2b579a', docx: '#2b579a', ppt: '#d24726', pptx: '#d24726',
  xlsx: '#217346', ods: '#217346', odt: '#2b579a', odp: '#d24726',
  rtf: '#6b7280', epub: '#7c3aed', csv: '#059669', pdf: '#e0341f', img: '#0ea5e9', web: '#0d9488',
};
const fmtColor = (f) => FMT_COLOR[f] || '#fa5d19';

marked.setOptions({ gfm: true, breaks: false });

// ============================================================
//  State
// ============================================================
let ready = false;
const docs = new Map();
let activeId = null;
let seq = 0;

// ============================================================
//  Persistence (IndexedDB) — uploads survive a page refresh.
//  We store only the raw bytes + metadata and re-convert on load,
//  so the store stays small and never holds derived output.
// ============================================================
const DB_NAME = 'anydoc-studio';
const STORE = 'docs';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbRun(mode, fn) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const out = fn(store);
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return null; // storage unavailable (private mode, etc.) — degrade silently
  }
}

function saveDoc(rec) {
  return idbRun('readwrite', (s) =>
    s.put({ id: rec.id, ord: rec.ord, name: rec.name, size: rec.size, bytes: rec.bytes,
      pdfOptions: rec.pdfOptions, ocrLang: rec.ocrLang, ocrEngine: rec.ocrEngine,
      ocrMarkdown: rec.ocrMarkdown || null, ocrPages: rec.ocrPages || null,
      translations: rec.translations || null, trTarget: rec.trTarget || null,
      isWeb: rec.isWeb || false, sourceUrl: rec.sourceUrl || null, docType: rec.docType || null,
      ragIndex: rec.ragIndex || null, ragFor: rec.ragFor || null })
  );
}
function deleteStoredDoc(id) { return idbRun('readwrite', (s) => s.delete(id)); }
function clearStoredDocs() { return idbRun('readwrite', (s) => s.clear()); }
function allStoredDocs() {
  return idbRun('readonly', (s) => {
    const acc = [];
    s.openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { acc.push(cur.value); cur.continue(); }
    };
    return acc;
  });
}

async function restoreDocs() {
  const stored = await allStoredDocs();
  if (!stored || !stored.length) return;
  stored.sort((a, b) => String(a.ord).localeCompare(String(b.ord), undefined, { numeric: true }));
  // Keep the id counter ahead of anything restored.
  for (const d of stored) {
    const n = parseInt(String(d.id).replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > seq) seq = n;
  }
  let first = null;
  for (const d of stored) {
    intake(d.name, d.bytes instanceof Uint8Array ? d.bytes : new Uint8Array(d.bytes), d.size,
      { id: d.id, ord: d.ord, pdfOptions: d.pdfOptions, ocrLang: d.ocrLang, ocrEngine: d.ocrEngine, ocrMarkdown: d.ocrMarkdown, ocrPages: d.ocrPages,
      translations: d.translations, trTarget: d.trTarget,
      isWeb: d.isWeb, sourceUrl: d.sourceUrl, docType: d.docType,
      ragIndex: d.ragIndex, ragFor: d.ragFor, fromStore: true });
    if (!first) first = d.id;
  }
  if (first) setActive(first);
}

// ============================================================
//  Worker bridge (advanced main ⇄ worker messaging)
// ============================================================
const worker = new Worker('./worker.js', { type: 'module' });
let reqSeq = 0;
const pending = new Map(); // reqId -> { resolve, reject }

worker.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    ready = true;
    const badge = $('engine-status');
    badge.classList.remove('loading');
    badge.classList.add('ready');
    $('engine-label').textContent = msg.pdfInspector
      ? `anydoc + pdf-inspector ${msg.pdfInspector}`
      : 'motores prontos · local';
    $('dz-title').textContent = 'Solte documentos aqui';
    // Restore previously uploaded documents, then process anything dropped
    // while the engines were still loading.
    restoreDocs();
    if (queuedWhileLoading.length) {
      const waiting = queuedWhileLoading.splice(0);
      waiting.forEach((f) => intake(f.name, f.bytes, f.size));
    }
    return;
  }
  if (msg.type === 'fatal') {
    const badge = $('engine-status');
    badge.classList.remove('loading');
    badge.classList.add('error');
    $('engine-label').textContent = 'falha ao carregar';
    $('dz-title').textContent = 'Não foi possível carregar os motores';
    $('dz-hint').textContent = msg.error;
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === 'result') p.resolve(msg.result);
  else if (msg.type === 'error') p.reject(msg.error);
});

function convertInWorker(name, bytes, options) {
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'convert', id, payload: { name, bytes, options } });
  });
}

worker.postMessage({ type: 'init' });

// Register the service worker so the app is installable and works offline.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// ============================================================
//  File intake
// ============================================================
const dropzone = $('dropzone');
const fileInput = $('file-input');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });

['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));
dropzone.addEventListener('dragover', () => dropzone.classList.add('over'));
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) addFiles(files);
});

// Files dropped before the engines finish loading wait here.
const queuedWhileLoading = [];

async function addFiles(files) {
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!ready) {
      queuedWhileLoading.push({ name: file.name, bytes, size: file.size });
      $('dz-title').textContent = 'Carregando motor — seu arquivo entra assim que ficar pronto…';
    } else {
      intake(file.name, bytes, file.size);
    }
  }
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff']);

function intake(name, bytes, size, opts = {}) {
  const id = opts.id || `d${++seq}`;
  const base = name.replace(/\.[^.]*$/, '') || 'document';
  const ext = extOf(name);
  const isWeb = !!opts.isWeb;
  const isImage = !isWeb && IMAGE_EXT.has(ext);
  const format = isWeb ? 'web' : isImage ? 'img' : (EXT_FMT[ext] || null);
  const rec = {
    id, name, base, bytes, size: size ?? bytes.length, format, isImage, imageExt: ext,
    isWeb, sourceUrl: opts.sourceUrl || null, docType: opts.docType || null,
    ragIndex: opts.ragIndex || null, ragFor: opts.ragFor || null,
    status: 'pending', assetUrls: [],
    ord: opts.ord ?? id,
    pdfOptions: opts.pdfOptions || { profile: 'fidelity', pageMarkers: false },
    ocrLang: opts.ocrLang || 'por+eng',
    ocrEngine: opts.ocrEngine || 'tesseract',
    ocrMarkdown: opts.ocrMarkdown || null,
    ocrPages: opts.ocrPages || null,
    translations: opts.translations || null,
    trTarget: opts.trTarget || null,
  };
  docs.set(id, rec);
  if (!opts.fromStore) saveDoc(rec);
  renderQueue();
  setActive(id);
  if (isWeb) {
    // Scraped page: the bytes ARE the Markdown; no conversion needed.
    rec.status = 'done';
    rec.model = null; rec.pdf = null;
    rec.markdown = opts.markdown || new TextDecoder().decode(bytes);
    rec.stats = computeStats({ markdown: rec.markdown, ms: 0 }, rec.size);
    renderQueue();
    if (activeId === rec.id) renderActive();
  } else if (isImage) {
    // Images carry no extractable text; they go straight to the OCR path
    // (or show a restored OCR result).
    rec.status = 'done';
    rec.model = null;
    rec.pdf = null;
    rec.ocrDone = !!rec.ocrMarkdown;
    rec.markdown = rec.ocrMarkdown || '';
    const words = (rec.markdown.trim().match(/\S+/g) || []).length;
    rec.stats = { chars: rec.markdown.length, words, ms: 0, size: rec.size, blocks: 0, headings: 0, tables: 0, lists: 0, assets: 0, notes: 0, pageCount: 0 };
    renderQueue();
    if (activeId === rec.id) renderActive();
  } else {
    runConvert(rec);
  }
}

async function runConvert(rec) {
  rec.status = 'pending';
  renderQueue();
  if (activeId === rec.id) renderActive();
  try {
    const result = await convertInWorker(rec.name, rec.bytes, rec.pdfOptions);
    rec.format = result.format || rec.format;
    rec.markdown = result.markdown || '';
    rec.model = result.model || null;
    rec.pdf = result.pdf || null;
    rec.status = 'done';
    rec.error = null;
    rec.stats = computeStats(result, rec.size);
    buildAssetUrls(rec);
    // A restored OCR result takes over the (empty) native text of a scan.
    if (rec.ocrMarkdown) {
      rec.markdown = rec.ocrMarkdown;
      rec.ocrDone = true;
      rec.stats.chars = rec.markdown.length;
      rec.stats.words = (rec.markdown.trim().match(/\S+/g) || []).length;
    }
  } catch (error) {
    rec.status = 'error';
    rec.error = { code: error?.code || 'error', message: error?.message ?? String(error) };
  }
  renderQueue();
  if (activeId === rec.id) renderActive();
}

// ============================================================
//  Stats
// ============================================================
function computeStats(result, size) {
  const md = result.markdown || '';
  const words = (md.trim().match(/\S+/g) || []).length;
  let blocks = 0, headings = 0, tables = 0, lists = 0;
  const model = result.model;
  if (model) {
    const walk = (bs) => {
      for (const b of bs) {
        blocks++;
        if (b.kind === 'heading') headings++;
        else if (b.kind === 'table') tables++;
        else if (b.kind === 'list') lists++;
        if (b.blocks) walk(b.blocks);
        if (b.list) b.list.items.forEach((it) => walk(it.blocks));
      }
    };
    walk(model.blocks);
  }
  return {
    chars: md.length, words, ms: result.ms || 1,
    size, blocks, headings, tables, lists,
    assets: model?.assets?.length || 0,
    notes: model?.notes?.length || 0,
    pageCount: result.pdf?.pageCount || 0,
  };
}

function buildAssetUrls(rec) {
  rec.assetUrls.forEach((u) => URL.revokeObjectURL(u));
  rec.assetUrls = [];
  if (!rec.model?.assets) return;
  for (const a of rec.model.assets) {
    if (a.data && a.mediaType?.startsWith('image/')) {
      rec.assetUrls[a.id] = URL.createObjectURL(new Blob([a.data], { type: a.mediaType }));
    }
  }
}

// ============================================================
//  Queue (sidebar)
// ============================================================
function renderQueue() {
  const q = $('queue');
  q.innerHTML = '';
  $('clear-all').hidden = docs.size === 0;
  for (const rec of docs.values()) {
    const li = el('li', 'q-item' + (rec.id === activeId ? ' active' : ''));
    li.addEventListener('click', () => setActive(rec.id));

    const badge = el('span', 'q-fmt', (rec.format || '?').toUpperCase());
    badge.style.background = fmtColor(rec.format);

    const meta = el('div', 'q-meta');
    meta.append(el('div', 'q-name', rec.name));
    let sub;
    if (rec.status === 'error') sub = el('div', 'q-sub err', rec.error?.code || 'erro');
    else if (rec.status === 'done') sub = el('div', 'q-sub', `${fmtBytes(rec.size)} · ${rec.stats.ms} ms`);
    else sub = el('div', 'q-sub', fmtBytes(rec.size));
    meta.append(sub);
    li.append(badge, meta);

    if (rec.status === 'pending') {
      li.append(el('span', 'q-spin'));
    } else {
      const rm = el('button', 'q-remove', '×');
      rm.title = 'Remover';
      rm.addEventListener('click', (e) => { e.stopPropagation(); removeDoc(rec.id); });
      li.append(rm);
    }
    q.append(li);
  }
}

function removeDoc(id) {
  const rec = docs.get(id);
  if (rec) rec.assetUrls.forEach((u) => URL.revokeObjectURL(u));
  docs.delete(id);
  deleteStoredDoc(id);
  if (activeId === id) activeId = docs.size ? [...docs.keys()][docs.size - 1] : null;
  renderQueue();
  activeId ? renderActive() : showEmpty();
}

$('clear-all').addEventListener('click', () => {
  for (const rec of docs.values()) rec.assetUrls.forEach((u) => URL.revokeObjectURL(u));
  docs.clear();
  clearStoredDocs();
  activeId = null;
  renderQueue();
  showEmpty();
});

// ============================================================
//  Active document render
// ============================================================
function setActive(id) { activeId = id; renderQueue(); renderActive(); }

function showEmpty() {
  $('empty-state').hidden = false;
  $('doc-view').hidden = true;
  $('error-banner').hidden = true;
}

// Friendly, human error copy per failure mode. `code` comes from the engine;
// we also sniff the message for cases the PDF engine reports as a generic error.
function classifyError(err) {
  const code = (err.code || '').toLowerCase();
  const msg = (err.message || '').toLowerCase();
  const isEnc = code === 'encrypted' || /encrypt|password|senha/.test(msg);
  const isImg = code === 'unsupported' && /image|scan|ocr/.test(msg);
  if (isEnc) return {
    icon: '🔒', title: 'Documento protegido por senha',
    body: 'Este arquivo está criptografado. Remova a proteção no aplicativo de origem (ou salve uma cópia sem senha) e envie novamente — a conversão é feita localmente e não temos como abrir arquivos protegidos.',
  };
  if (isImg || code === 'unsupported' && /pdf/.test(msg)) return {
    icon: '🖼️', title: 'PDF sem texto (digitalizado)',
    body: 'Este PDF parece ser só imagem — não há texto embutido para extrair. Use o OCR local para tentar reconhecer o texto das páginas.',
    ocr: rec => rec && rec.format === 'pdf',
  };
  if (code === 'unsupported') return {
    icon: '🚫', title: 'Formato não suportado',
    body: 'Não reconhecemos este arquivo como um dos 14 formatos suportados, ou ele não pode ser convertido em Markdown (por exemplo, um PDF apenas de imagem).',
  };
  if (code === 'malformed' || /invalid|trailer|parse/.test(msg)) return {
    icon: '🧩', title: 'Arquivo corrompido ou ilegível',
    body: 'A estrutura do arquivo está danificada e nenhum conteúdo pôde ser lido. Tente abrir e salvar novamente no aplicativo de origem, ou reexportar o documento.',
  };
  if (code === 'resourcelimit') return {
    icon: '⚠️', title: 'Arquivo muito complexo',
    body: 'O documento cruzou um limite de segurança (descompressão, aninhamento ou número de elementos). Isso protege contra arquivos maliciosos — divida o documento se ele for legítimo.',
  };
  if (code === 'missingpart') return {
    icon: '🧷', title: 'Parte do documento ausente',
    body: 'Falta um componente necessário para extrair qualquer conteúdo (o arquivo pode estar incompleto). Reexporte o documento e tente de novo.',
  };
  return {
    icon: '❌', title: 'Não deu para converter este arquivo',
    body: err.message || 'Ocorreu um erro inesperado durante a conversão.',
  };
}

function renderError(rec) {
  const info = classifyError(rec.error);
  const b = $('error-banner');
  b.hidden = false;
  b.innerHTML = '';
  const box = el('div', 'box');
  box.append(el('div', 'err-glyph', info.icon));
  box.append(el('span', 'code', rec.error.code || 'erro'));
  box.append(el('h3', null, info.title));
  box.append(el('p', null, info.body));
  if (info.ocr && info.ocr(rec)) {
    const btn = el('button', 'ghost-btn', 'Executar OCR local →');
    btn.addEventListener('click', () => runOcr(rec));
    box.append(btn);
  }
  b.append(box);
}

function renderActive() {
  const rec = docs.get(activeId);
  if (!rec) return showEmpty();
  $('empty-state').hidden = true;

  if (rec.status === 'error') {
    $('doc-view').hidden = true;
    renderError(rec);
    return;
  }
  if (rec.status !== 'done') {
    // keep the doc view but blank while pending, unless nothing shown yet
    if ($('doc-view').hidden) { $('empty-state').hidden = false; }
    return;
  }

  $('error-banner').hidden = true;
  $('doc-view').hidden = false;
  $('empty-state').hidden = true;

  $('doc-name').textContent = rec.name;
  const fb = $('doc-format');
  fb.textContent = rec.format || '?';
  fb.style.background = fmtColor(rec.format);
  renderStats(rec.stats, rec);

  // PDF tab visibility
  const isPdf = rec.format === 'pdf' && rec.pdf;
  document.querySelector('.tab-pdf').hidden = !isPdf;

  const hasPositions = rec.ocrPages && rec.ocrPages.some((p) => p.boxes && p.boxes.length);
  document.querySelector('.tab-positions').hidden = !hasPositions;
  document.querySelector('.tab-translate').hidden = !hasPositions;
  const pc = $('pos-count');
  if (hasPositions) {
    pc.hidden = false;
    pc.textContent = rec.ocrPages.reduce((n, p) => n + (p.boxes?.length || 0), 0);
  } else { pc.hidden = true; }

  renderPreview(rec.markdown, rec);
  $('md-editor').value = rec.markdown;
  renderStructure(rec);
  renderAssets(rec);
  if (isPdf) renderPdf(rec);
  if (hasPositions) { renderPositions(rec); renderTranslation(rec); }

  const ac = $('assets-count');
  ac.hidden = !rec.stats.assets;
  ac.textContent = rec.stats.assets;

  // If the active tab is now hidden (pdf tab on a non-pdf), fall back to preview.
  const activeTab = document.querySelector('.tab.active');
  if (activeTab && activeTab.hidden) selectTab('preview');
}

function renderStats(s, rec) {
  const bar = $('doc-stats');
  bar.innerHTML = '';
  const add = (label, val) => {
    const wrap = el('span', 'stat');
    wrap.append(el('b', null, val));
    wrap.append(document.createTextNode(label));
    bar.append(wrap);
  };
  add(' ms', s.ms);
  if (rec.format === 'pdf' && s.pageCount) add(' páginas', s.pageCount);
  add(' chars', nf(s.chars));
  add(' palavras', nf(s.words));
  if (s.blocks) add(' blocos', nf(s.blocks));
  if (s.headings) add(' títulos', s.headings);
  if (s.tables) add(' tabelas', s.tables);
  if (s.assets) add(' recursos', s.assets);
}

// ---- Preview ----
function renderPreview(md, rec) {
  const host = $('preview');
  host.innerHTML = marked.parse(md || '');
  // Nothing readable came out (e.g. a scanned/image PDF): explain, don't blank.
  if (!host.textContent.replace(/\s+/g, '')) {
    host.innerHTML = '';
    host.append(emptyPreviewNotice(rec));
  }
}

function emptyPreviewNotice(rec) {
  const isImage = rec && rec.isImage;
  const scanned = rec && rec.format === 'pdf' && rec.pdf &&
    (rec.pdf.pdfType === 'Scanned' || rec.pdf.pdfType === 'ImageBased' || rec.pdf.pdfType === 'Mixed' || rec.pdf.pagesNeedingOcr?.length);
  const box = el('div', 'preview-empty');
  box.append(el('div', 'preview-empty-glyph', '🖼️'));

  if (isImage) {
    box.append(el('h3', null, 'Imagem pronta para OCR'));
    box.append(el('p', null,
      'Arquivos de imagem não têm texto embutido. Rode o OCR local para reconhecer o texto e gerar o Markdown — ' +
      'tudo no seu navegador, sem enviar a imagem para lugar nenhum.'));
    box.append(ocrButton(rec));
    box.append(ocrLangHint(rec));
    return box;
  }

  if (scanned) {
    box.append(el('h3', null, 'Este PDF é digitalizado — precisa de OCR'));
    box.append(el('p', null,
      'O conteúdo das páginas é imagem, não texto embutido. Rode o OCR local: cada página é rasterizada e ' +
      'reconhecida no seu navegador, sem API e sem enviar nada. A conversão do texto nativo (quando houver) já foi feita.'));
    box.append(ocrButton(rec));
    const seeBtn = el('button', 'link-inline', 'Ver análise do PDF →');
    seeBtn.addEventListener('click', () => selectTab('pdf'));
    box.append(seeBtn);
    box.append(ocrLangHint(rec));
    return box;
  }

  box.append(el('h3', null, 'Sem conteúdo textual'));
  box.append(el('p', null, 'A conversão não produziu texto. O documento pode estar vazio ou conter apenas imagens/objetos.'));
  return box;
}

function ocrButton(rec) {
  const btn = el('button', 'primary-btn', '⚡ Executar OCR local');
  btn.addEventListener('click', () => runOcr(rec));
  return btn;
}

function ocrControls(rec) {
  const wrap = el('div', 'ocr-controls');

  // Engine selector: Tesseract (light) vs PaddleOCR (accurate).
  const engRow = el('div', 'ocr-row');
  engRow.append(el('span', 'ocr-row-k', 'Motor:'));
  const seg = el('div', 'seg');
  [['tesseract', 'Leve · Tesseract'], ['paddle', 'Preciso · PaddleOCR']].forEach(([v, l]) => {
    const b = el('button', 'seg-btn' + (rec.ocrEngine === v ? ' on' : ''), l);
    b.addEventListener('click', () => {
      rec.ocrEngine = v;
      // Re-render the notice so language options and the "on" state update.
      if (activeId === rec.id) renderActive();
    });
    seg.append(b);
  });
  engRow.append(seg);
  wrap.append(engRow);

  // Language selector (per engine — Paddle v5 mobile is a unified multilingual model).
  const langRow = el('div', 'ocr-row');
  langRow.append(el('span', 'ocr-row-k', 'Idioma:'));
  const sel = el('select', 'ocr-lang-select');
  const langs = rec.ocrEngine === 'paddle'
    ? [['auto', 'Automático (multilíngue)']]
    : [['por+eng', 'Português + Inglês'], ['por', 'Português'], ['eng', 'Inglês'],
       ['spa', 'Espanhol'], ['fra', 'Francês'], ['deu', 'Alemão'], ['ita', 'Italiano']];
  langs.forEach(([v, l]) => {
    const o = el('option', null, l); o.value = v;
    if (v === rec.ocrLang) o.selected = true;
    sel.append(o);
  });
  if (rec.ocrEngine === 'paddle') sel.disabled = true;
  sel.addEventListener('change', () => { rec.ocrLang = sel.value; });
  langRow.append(sel);
  wrap.append(langRow);

  wrap.append(el('div', 'ocr-note', rec.ocrEngine === 'paddle'
    ? 'PaddleOCR (PP-OCRv5): mais preciso em scans e tabelas, ~21 MB de modelos na 1ª vez.'
    : 'Tesseract: leve e rápido; escolha o idioma para melhor precisão.'));
  return wrap;
}
// Backwards-compatible alias used by the notice.
const ocrLangHint = ocrControls;

// ============================================================
//  OCR — local, in the browser (Tesseract.js + PDF.js).
//  Nothing is uploaded: models and page rasters stay on-device.
//  These heavy libraries load lazily from CDN only when OCR is
//  actually used, so the base app stays fully offline.
// ============================================================
// Everything OCR-related is vendored locally, so the app is 100% offline —
// no CDN. Tesseract loads its worker, WASM core, and language data from
// vendor/tesseract/; PDF.js from vendor/pdfjs/.
const OCR_LOCAL = {
  tesseract: './vendor/tesseract/tesseract.esm.min.js',
  tessWorker: './vendor/tesseract/worker.min.js',
  tessCore: './vendor/tesseract/core',   // directory; the engine picks the SIMD/LSTM build
  tessLang: './vendor/tesseract/lang',   // directory of gzipped {lang}.traineddata.gz
  pdfjs: './vendor/pdfjs/pdf.min.mjs',
  pdfWorker: './vendor/pdfjs/pdf.worker.min.mjs',
};
// Resolve to absolute URLs so paths hold up inside Tesseract's own worker.
const abs = (p) => new URL(p, import.meta.url).href;
const TESS_OPTS = { workerPath: abs(OCR_LOCAL.tessWorker), corePath: abs(OCR_LOCAL.tessCore), langPath: abs(OCR_LOCAL.tessLang) };
let tesseractMod = null, pdfjsMod = null, ocrBusy = false;

async function loadTesseract() {
  if (!tesseractMod) {
    const m = await import(OCR_LOCAL.tesseract);
    const createWorker = m.createWorker || m.default?.createWorker;
    if (typeof createWorker !== 'function') throw new Error('Tesseract.js: createWorker indisponível');
    tesseractMod = { createWorker };
  }
  return tesseractMod;
}
async function loadPdfjs() {
  if (!pdfjsMod) {
    pdfjsMod = await import(OCR_LOCAL.pdfjs);
    pdfjsMod.GlobalWorkerOptions.workerSrc = abs(OCR_LOCAL.pdfWorker);
  }
  return pdfjsMod;
}

// pdf.js render() drives its paint loop via requestAnimationFrame, which the
// browser pauses when the tab is in the background. Guard every render so a
// backgrounded tab fails clearly instead of hanging forever.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`${label} excedeu ${ms / 1000}s — mantenha esta aba em primeiro plano durante o OCR de PDF.`)),
      ms)),
  ]);
}
async function renderPdfPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await withTimeout(page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise, 60000, 'Renderização da página');
  return canvas;
}

// Decode an image file's bytes into a canvas.
async function imageToCanvas(bytes, ext) {
  const type = 'image/' + (ext === 'jpg' ? 'jpeg' : (ext || 'png'));
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas;
}
function canvasToImageInput(canvas) {
  const id = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  return { width: id.width, height: id.height, data: new Uint8Array(id.data.buffer) };
}

async function runOcr(rec) {
  if (ocrBusy) return;
  ocrBusy = true;
  let tess = null;
  let cancelled = false;
  let cancelReject = null;
  // A signal we can race long awaits against, so a cancel interrupts an
  // in-flight recognize/render immediately (terminating a worker does not
  // reject its pending promise; the between-page checkpoint alone is too slow).
  const cancelSignal = new Promise((_, rej) => { cancelReject = rej; });
  cancelSignal.catch(() => {});
  const raceCancel = (p) => { p.catch(() => {}); return Promise.race([p, cancelSignal]); };
  const cancel = () => {
    cancelled = true;
    cancelReject(new Error('__cancelled__'));
    try { tess && tess.terminate(); } catch { /* already gone */ }
    try { terminatePaddle(); } catch { /* already gone */ }
  };
  const ov = showOcrOverlay(cancel);
  const usePaddle = rec.ocrEngine === 'paddle';
  try {
    // Prepare the chosen engine.
    if (usePaddle) {
      ov.status('Preparando PaddleOCR…');
    } else {
      ov.status('Carregando modelo de OCR (uma vez, fica em cache)…');
      const { createWorker } = await loadTesseract();
      tess = await createWorker(rec.ocrLang || 'por+eng', 1, {
        ...TESS_OPTS,
        logger: (m) => { if (m.status === 'recognizing text') ov.progress(m.progress); },
      });
    }
    // Recognize a canvas, returning the text plus per-region boxes (in the
    // canvas' own pixel space) so we can map recognized text back to position.
    const RENDER_SCALE = 2;
    const recognizeCanvas = async (canvas) => {
      if (usePaddle) {
        const { text, boxes } = await paddleRecognize(canvasToImageInput(canvas), ov.status);
        return { text: (text || '').trim(), boxes };
      }
      const { data } = await tess.recognize(canvas);
      // Group at the LINE level (not per word): a line is a translatable unit
      // and gives sensible position boxes. Fall back to words if lines are absent.
      const src = (data.lines && data.lines.length ? data.lines : data.words) || [];
      const boxes = src
        .filter((l) => (l.text || '').trim())
        .map((l) => ({
          text: l.text.trim(),
          x: l.bbox.x0, y: l.bbox.y0, w: l.bbox.x1 - l.bbox.x0, h: l.bbox.y1 - l.bbox.y0, points: null,
          conf: typeof l.confidence === 'number' ? l.confidence / 100 : null,
        }));
      return { text: (data.text || '').trim(), boxes };
    };

    const ocrPages = [];
    let markdown = '';
    if (rec.isImage) {
      ov.status('Reconhecendo texto da imagem…');
      const canvas = await raceCancel(imageToCanvas(rec.bytes, rec.imageExt));
      const { text, boxes } = await raceCancel(recognizeCanvas(canvas));
      markdown = text;
      // Cache the raster so Positions/Translation never re-render (fast, robust).
      ocrPages.push({ page: 1, width: canvas.width, height: canvas.height, scale: 1, boxes, raster: canvas.toDataURL('image/jpeg', 0.85) });
      canvas.width = canvas.height = 0;
    } else if (rec.format === 'pdf') {
      const pdfjs = await loadPdfjs();
      const pdf = await pdfjs.getDocument({ data: rec.bytes.slice(), disableWorker: false }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        ov.status(`Renderizando e lendo página ${i} de ${pdf.numPages}…`);
        ov.progress((i - 1) / pdf.numPages);
        if (cancelled) throw new Error('__cancelled__');
        const page = await pdf.getPage(i);
        const canvas = await raceCancel(renderPdfPage(page, RENDER_SCALE));
        const { text, boxes } = await raceCancel(recognizeCanvas(canvas));
        if (text) pages.push(`<!-- Página ${i} -->\n\n${text}`);
        // Cache the raster so Positions/Translation never re-render the PDF.
        ocrPages.push({ page: i, width: canvas.width, height: canvas.height, scale: RENDER_SCALE, boxes, raster: canvas.toDataURL('image/jpeg', 0.82) });
        canvas.width = canvas.height = 0;
      }
      markdown = pages.join('\n\n');
    }
    if (tess) await tess.terminate();

    rec.markdown = markdown || '_(OCR não encontrou texto legível)_';
    rec.ocrDone = true;
    rec.ocrMarkdown = rec.markdown;
    rec.ocrPages = ocrPages;
    const words = (rec.markdown.trim().match(/\S+/g) || []).length;
    rec.stats = { ...(rec.stats || {}), chars: rec.markdown.length, words };
    saveDoc(rec);
    ov.done();
    if (activeId === rec.id) { renderActive(); selectTab('preview'); }
  } catch (err) {
    if (cancelled || err?.message === '__cancelled__') ov.done();
    else ov.fail(err?.message || String(err));
  } finally {
    ocrBusy = false;
  }
}

function showOcrOverlay(onCancel) {
  let ov = document.getElementById('ocr-overlay');
  if (ov) ov.remove();
  ov = el('div', 'ocr-overlay');
  ov.id = 'ocr-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-label', 'Progresso do OCR');
  const card = el('div', 'ocr-card');
  const spin = el('div', 'ocr-spin');
  const status = el('div', 'ocr-status', 'Iniciando OCR…');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const bar = el('div', 'ocr-bar');
  const fill = el('div', 'ocr-fill');
  bar.append(fill);
  const sub = el('div', 'ocr-sub', 'Processamento local — nada é enviado.');
  card.append(spin, status, bar, sub);
  if (onCancel) {
    const cancelBtn = el('button', 'ghost-btn sm ocr-cancel', 'Cancelar');
    cancelBtn.addEventListener('click', () => {
      cancelBtn.disabled = true;
      status.textContent = 'Cancelando…';
      onCancel();
    });
    card.append(cancelBtn);
  }
  ov.append(card);
  ($('doc-view').hidden ? document.querySelector('.workspace') : $('doc-view')).append(ov);

  return {
    status: (t) => { status.textContent = t; },
    progress: (p) => { fill.style.width = Math.round((p || 0) * 100) + '%'; },
    done: () => { ov.remove(); },
    fail: (msg) => {
      spin.remove();
      status.textContent = 'Falha no OCR';
      sub.textContent = msg;
      card.classList.add('fail');
      const close = el('button', 'ghost-btn sm', 'Fechar');
      close.addEventListener('click', () => ov.remove());
      card.append(close);
    },
  };
}

// ============================================================
//  Positions — map each recognized region back onto the page.
//  This is the visual foundation for layout-preserving work
//  (translate a box, drop the result back in place — BabelDOC
//  style). Boxes come from the OCR pass (PaddleOCR polygons or
//  Tesseract word boxes), in the render's pixel space.
// ============================================================
const SVGNS = 'http://www.w3.org/2000/svg';

async function renderPositions(rec) {
  const tb = $('pos-toolbar');
  const body = $('positions');
  tb.innerHTML = '';
  body.innerHTML = '';
  (rec._posUrls || []).forEach((u) => URL.revokeObjectURL(u));
  rec._posUrls = [];

  const total = rec.ocrPages.reduce((n, p) => n + (p.boxes?.length || 0), 0);
  const chip = (label, val) => { const n = el('span', 'struct-stat'); n.innerHTML = `<b>${val}</b> ${label}`; return n; };
  tb.append(chip('regiões', total), chip('páginas', rec.ocrPages.length),
    chip('motor', rec.ocrEngine === 'paddle' ? 'PaddleOCR' : 'Tesseract'));

  // OCR confidence: color the boxes and let the user isolate low-confidence ones.
  const hasConf = rec.ocrPages.some((p) => p.boxes.some((b) => b.conf != null));
  const lowCount = rec.ocrPages.reduce((n, p) => n + p.boxes.filter((b) => b.conf != null && b.conf < 0.6).length, 0);
  if (hasConf) {
    const lc = chip('baixa confiança', lowCount);
    if (lowCount) lc.classList.add('stat-warn');
    tb.append(lc);
    const onlyLow = el('button', 'ghost-btn sm', rec._onlyLow ? 'Ver todas' : 'Só baixa confiança');
    onlyLow.classList.toggle('on', !!rec._onlyLow);
    onlyLow.disabled = !lowCount;
    onlyLow.addEventListener('click', () => { rec._onlyLow = !rec._onlyLow; renderPositions(rec); });
    tb.append(onlyLow);
  }
  const confClass = (c) => (c == null ? '' : c < 0.6 ? 'conf-low' : c < 0.85 ? 'conf-mid' : 'conf-hi');

  // Edit mode: move / resize / delete boxes and edit their text on the page.
  const editToggle = el('button', 'ghost-btn sm', '✏️ Editar caixas');
  editToggle.style.marginLeft = 'auto';
  editToggle.classList.toggle('on', !!rec._editing);
  editToggle.textContent = rec._editing ? '✓ Concluir edição' : '✏️ Editar caixas';
  editToggle.addEventListener('click', () => { rec._editing = !rec._editing; renderPositions(rec); });

  // Font family for the overlay text (applies to the whole page overlay).
  const fontSel = el('select', 'ocr-lang-select');
  ['sans-serif', 'serif', 'monospace', 'Georgia', 'Arial', 'Times New Roman'].forEach((f) => {
    const o = el('option', null, f); o.value = f; if (rec.overlayFont === f) o.selected = true; fontSel.append(o);
  });
  fontSel.title = 'Fonte do texto sobreposto';
  fontSel.addEventListener('change', () => { rec.overlayFont = fontSel.value; saveDoc(rec); renderPositions(rec); });

  const labelToggle = el('button', 'ghost-btn sm', rec._showLabels ? 'Ocultar sobreposição' : 'Sobrepor texto');
  labelToggle.classList.toggle('on', !!rec._showLabels);
  labelToggle.addEventListener('click', () => { rec._showLabels = !rec._showLabels; renderPositions(rec); });

  if (rec._editing) { tb.append(el('span', 'tr-k', 'Fonte:')); tb.append(fontSel); }
  tb.append(labelToggle, editToggle);

  body.classList.toggle('pos-editing', !!rec._editing);
  body.classList.toggle('show-labels', !!rec._showLabels || !!rec._editing);
  body.classList.toggle('pos-only-low', !!rec._onlyLow);

  rec.ocrPages.forEach((pg, pi) => {
    body.append(el('div', 'pos-page-title', `Página ${pg.page} · ${pg.boxes.length} regiões`));
    const row = el('div', 'pos-row');
    const stage = el('div', 'pos-stage');
    const inner = el('div', 'pos-stage-inner');
    inner.style.aspectRatio = `${pg.width} / ${pg.height}`;
    if (rec.overlayFont) inner.style.setProperty('--overlay-font', rec.overlayFont);

    const img = el('img', 'pos-img');
    img.alt = `Página ${pg.page}`;
    loadPageImage(img, rec, pg, rec._posUrls);
    inner.append(img);

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'pos-svg');
    svg.setAttribute('viewBox', `0 0 ${pg.width} ${pg.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const list = el('div', 'pos-list');

    pg.boxes.forEach((b, idx) => {
      const cc = confClass(b.conf);
      const shape = document.createElementNS(SVGNS, 'rect');
      shape.setAttribute('x', b.x); shape.setAttribute('y', b.y);
      shape.setAttribute('width', b.w); shape.setAttribute('height', b.h);
      shape.setAttribute('class', 'pos-box ' + cc);
      if (b.conf != null) shape.setAttribute('data-conf', Math.round(b.conf * 100) + '%');
      shape.setAttribute('aria-hidden', 'true'); // decorative; the list conveys the same info to AT
      svg.append(shape);

      const text = () => (rec.translations?.[pi]?.[idx]) || b.text;
      // Overlay / editable box (percentage-positioned so it scales with the page).
      const eb = el('div', 'pos-ebox');
      placeEbox(eb, b, pg);
      const et = el('div', 'eb-text', text());
      eb.append(et);
      if (rec._editing) {
        eb.classList.add('editable');
        et.spellcheck = false;
        const del = el('button', 'eb-del', '×'); del.title = 'Excluir';
        const rez = el('div', 'eb-resize'); rez.title = 'Redimensionar';
        eb.append(del, rez);
        wireEbox(eb, et, del, rez, b, pg, inner, rec, pi, idx);
      }
      inner.append(eb);

      const li = el('div', 'pos-list-item ' + cc);
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      const confTxt = b.conf != null ? `, confiança ${Math.round(b.conf * 100)}%` : '';
      li.setAttribute('aria-label', `Região ${idx + 1}: ${text() || '(sem texto)'}${confTxt}`);
      li.append(el('span', 'pos-idx', String(idx + 1)));
      li.append(el('span', 'pos-li-text', text()));
      if (b.conf != null) { const cf = el('span', 'pos-conf', Math.round(b.conf * 100) + '%'); li.append(cf); }
      const hi = () => { shape.classList.add('hot'); eb.classList.add('hot'); li.classList.add('hot'); };
      const lo = () => { shape.classList.remove('hot'); eb.classList.remove('hot'); li.classList.remove('hot'); };
      shape.addEventListener('mouseenter', hi); shape.addEventListener('mouseleave', lo);
      eb.addEventListener('mouseenter', hi); eb.addEventListener('mouseleave', lo);
      li.addEventListener('mouseenter', hi); li.addEventListener('mouseleave', lo);
      li.addEventListener('focus', hi); li.addEventListener('blur', lo);
      li.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && rec._editing) { e.preventDefault(); eb.focus(); }
      });
      list.append(li);
    });

    inner.append(svg);
    stage.append(inner);
    row.append(stage, list);
    body.append(row);
  });
}

// Position an overlay box using page-pixel coords as percentages.
function placeEbox(eb, b, pg) {
  eb.style.left = (b.x / pg.width * 100) + '%';
  eb.style.top = (b.y / pg.height * 100) + '%';
  eb.style.width = (b.w / pg.width * 100) + '%';
  eb.style.height = (b.h / pg.height * 100) + '%';
}

// Wire drag (move), resize handle, delete and inline text editing on a box.
// Move = press-and-drag anywhere on the box; edit text = double-click.
function wireEbox(eb, et, del, rez, b, pg, inner, rec, pi, idx, onTextChange) {
  et.contentEditable = 'false';
  const scale = () => { const r = inner.getBoundingClientRect(); return { sx: pg.width / r.width, sy: pg.height / r.height }; };
  const drag = (e, onMove) => {
    e.preventDefault();
    const { sx, sy } = scale();
    const x0 = e.clientX, y0 = e.clientY;
    const tgt = e.currentTarget;
    tgt.setPointerCapture(e.pointerId);
    const move = (ev) => onMove((ev.clientX - x0) * sx, (ev.clientY - y0) * sy);
    const up = () => { tgt.releasePointerCapture?.(e.pointerId); tgt.removeEventListener('pointermove', move); tgt.removeEventListener('pointerup', up); saveDoc(rec); };
    tgt.addEventListener('pointermove', move); tgt.addEventListener('pointerup', up);
  };
  eb.addEventListener('pointerdown', (e) => {
    if (e.target === del || e.target === rez) return;
    if (et.isContentEditable) return; // editing text — let the caret work, don't drag
    const ox = b.x, oy = b.y;
    drag(e, (dx, dy) => { b.x = Math.max(0, ox + dx); b.y = Math.max(0, oy + dy); placeEbox(eb, b, pg); });
  });
  rez.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const ow = b.w, oh = b.h;
    drag(e, (dx, dy) => { b.w = Math.max(10, ow + dx); b.h = Math.max(8, oh + dy); placeEbox(eb, b, pg); });
  });
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    rec.ocrPages[pi].boxes.splice(idx, 1);
    if (rec.translations?.[pi]) rec.translations[pi].splice(idx, 1);
    saveDoc(rec);
    renderPositions(rec);
    if (!$('doc-view').hidden) renderTranslation(rec);
  });
  // Double-click enters text edit; blur saves and returns to move mode.
  et.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    et.contentEditable = 'true';
    et.focus();
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(et); sel.removeAllRanges(); sel.addRange(r);
  });
  et.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); et.blur(); }
    if (e.key === 'Escape') { et.blur(); }
  });
  et.addEventListener('blur', () => {
    if (!et.isContentEditable) return;
    et.contentEditable = 'false';
    const v = et.textContent.trim();
    if (rec.translations?.[pi]?.[idx] != null && rec.translations[pi][idx] !== '') rec.translations[pi][idx] = v; else b.text = v;
    saveDoc(rec);
    onTextChange && onTextChange(v);
  });

  // Keyboard control (accessibility): focus a box and nudge / resize / edit /
  // delete it — a full alternative to mouse drag for the same operations.
  eb.setAttribute('tabindex', '0');
  eb.setAttribute('role', 'button');
  eb.setAttribute('aria-label',
    `Caixa de texto: ${et.textContent.trim() || '(vazia)'}. Setas movem, Shift+setas redimensionam, Enter edita, Delete exclui.`);
  const step = Math.max(1, Math.round(pg.width * 0.006));
  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  eb.addEventListener('keydown', (e) => {
    if (et.isContentEditable) return; // editing text: let the caret handle keys
    if (e.key === 'Enter') { e.preventDefault(); et.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return; }
    if (e.key === 'Delete') { e.preventDefault(); del.click(); return; }
    const d = ARROWS[e.key];
    if (!d) return;
    e.preventDefault();
    if (e.shiftKey) { b.w = Math.max(10, b.w + d[0] * step); b.h = Math.max(8, b.h + d[1] * step); }
    else { b.x = Math.max(0, b.x + d[0] * step); b.y = Math.max(0, b.y + d[1] * step); }
    placeEbox(eb, b, pg);
    saveDoc(rec);
  });
}

async function pageImageURL(rec, pg, urls) {
  // Prefer the raster cached during OCR — instant, and no pdf.js re-render.
  if (pg && pg.raster) return pg.raster;
  if (rec.isImage) {
    const type = 'image/' + (rec.imageExt === 'jpg' ? 'jpeg' : (rec.imageExt || 'png'));
    const url = URL.createObjectURL(new Blob([rec.bytes], { type }));
    (urls || rec._posUrls).push(url);
    return url;
  }
  // PDF without a cached raster (older docs): re-render at the OCR scale.
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: rec.bytes.slice() }).promise;
  const page = await pdf.getPage(pg.page);
  const canvas = await renderPdfPage(page, pg.scale || 2);
  const url = canvas.toDataURL('image/png');
  canvas.width = canvas.height = 0;
  return url;
}

// Load a page image into an <img> without ever breaking the surrounding render:
// on failure (e.g. a backgrounded tab stalling pdf.js) the boxes/cards still show.
function loadPageImage(img, rec, pg, urls) {
  Promise.resolve()
    .then(() => pageImageURL(rec, pg, urls))
    .then((src) => {
      if (!src) return;
      img.src = src;
      // Backfill the cache: a freshly rendered PDF page (data URL) is stored so
      // the next view is instant and it survives reloads. Older OCR'd docs
      // self-heal the first time they're opened in a foreground tab.
      if (!pg.raster && typeof src === 'string' && src.startsWith('data:')) {
        pg.raster = src;
        saveDoc(rec);
      }
    })
    .catch(() => { img.alt = 'pré-visualização indisponível'; img.classList.add('img-failed'); });
}

// ============================================================
//  Translation — layout-preserving, in place, in real time.
//  Each detected box is translated by the user's chosen engine
//  (local Ollama or an API key) and the translation is dropped
//  back onto its exact position (BabelDOC-style). Results and a
//  glossary (term → translation, per target language) persist.
// ============================================================
let trAbort = null;

async function renderTranslation(rec) {
  const tb = $('tr-toolbar');
  const body = $('translate');
  tb.innerHTML = '';
  body.innerHTML = '';
  (rec._trUrls || []).forEach((u) => URL.revokeObjectURL(u));
  rec._trUrls = [];
  if (!rec.translations) rec.translations = rec.ocrPages.map((p) => p.boxes.map(() => null));

  const cfg = loadCfg();

  tb.append(el('span', 'tr-k', 'Idioma-alvo:'));
  const target = el('select', 'tr-target');
  const cur = rec.trTarget || cfg.target || 'Português';
  TARGET_LANGS.forEach(([name]) => { const o = el('option', null, name); o.value = name; if (name === cur) o.selected = true; target.append(o); });
  target.addEventListener('change', () => { rec.trTarget = target.value; saveDoc(rec); });
  tb.append(target);

  // Document type = translation context. Auto-detected, editable, persisted.
  tb.append(el('span', 'tr-k', 'Tipo:'));
  const typeSel = el('input', 'tr-type');
  typeSel.setAttribute('list', 'tr-type-list');
  typeSel.value = rec.docType || classifyDocType(rec);
  typeSel.title = 'Tipo/estilo do documento — usado como contexto da tradução';
  typeSel.addEventListener('change', () => { rec.docType = typeSel.value.trim(); saveDoc(rec); });
  tb.append(typeSel);
  if (!document.getElementById('tr-type-list')) {
    const dl = el('datalist'); dl.id = 'tr-type-list';
    ['geral', 'juridico-fiscal', 'tecnico', 'tabular', 'academico', 'medico', 'financeiro', 'contrato', 'marketing']
      .forEach((t) => { const o = document.createElement('option'); o.value = t; dl.append(o); });
    document.body.append(dl);
  }

  const runBtn = el('button', 'primary-btn sm', '⚡ Traduzir documento');
  tb.append(runBtn);

  const provTag = el('span', 'struct-stat');
  const provLabel = {
    ollama: `<b>Ollama</b> ${cfg.ollamaModel || 'llama3.1'}`,
    openai: `<b>API</b> ${cfg.apiModel || 'gpt-4o-mini'}`,
    libre: `<b>LibreTranslate</b>`,
    bergamot: `<b>Bergamot</b> no navegador`,
  }[cfg.provider] || `<b>${cfg.provider}</b>`;
  provTag.innerHTML = provLabel;
  tb.append(provTag);

  const gear = el('button', 'ghost-btn sm', 'Configurar');
  gear.addEventListener('click', openSettings);
  tb.append(gear);

  // Substitute the translated text ON the document (enable/disable), and an
  // edit mode to move/resize the text boxes right on the page.
  const overlayToggle = el('button', 'ghost-btn sm', rec._trOverlay ? '📄 Tradução no documento' : '📄 Substituir no documento');
  overlayToggle.classList.toggle('on', !!rec._trOverlay);
  overlayToggle.addEventListener('click', () => { rec._trOverlay = !rec._trOverlay; if (!rec._trOverlay) rec._trEditing = false; renderTranslation(rec); });
  const editToggle = el('button', 'ghost-btn sm', rec._trEditing ? '✓ Concluir edição' : '✏️ Editar caixas');
  editToggle.classList.toggle('on', !!rec._trEditing);
  editToggle.addEventListener('click', () => { rec._trEditing = !rec._trEditing; if (rec._trEditing) rec._trOverlay = true; renderTranslation(rec); });
  tb.append(overlayToggle, editToggle);

  const prog = el('span', 'tr-prog');
  prog.style.marginLeft = 'auto';
  prog.setAttribute('role', 'status');
  prog.setAttribute('aria-live', 'polite');
  tb.append(prog);

  const hasTr = rec.translations.some((pg) => pg.some(Boolean));

  const dl = el('button', 'ghost-btn sm', 'Baixar .md');
  dl.id = 'tr-download';
  dl.hidden = !hasTr;
  dl.addEventListener('click', () => {
    const md = rebuildTranslatedMarkdown(rec);
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${rec.base}.${(rec.trTarget || 'traduzido').slice(0, 12)}.md` });
    a.click();
    URL.revokeObjectURL(url);
  });
  tb.append(dl);

  // Export the translated document as a PDF (raster + translation baked in).
  const dlpdf = el('button', 'ghost-btn sm', 'Baixar PDF traduzido');
  dlpdf.id = 'tr-download-pdf';
  dlpdf.hidden = !hasTr;
  dlpdf.addEventListener('click', async () => {
    dlpdf.disabled = true;
    const original = dlpdf.textContent;
    try {
      await exportTranslatedPDF(rec, (i, n) => { dlpdf.textContent = `Gerando PDF ${i}/${n}…`; });
      dlpdf.textContent = 'PDF baixado ✓';
    } catch (e) {
      dlpdf.textContent = 'Erro: ' + (e.message || e);
    } finally {
      setTimeout(() => { dlpdf.textContent = original; dlpdf.disabled = false; }, 2000);
    }
  });
  tb.append(dlpdf);

  // CAT-style workbench: the page (with its regions) on the left, an editable
  // source → target segment list on the right. Hovering a segment lights up
  // its region and vice-versa — clean, professional, easy to proofread.
  const wb = el('div', 'tr-workbench');
  const docCol = el('div', 'tr-doc');
  const segCol = el('div', 'tr-segments');
  wb.append(docCol, segCol);
  body.append(wb);

  for (let pi = 0; pi < rec.ocrPages.length; pi++) {
    const pg = rec.ocrPages[pi];
    // --- left: page raster with thin region boxes ---
    const page = el('div', 'tr-page');
    page.style.aspectRatio = `${pg.width} / ${pg.height}`;
    page.classList.toggle('overlay', !!rec._trOverlay);
    page.classList.toggle('editing', !!rec._trEditing);
    if (rec.overlayFont) page.style.setProperty('--overlay-font', rec.overlayFont);
    const img = el('img', 'tr-page-img');
    loadPageImage(img, rec, pg, rec._trUrls);
    page.append(img);
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'tr-page-svg');
    svg.setAttribute('viewBox', `0 0 ${pg.width} ${pg.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    page.append(svg);
    docCol.append(page);

    // --- right: a card per region ---
    if (rec.ocrPages.length > 1) segCol.append(el('div', 'seg-page-sep', `Página ${pg.page}`));
    pg.boxes.forEach((b, bi) => {
      const box = document.createElementNS(SVGNS, 'rect');
      box.setAttribute('x', b.x); box.setAttribute('y', b.y);
      box.setAttribute('width', b.w); box.setAttribute('height', b.h);
      box.setAttribute('class', 'tr-box');
      box.id = `tr-box-${pi}-${bi}`;
      box.setAttribute('aria-hidden', 'true'); // decorative; the segment card is the AT-facing control
      svg.append(box);

      // Overlay box on the document: shows the translation in place, editable /
      // movable when in edit mode. Kept in sync with the segment card.
      const eb = el('div', 'pos-ebox');
      placeEbox(eb, b, pg);
      const et = el('div', 'eb-text');
      et.id = `tr-ov-${pi}-${bi}`;
      et.textContent = rec.translations[pi][bi] || b.text;
      eb.append(et);
      if (rec._trEditing) {
        eb.classList.add('editable');
        et.spellcheck = false;
        const del = el('button', 'eb-del', '×'); del.title = 'Excluir';
        const rez = el('div', 'eb-resize'); rez.title = 'Redimensionar';
        eb.append(del, rez);
        wireEbox(eb, et, del, rez, b, pg, page, rec, pi, bi, (v) => {
          const ct = document.getElementById(`tr-lbl-${pi}-${bi}`);
          if (ct) ct.textContent = v;
          document.getElementById(`tr-card-${pi}-${bi}`)?.classList.toggle('done', !!v);
        });
      }
      page.append(eb);

      const card = el('div', 'seg-card');
      card.id = `tr-card-${pi}-${bi}`;
      const head = el('div', 'seg-head');
      head.append(el('span', 'seg-num', String(bi + 1)));
      const status = el('span', 'seg-status');
      head.append(status);
      card.append(head);
      card.append(el('div', 'seg-src', b.text));

      const tgt = el('div', 'seg-tgt');
      tgt.id = `tr-lbl-${pi}-${bi}`;
      tgt.contentEditable = 'true';
      tgt.spellcheck = false;
      tgt.dataset.placeholder = 'tradução…';
      tgt.setAttribute('role', 'textbox');
      tgt.setAttribute('aria-label', `Tradução da região ${bi + 1}: ${b.text}`);
      const done = rec.translations[pi][bi];
      if (done) { tgt.textContent = done; card.classList.add('done'); }
      tgt.addEventListener('focus', () => { card.classList.add('editing'); box.classList.add('on'); });
      tgt.addEventListener('blur', () => {
        card.classList.remove('editing');
        box.classList.remove('on');
        rec.translations[pi][bi] = tgt.textContent.trim();
        card.classList.toggle('done', !!tgt.textContent.trim());
        const ov = document.getElementById(`tr-ov-${pi}-${bi}`);
        if (ov) ov.textContent = tgt.textContent.trim() || b.text;
        saveDoc(rec);
      });
      tgt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); tgt.blur(); }
        if (e.key === 'Escape') { tgt.textContent = rec.translations[pi][bi] || ''; tgt.blur(); }
      });
      card.append(tgt);
      segCol.append(card);

      // Hover/focus sync between the region and its card.
      const on = () => { box.classList.add('on'); card.classList.add('on'); };
      const off = () => { box.classList.remove('on'); card.classList.remove('on'); };
      card.addEventListener('mouseenter', on); card.addEventListener('mouseleave', off);
      box.addEventListener('mouseenter', on); box.addEventListener('mouseleave', off);
      box.addEventListener('click', () => { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); tgt.focus(); });
    });
  }

  runBtn.addEventListener('click', () => {
    if (trAbort) { trAbort.abort(); trAbort = null; runBtn.textContent = '⚡ Traduzir documento'; return; }
    translateDoc(rec, target.value, prog, runBtn);
  });
}

async function translateDoc(rec, target, prog, runBtn) {
  const cfg = { ...loadCfg(), target };
  rec.trTarget = target;
  trAbort = new AbortController();
  runBtn.textContent = 'Parar';

  // A run re-translates the whole document (so changing the target language, or
  // simply clicking again, always works). Start from a clean slate.
  rec.translations = rec.ocrPages.map((pg) => pg.boxes.map(() => null));
  const jobs = [];
  rec.ocrPages.forEach((pg, pi) => pg.boxes.forEach((b, bi) => jobs.push({ pi, bi, text: b.text })));
  const total = jobs.length;
  let done = 0;

  // Context: detected source language + the glossary for this target.
  const sample = jobs.slice(0, 12).map((j) => j.text).join(' ');
  const src = detectLang(sample);
  rec.trSource = src;
  const glossary = loadGlossary(target);
  const docType = rec.docType || classifyDocType(rec);
  rec.docType = docType;
  const ctx = { glossary, sourceName: src.name, sourceIso1: src.iso1 || undefined, docType };

  const BATCH = cfg.provider === 'libre' ? 25 : 12; // libre handles arrays well; LLMs stay reliable smaller
  const q = (id) => document.getElementById(id);
  // Mark a region as "being translated" on both the card and the document
  // itself — the SVG box marches (overlay off) or the in-place text shimmers
  // (overlay on), so you can watch the page fill in region by region.
  const markWork = (pi, bi, on) => {
    q(`tr-card-${pi}-${bi}`)?.classList[on ? 'add' : 'remove']('working');
    q(`tr-ov-${pi}-${bi}`)?.parentElement?.classList[on ? 'add' : 'remove']('working');
    q(`tr-box-${pi}-${bi}`)?.classList[on ? 'add' : 'remove']('working');
  };
  const setSeg = (pi, bi, text) => {
    const tgt = q(`tr-lbl-${pi}-${bi}`);
    const card = q(`tr-card-${pi}-${bi}`);
    const et = q(`tr-ov-${pi}-${bi}`);
    const eb = et?.parentElement;
    if (tgt) tgt.textContent = text;
    if (et) et.textContent = text; // live substitution on the document
    q(`tr-box-${pi}-${bi}`)?.classList.remove('working');
    if (card) { card.classList.remove('working'); card.classList.add('done'); }
    if (eb) {
      eb.classList.remove('working');
      eb.classList.add('just'); // brief "landed" flash
      setTimeout(() => eb.classList.remove('just'), 500);
    }
  };
  const clearWork = () => document.querySelectorAll('.seg-card.working,.tr-box.working,.pos-ebox.working')
    .forEach((n) => n.classList.remove('working'));

  try {
    for (let i = 0; i < jobs.length; i += BATCH) {
      if (trAbort.signal.aborted) break;
      const slice = jobs.slice(i, i + BATCH);
      slice.forEach((j) => markWork(j.pi, j.bi, true));
      prog.textContent = `Traduzindo ${done + 1}–${Math.min(done + slice.length, total)} de ${total}…`;
      const outs = await translateBatch(slice.map((j) => j.text), cfg, trAbort.signal, ctx);
      // Reveal the batch's results one at a time so the document visibly
      // streams in, region by region, instead of a whole page snapping at once.
      for (let k = 0; k < slice.length; k++) {
        if (trAbort.signal.aborted) break;
        const j = slice[k];
        const out = (outs[k] || '').trim();
        rec.translations[j.pi][j.bi] = out;
        recordGlossary(j.text, out, target, docType);
        setSeg(j.pi, j.bi, out || j.text);
        done += 1;
        prog.textContent = `Traduzindo ${done} de ${total}…`;
        if (k < slice.length - 1) await new Promise((r) => setTimeout(r, 40));
      }
      saveDoc(rec); // checkpoint each batch so progress survives interruptions
    }
    if (!trAbort?.signal.aborted) prog.textContent = `Concluído · ${done}/${total} · ${src.name} → ${target}`;
  } catch (err) {
    if (!trAbort?.signal.aborted) prog.textContent = `Erro: ${err.message}`;
  }
  clearWork();

  trAbort = null;
  runBtn.textContent = '⚡ Traduzir documento';
  saveDoc(rec);
  const dl = document.getElementById('tr-download');
  if (dl) dl.hidden = false;
}

// Size a label's text to fill the line: start from ~72% of the box height so
// the type matches the original line, then shrink only if it overflows width.
function fitLabel(lab) {
  const h = lab.clientHeight || 16;
  let size = Math.max(7, Math.min(28, Math.round(h * 0.66)));
  lab.style.fontSize = size + 'px';
  let guard = 0;
  while (lab.scrollWidth > lab.clientWidth + 1 && size > 6 && guard++ < 30) {
    size -= 1;
    lab.style.fontSize = size + 'px';
  }
}

// Rough document-type hint for the glossary (technical vs general vs table).
function classifyDocType(rec) {
  const t = (rec.ocrMarkdown || rec.markdown || '').toLowerCase();
  if (/\b(art\.|cláusula|contrato|cnpj|cpf|processo|nota fiscal)\b/.test(t)) return 'juridico-fiscal';
  if (/\b(function|const|import|select |from |api|endpoint|json)\b/.test(t)) return 'tecnico';
  if ((rec.stats?.tables || 0) > 0) return 'tabular';
  return 'geral';
}

// Rebuild a translated Markdown from the per-box translations, page by page.
function rebuildTranslatedMarkdown(rec) {
  if (!rec.translations) return '';
  const parts = [];
  rec.ocrPages.forEach((pg, pi) => {
    const lines = pg.boxes.map((b, bi) => rec.translations[pi][bi] || b.text).filter(Boolean);
    if (lines.length) parts.push((rec.ocrPages.length > 1 ? `<!-- Página ${pg.page} -->\n\n` : '') + lines.join('\n\n'));
  });
  return parts.join('\n\n');
}

let editTimer;
$('md-editor').addEventListener('input', (e) => {
  const rec = docs.get(activeId);
  if (rec) rec.markdown = e.target.value;
  clearTimeout(editTimer);
  editTimer = setTimeout(() => renderPreview(e.target.value, rec), 120);
});

// ============================================================
//  PDF analysis panel (pdf-inspector)
// ============================================================
const PDF_TYPE_META = {
  TextBased: { label: 'Texto nativo', color: 'var(--ok)', desc: 'Texto extraível diretamente — sem OCR.' },
  Scanned: { label: 'Digitalizado', color: 'var(--error)', desc: 'Páginas em imagem — precisam de OCR.' },
  ImageBased: { label: 'Baseado em imagem', color: 'var(--error)', desc: 'Conteúdo é imagem — precisa de OCR.' },
  Mixed: { label: 'Misto', color: 'var(--heat)', desc: 'Parte texto, parte imagem — OCR parcial.' },
};

function renderPdf(rec) {
  renderPdfOptions(rec);
  const box = $('pdf-report');
  box.innerHTML = '';
  const p = rec.pdf;
  const meta = PDF_TYPE_META[p.pdfType] || { label: p.pdfType, color: 'var(--text-muted)', desc: '' };

  // Hero: classification + confidence gauge
  const hero = el('div', 'pdf-hero');
  const cls = el('div', 'pdf-class');
  const dot = el('span', 'pdf-class-dot');
  dot.style.background = meta.color;
  cls.append(dot);
  const clsText = el('div');
  clsText.append(el('div', 'pdf-class-label', meta.label));
  clsText.append(el('div', 'pdf-class-desc', meta.desc));
  cls.append(clsText);
  hero.append(cls);

  const conf = Math.round((p.confidence || 0) * 100);
  const gauge = el('div', 'pdf-gauge');
  gauge.style.setProperty('--pct', conf);
  gauge.style.setProperty('--gcolor', meta.color);
  gauge.innerHTML = `<div class="pdf-gauge-num">${conf}<span>%</span></div><div class="pdf-gauge-cap">confiança</div>`;
  hero.append(gauge);
  box.append(hero);

  if (p.title) {
    const t = el('div', 'pdf-title-row');
    t.append(el('span', 'pdf-k', 'Título'));
    t.append(el('span', 'pdf-v', p.title));
    box.append(t);
  }

  // Metric tiles
  const grid = el('div', 'pdf-metrics');
  const tile = (val, label, warn) => {
    const t = el('div', 'pdf-tile' + (warn ? ' warn' : ''));
    t.append(el('div', 'pdf-tile-val', String(val)));
    t.append(el('div', 'pdf-tile-lab', label));
    return t;
  };
  grid.append(tile(p.pageCount, 'páginas'));
  grid.append(tile(`${p.processingTimeMs} ms`, 'no motor'));
  grid.append(tile(p.pagesNeedingOcr.length, 'páginas p/ OCR', p.pagesNeedingOcr.length > 0));
  grid.append(tile(p.layout.pagesWithTables.length, 'páginas c/ tabelas'));
  grid.append(tile(p.layout.pagesWithColumns.length, 'páginas c/ colunas'));
  grid.append(tile(p.hasEncodingIssues ? 'Sim' : 'Não', 'problemas de encoding', p.hasEncodingIssues));
  box.append(grid);

  // Layout complexity note
  if (p.layout.isComplex || p.layout.pagesWithTables.length || p.layout.pagesWithColumns.length) {
    const sec = el('div', 'pdf-section');
    sec.append(el('h4', null, 'Layout'));
    const list = el('div', 'pdf-pagelist');
    if (p.layout.pagesWithTables.length)
      list.append(pageChips('Tabelas em', p.layout.pagesWithTables));
    if (p.layout.pagesWithColumns.length)
      list.append(pageChips('Colunas em', p.layout.pagesWithColumns));
    if (!p.layout.pagesWithTables.length && !p.layout.pagesWithColumns.length)
      list.append(el('div', 'pdf-muted', p.layout.isComplex ? 'Layout marcado como complexo.' : 'Layout simples.'));
    sec.append(list);
    box.append(sec);
  }

  // OCR routing
  const ocrSec = el('div', 'pdf-section');
  ocrSec.append(el('h4', null, 'Roteamento de OCR'));
  if (!p.pagesNeedingOcr.length) {
    ocrSec.append(el('div', 'pdf-ok', '✓ Nenhuma página precisa de OCR — todo o texto foi extraído localmente.'));
  } else {
    ocrSec.append(el('div', 'pdf-muted', `${p.pagesNeedingOcr.length} de ${p.pageCount} páginas precisariam de OCR:`));
    const reasonsMap = new Map(p.ocrReasonsByPage.map((r) => [r.page, r.reasons]));
    const rl = el('div', 'pdf-ocr-list');
    for (const page of p.pagesNeedingOcr) {
      const row = el('div', 'pdf-ocr-row');
      row.append(el('span', 'pdf-ocr-page', `p.${page}`));
      const reasons = reasonsMap.get(page) || [];
      const rs = el('div', 'pdf-ocr-reasons');
      if (reasons.length) reasons.forEach((r) => rs.append(el('span', 'pdf-reason', r)));
      else rs.append(el('span', 'pdf-reason', 'imagem/sem texto'));
      row.append(rs);
      rl.append(row);
    }
    ocrSec.append(rl);
    ocrSec.append(el('p', 'pdf-hint', 'anydoc/pdf-inspector não fazem OCR. Para essas páginas, use um serviço de OCR como o Firecrawl Parse por cima desta mesma conversão.'));
  }
  box.append(ocrSec);

  // Encoding warning
  if (p.hasEncodingIssues) {
    const w = el('div', 'pdf-warning');
    w.innerHTML = '<b>⚠ Problemas de encoding detectados.</b> Algumas fontes têm codificação quebrada; parte do texto extraído pode estar incorreta. Um passo de OCR é recomendado como fallback.';
    box.append(w);
  }
}

function pageChips(label, pages) {
  const wrap = el('div', 'pdf-pagechips');
  wrap.append(el('span', 'pdf-k', label));
  const cap = pages.slice(0, 40);
  cap.forEach((n) => wrap.append(el('span', 'pdf-page-chip', String(n))));
  if (pages.length > cap.length) wrap.append(el('span', 'pdf-muted', `+${pages.length - cap.length}`));
  return wrap;
}

function renderPdfOptions(rec) {
  const bar = $('pdf-options');
  bar.innerHTML = '';
  const label = el('span', 'pdf-opt-label', 'Conversão:');
  bar.append(label);

  const seg = el('div', 'seg');
  ['fidelity', 'compact'].forEach((mode) => {
    const b = el('button', 'seg-btn' + (rec.pdfOptions.profile === mode ? ' on' : ''), mode === 'fidelity' ? 'Fiel à fonte' : 'Compacto');
    b.addEventListener('click', () => {
      if (rec.pdfOptions.profile === mode) return;
      rec.pdfOptions.profile = mode;
      saveDoc(rec);
      runConvert(rec);
    });
    seg.append(b);
  });
  bar.append(seg);

  const toggle = el('button', 'seg-btn toggle' + (rec.pdfOptions.pageMarkers ? ' on' : ''), 'Marcadores de página');
  toggle.addEventListener('click', () => {
    rec.pdfOptions.pageMarkers = !rec.pdfOptions.pageMarkers;
    saveDoc(rec);
    runConvert(rec);
  });
  bar.append(toggle);
}

// ============================================================
//  Structure tree (from anydoc toDocument)
// ============================================================
function inlineText(inlines) {
  if (!inlines) return '';
  return inlines.map((i) => {
    if (i.kind === 'text') return i.text || '';
    if (i.kind === 'link') return inlineText(i.content);
    if (i.kind === 'image') return `🖼 ${i.alt || 'imagem'}`;
    if (i.kind === 'lineBreak') return ' ';
    if (i.kind === 'noteRef') return '·';
    return '';
  }).join('');
}

function renderStructure(rec) {
  const tb = $('struct-toolbar');
  const tree = $('structure');
  tb.innerHTML = '';
  tree.innerHTML = '';

  if (!rec.model) {
    const note = el('div');
    note.style.cssText = 'color:var(--text-muted);font-family:var(--sans);padding:24px;text-align:center;line-height:1.6';
    note.innerHTML = rec.format === 'pdf'
      ? 'PDFs são analisados pelo <b>pdf-inspector</b> e convertidos direto para Markdown — não há modelo de blocos do anydoc. Veja a aba <b>Análise PDF</b> para classificação, layout e roteamento de OCR.'
      : 'Modelo de documento indisponível para este arquivo.';
    tree.append(note);
    return;
  }

  const s = rec.stats;
  const stat = (label, val) => {
    const n = el('span', 'struct-stat');
    n.innerHTML = `<b>${val}</b> ${label}`;
    return n;
  };
  tb.append(stat('blocos', nf(s.blocks)), stat('títulos', s.headings),
    stat('tabelas', s.tables), stat('listas', s.lists),
    stat('notas', s.notes), stat('recursos', s.assets));

  const collapse = el('button', 'ghost-btn sm', 'Recolher tudo');
  collapse.style.marginLeft = 'auto';
  let collapsed = false;
  collapse.addEventListener('click', () => {
    collapsed = !collapsed;
    tree.querySelectorAll('.node-children').forEach((c) => c.classList.toggle('collapsed', collapsed));
    tree.querySelectorAll('.node-toggle:not(.leaf)').forEach((t) => t.textContent = collapsed ? '▸' : '▾');
    collapse.textContent = collapsed ? 'Expandir tudo' : 'Recolher tudo';
  });
  tb.append(collapse);

  const frag = document.createDocumentFragment();
  rec.model.blocks.forEach((b) => frag.append(blockNode(b, rec)));
  tree.append(frag);
}

function blockNode(b, rec) {
  const node = el('div', 'node');
  const row = el('div', 'node-row');
  const toggle = el('span', 'node-toggle');
  row.append(toggle);

  const label = b.kind === 'blockQuote' ? 'quote' : b.kind === 'codeBlock' ? 'code' : b.kind;
  row.append(el('span', 'kind ' + b.kind.toLowerCase(), label));

  let children = null;

  if (b.kind === 'heading') {
    row.append(el('span', 'node-tag', `H${b.level}`));
    row.append(el('span', 'node-text', inlineText(b.content)));
  } else if (b.kind === 'paragraph') {
    row.append(el('span', 'node-text', inlineText(b.content) || '∅'));
  } else if (b.kind === 'codeBlock') {
    if (b.lang) row.append(el('span', 'node-tag', b.lang));
    row.append(el('span', 'node-text', (b.text || '').split('\n')[0]));
  } else if (b.kind === 'rule') {
    row.append(el('span', 'node-text', '───'));
  } else if (b.kind === 'list') {
    const items = b.list.items;
    row.append(el('span', 'node-tag', `${b.list.marker} · ${items.length} itens`));
    children = el('div', 'node-children');
    items.forEach((it, idx) => {
      const iNode = el('div', 'node');
      const iRow = el('div', 'node-row');
      iRow.append(el('span', 'node-toggle leaf'));
      const chk = it.checked === true ? '☑ ' : it.checked === false ? '☐ ' : '';
      iRow.append(el('span', 'kind list', `item ${idx + 1}`));
      iRow.append(el('span', 'node-text', chk + (it.blocks.map((bb) => inlineText(bb.content)).join(' ') || '')));
      iNode.append(iRow);
      const sub = el('div', 'node-children');
      it.blocks.forEach((bb) => sub.append(blockNode(bb, rec)));
      if (it.blocks.some((bb) => bb.kind !== 'paragraph')) iNode.append(sub);
      children.append(iNode);
    });
  } else if (b.kind === 'blockQuote') {
    row.append(el('span', 'node-tag', `${b.blocks.length} blocos`));
    children = el('div', 'node-children');
    b.blocks.forEach((bb) => children.append(blockNode(bb, rec)));
  } else if (b.kind === 'table') {
    const grid = b.table.grid;
    const rows = grid.length, cols = grid[0]?.length || 0;
    row.append(el('span', 'node-tag', `${rows}×${cols}${b.table.kind === 'layout' ? ' · layout' : ''}`));
    children = el('div', 'node-children');
    children.append(miniTable(b.table));
  }

  node.append(row);
  if (children && children.childNodes.length) {
    toggle.textContent = '▾';
    toggle.addEventListener('click', () => {
      const c = children.classList.toggle('collapsed');
      toggle.textContent = c ? '▸' : '▾';
    });
    node.append(children);
  } else {
    toggle.classList.add('leaf');
  }
  return node;
}

function miniTable(table) {
  const t = el('table', 'struct-mini-table');
  table.grid.forEach((row, r) => {
    const tr = el('tr');
    row.forEach((slot) => {
      if (slot.kind === 'covered') {
        tr.append(el('td', 'cov', '↖'));
      } else {
        const cell = slot.cell;
        const txt = cell.blocks.map((bb) => inlineText(bb.content)).join(' ');
        const td = el('td', r < table.headerRows ? 'hd' : '', txt.slice(0, 40) || '');
        if (cell.colSpan > 1) td.colSpan = cell.colSpan;
        if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
        tr.append(td);
      }
    });
    t.append(tr);
  });
  return t;
}

// ============================================================
//  Assets gallery
// ============================================================
function renderAssets(rec) {
  const grid = $('assets');
  grid.innerHTML = '';
  const assets = rec.model?.assets || [];
  if (!assets.length) {
    grid.append(el('div', 'assets-empty', 'Nenhum recurso embutido neste documento.'));
    return;
  }
  for (const a of assets) {
    const card = el('div', 'asset-card');
    const thumb = el('div', 'asset-thumb');
    const url = rec.assetUrls[a.id];
    if (url) {
      const img = el('img');
      img.src = url; img.alt = a.originPart || '';
      thumb.append(img);
    } else {
      thumb.append(el('div', 'noimg', a.mediaType || 'binário'));
    }
    card.append(thumb);
    const info = el('div', 'asset-info');
    info.append(el('div', 'asset-mime', a.mediaType || 'application/octet-stream'));
    info.append(el('div', 'asset-sub', `#${a.id} · ${fmtBytes(a.data?.length || 0)}`));
    if (a.originPart) {
      const op = el('div', 'asset-sub');
      op.textContent = a.originPart; op.title = a.originPart;
      info.append(op);
    }
    card.append(info);
    grid.append(card);
  }
}

// ============================================================
//  Tabs
// ============================================================
function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
}
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab || tab.hidden) return;
  selectTab(tab.dataset.tab);
});

// ============================================================
//  Copy / Download
// ============================================================
$('btn-copy').addEventListener('click', async () => {
  const rec = docs.get(activeId);
  if (!rec) return;
  await navigator.clipboard.writeText(rec.markdown);
  const b = $('btn-copy');
  b.textContent = 'Copiado ✓';
  setTimeout(() => (b.textContent = 'Copiar'), 1200);
});
$('btn-download').addEventListener('click', () => {
  const rec = docs.get(activeId);
  if (!rec) return;
  const url = URL.createObjectURL(new Blob([rec.markdown], { type: 'text/markdown' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${rec.base}.md` });
  a.click();
  URL.revokeObjectURL(url);
});

// ============================================================
//  Samples
// ============================================================
const SAMPLES = {
  rtf: {
    name: 'notes.rtf',
    text: String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}
\pard\sa200 O anydoc l\u234? a {\b formata\u231?\u227?o}, a {\i \u234?nfase} e a {\b\i estrutura} de um documento e escreve o Markdown que diz a mesma coisa.\par
\pard\sa200 Este par\u225?grafo veio de um pequeno arquivo RTF montado nesta p\u225?gina. Solte um dos seus para ver uma convers\u227?o de verdade.\par
}`,
  },
  csv: {
    name: 'report.csv',
    text: 'formato,tipo,desde\ndocx,WordprocessingML,0.1.0\nepub,EPUB 2 e 3,0.1.0\nxlsx,Planilha Excel,0.1.0\npdf,via pdf-inspector,0.1.0\n',
  },
  'md-table': {
    name: 'tabela.csv',
    text: 'Metrica,anydoc,Proximo melhor\nformatos,14/14,12/14\nmediana ms,4.4,52.5\nscore,81,69\ncompletude,87,80\n',
  },
};
document.querySelectorAll('[data-sample]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!ready) return;
    const s = SAMPLES[btn.dataset.sample];
    intake(s.name, new TextEncoder().encode(s.text));
  });
});

// ============================================================
//  Scraping — URL → Markdown, into the same pipeline.
// ============================================================
async function doScrape() {
  if (!ready) return;
  const input = $('scrape-url');
  const msg = $('scrape-msg');
  const url = input.value.trim();
  if (!url) return;
  msg.hidden = false; msg.className = 'scrape-msg'; msg.textContent = 'Buscando…';
  $('scrape-go').disabled = true;
  try {
    const r = await scrapeUrl(url);
    const host = (() => { try { return new URL(r.url).hostname; } catch { return 'web'; } })();
    intake(`${host}.md`, r.bytes, r.bytes.length, { isWeb: true, markdown: r.markdown, sourceUrl: r.url });
    msg.textContent = `✓ ${r.via}`;
    msg.classList.add('ok');
    input.value = '';
    setTimeout(() => { msg.hidden = true; }, 2500);
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('err');
  } finally {
    $('scrape-go').disabled = false;
  }
}
$('scrape-go').addEventListener('click', doScrape);
$('scrape-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') doScrape(); });

// File-based samples (real PDF / DOCX shipped with the app).
document.querySelectorAll('[data-file]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!ready) return;
    btn.disabled = true;
    try {
      const path = btn.dataset.file;
      const buf = await (await fetch(path)).arrayBuffer();
      intake(path.split('/').pop(), new Uint8Array(buf), buf.byteLength);
    } finally {
      btn.disabled = false;
    }
  });
});

// ============================================================
//  Theme toggle
// ============================================================
const THEME_KEY = 'anydoc-studio-theme';
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme) document.body.dataset.theme = savedTheme;
// ============================================================
//  Ask (in-browser RAG over the active document)
// ============================================================
let asking = false;
// Build or reuse a document's embedding index. The index is persisted and
// reused across reloads; it is rebuilt only when the document's text changes.
async function ensureIndex(rec, status) {
  const len = (rec.markdown || '').length;
  if (rec.ragIndex && rec.ragFor === len) return rec.ragIndex;
  status.textContent = `Indexando ${rec.name}…`;
  rec.ragIndex = await buildIndex(rec.markdown, (i, n) => { status.textContent = `Indexando ${rec.name} ${i}/${n}…`; });
  rec.ragFor = len;
  saveDoc(rec);
  return rec.ragIndex;
}
async function askDoc() {
  if (asking) return;
  const rec = docs.get(activeId);
  const q = $('ask-input').value.trim();
  const body = $('ask-body');
  const scope = $('ask-scope').value;
  if (!rec || !q) return;

  const targets = scope === 'all'
    ? [...docs.values()].filter((d) => d.markdown && d.markdown.length >= 20)
    : (rec.markdown && rec.markdown.length >= 20 ? [rec] : []);
  if (!targets.length) {
    body.innerHTML = '<div class="ask-empty">Nenhum documento com texto suficiente. Rode o OCR nos scans primeiro.</div>';
    return;
  }

  asking = true;
  $('ask-go').disabled = true;
  const turn = el('div', 'ask-turn');
  turn.append(el('div', 'ask-q', q));
  const status = el('div', 'ask-status', 'Preparando…');
  turn.append(status);
  if (body.querySelector('.ask-empty')) body.innerHTML = '';
  body.prepend(turn);
  $('ask-input').value = '';

  try {
    // Build/reuse an index per target document, then search across them all.
    const combined = [];
    for (const d of targets) {
      const idx = await ensureIndex(d, status);
      const tag = targets.length > 1 ? d.name : null;
      combined.push(...idx.map((c) => ({ ...c, doc: tag })));
    }
    status.textContent = 'Buscando trechos relevantes…';
    const hits = await retrieve(q, combined, targets.length > 1 ? 6 : 5);
    status.textContent = 'Gerando resposta…';

    // Stream the answer into the bubble, re-rendering Markdown at a light cadence.
    const ans = el('div', 'ask-a streaming');
    turn.append(ans);
    status.remove();
    // Use a dedicated answer model when set (an instruction model beats a
    // translation-only model for Q&A).
    const ansCfg = loadCfg();
    if (ansCfg.answerModel) ansCfg.ollamaModel = ansCfg.answerModel;
    let last = 0;
    const full = await ragAnswerStream(q, hits, ansCfg, (_delta, acc) => {
      const now = performance.now();
      if (now - last > 90) { ans.innerHTML = marked.parse(acc); last = now; ans.scrollIntoView({ block: 'nearest' }); }
    });
    ans.classList.remove('streaming');
    ans.innerHTML = marked.parse(full || '_(sem resposta)_');

    const docsUsed = new Set(hits.map((h) => h.doc).filter(Boolean));
    const cites = el('details', 'ask-cites');
    cites.append(el('summary', null, `${hits.length} trechos usados${docsUsed.size ? ` · ${docsUsed.size} documentos` : ''}`));
    hits.forEach((h, n) => {
      const c = el('div', 'ask-cite');
      c.append(el('span', 'ask-cite-n', `[${n + 1}]`));
      if (h.doc) c.append(el('span', 'ask-cite-doc', h.doc));
      c.append(el('span', 'ask-cite-t', h.text.slice(0, 200) + (h.text.length > 200 ? '…' : '')));
      cites.append(c);
    });
    turn.append(cites);
  } catch (e) {
    status.textContent = 'Erro: ' + (e.message || e);
    status.classList.add('err');
  } finally {
    asking = false;
    $('ask-go').disabled = false;
  }
}
$('ask-go').addEventListener('click', askDoc);
$('ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') askDoc(); });

// ============================================================
//  Storage manager modal
// ============================================================
function derivedSize(rec) {
  let raster = 0, embed = 0;
  (rec.ocrPages || []).forEach((p) => { if (p.raster) raster += p.raster.length; });
  if (rec.ragIndex) embed = rec.ragIndex.length * 768 * 8; // ~Float64 per dim
  return { raster, embed, total: raster + embed };
}
async function renderStorage() {
  const list = $('stor-list');
  const usage = $('stor-usage');
  list.innerHTML = '';
  let est = null;
  try { est = await navigator.storage.estimate(); } catch { /* unsupported */ }
  if (est) {
    const usedMB = (est.usage / 1048576).toFixed(1);
    const quotaMB = (est.quota / 1048576).toFixed(0);
    const pct = Math.min(100, Math.round((est.usage / est.quota) * 100));
    usage.innerHTML = `<div class="stor-bar"><div class="stor-fill" style="width:${pct}%"></div></div>
      <div class="stor-usage-txt"><b>${usedMB} MB</b> usados de ${quotaMB} MB (${pct}%)</div>`;
  } else { usage.textContent = ''; }

  if (!docs.size) { list.append(el('div', 'gloss-empty', 'Nenhum documento armazenado.')); return; }
  for (const rec of docs.values()) {
    const d = derivedSize(rec);
    const row = el('div', 'gloss-row');
    const meta = el('div', 'stor-meta');
    meta.append(el('div', 'stor-name', rec.name));
    meta.append(el('div', 'stor-sub', `original ${fmtBytes(rec.size)} · derivados ${fmtBytes(d.total)}`
      + (rec.ragIndex ? ` · ${rec.ragIndex.length} embeddings` : '')));
    row.append(meta);
    const clr = el('button', 'ghost-btn sm', 'Limpar pesados');
    clr.disabled = d.total === 0;
    clr.addEventListener('click', () => {
      (rec.ocrPages || []).forEach((p) => { delete p.raster; });
      rec._posUrls?.forEach((u) => URL.revokeObjectURL(u));
      rec.ragIndex = null; rec.ragFor = null;
      saveDoc(rec);
      renderStorage();
    });
    row.append(clr);
    list.append(row);
  }
}
$('storage-btn').addEventListener('click', () => { renderStorage(); $('storage-modal').hidden = false; });
$('storage-close').addEventListener('click', () => { $('storage-modal').hidden = true; });
$('storage-modal').addEventListener('click', (e) => { if (e.target.id === 'storage-modal') $('storage-modal').hidden = true; });

// ============================================================
//  Word bank (glossary) modal
// ============================================================
function renderGlossary(filter = '') {
  const bank = loadGlossaryBank();
  const list = $('gloss-list');
  list.innerHTML = '';
  const f = filter.trim().toLowerCase();
  let count = 0;
  for (const lang of Object.keys(bank).sort()) {
    const entries = Object.entries(bank[lang])
      .filter(([term, v]) => !f || term.toLowerCase().includes(f) || String(v.t || v).toLowerCase().includes(f));
    if (!entries.length) continue;
    list.append(el('div', 'gloss-lang', `→ ${lang} · ${entries.length} termos`));
    for (const [term, v] of entries) {
      count++;
      const row = el('div', 'gloss-row');
      row.append(el('span', 'gloss-term', term));
      row.append(el('span', 'gloss-arrow', '→'));
      const t = el('input', 'gloss-trans'); t.value = (v && v.t) || v || '';
      t.addEventListener('change', () => {
        const b = loadGlossaryBank();
        if (b[lang] && b[lang][term]) { b[lang][term] = { t: t.value, type: (v && v.type) || 'geral' }; saveGlossaryBank(b); }
      });
      row.append(t);
      if (v && v.type) row.append(el('span', 'gloss-type', v.type));
      const del = el('button', 'gloss-del', '×');
      del.addEventListener('click', () => {
        const b = loadGlossaryBank();
        if (b[lang]) { delete b[lang][term]; if (!Object.keys(b[lang]).length) delete b[lang]; saveGlossaryBank(b); }
        renderGlossary($('gloss-search').value);
      });
      row.append(del);
      list.append(row);
    }
  }
  if (!count) list.append(el('div', 'gloss-empty', f ? 'Nenhum termo encontrado.' : 'Ainda vazio. Traduza documentos e os termos curtos serão memorizados aqui.'));
}
$('glossary-btn').addEventListener('click', () => { renderGlossary(); $('gloss-search').value = ''; $('glossary-modal').hidden = false; });
$('glossary-close').addEventListener('click', () => { $('glossary-modal').hidden = true; });
$('glossary-modal').addEventListener('click', (e) => { if (e.target.id === 'glossary-modal') $('glossary-modal').hidden = true; });
$('gloss-search').addEventListener('input', (e) => renderGlossary(e.target.value));
$('gloss-clear').addEventListener('click', () => { if (confirm('Limpar todo o banco de palavras?')) { saveGlossaryBank({}); renderGlossary(); } });
$('gloss-export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(loadGlossaryBank(), null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'banco-de-palavras.json' });
  a.click(); URL.revokeObjectURL(url);
});

$('theme-toggle').addEventListener('click', () => {
  const cur = document.body.dataset.theme;
  const isDark = cur === 'dark' || (cur === 'auto' && matchMedia('(prefers-color-scheme:dark)').matches);
  const next = isDark ? 'light' : 'dark';
  document.body.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
});

// ============================================================
//  Settings modal (translation engine config)
// ============================================================
function fillSettings() {
  const c = loadCfg();
  document.querySelectorAll('#tr-provider .seg-btn').forEach((b) =>
    b.classList.toggle('on', b.dataset.provider === c.provider));
  document.querySelectorAll('.provider-block').forEach((el2) =>
    el2.hidden = el2.dataset.provider !== c.provider);
  $('cfg-ollama-url').value = c.ollamaUrl;
  $('cfg-ollama-model').value = c.ollamaModel;
  $('cfg-api-base').value = c.apiBase;
  $('cfg-api-model').value = c.apiModel;
  $('cfg-api-key').value = c.apiKey;
  $('cfg-libre-url').value = c.libreUrl;
  $('cfg-libre-key').value = c.libreKey;
  $('cfg-target').value = c.target;
  $('cfg-answer-model').value = c.answerModel || '';
  $('cfg-embed-model').value = c.embedModel || 'nomic-embed-text';
  $('cfg-proxy').value = loadScrapeCfg().proxyUrl || '';
}
function readSettings() {
  const provider = document.querySelector('#tr-provider .seg-btn.on')?.dataset.provider || 'ollama';
  return {
    provider,
    ollamaUrl: $('cfg-ollama-url').value.trim() || DEFAULT_CFG.ollamaUrl,
    ollamaModel: $('cfg-ollama-model').value.trim() || DEFAULT_CFG.ollamaModel,
    apiBase: $('cfg-api-base').value.trim() || DEFAULT_CFG.apiBase,
    apiModel: $('cfg-api-model').value.trim() || DEFAULT_CFG.apiModel,
    apiKey: $('cfg-api-key').value,
    libreUrl: $('cfg-libre-url').value.trim() || DEFAULT_CFG.libreUrl,
    libreKey: $('cfg-libre-key').value,
    target: $('cfg-target').value.trim() || DEFAULT_CFG.target,
    answerModel: $('cfg-answer-model').value.trim(),
    embedModel: $('cfg-embed-model').value.trim() || DEFAULT_CFG.embedModel,
  };
}
async function refreshOllamaModels() {
  const det = $('ollama-detected');
  const dl = $('ollama-models');
  det.textContent = '· detectando…';
  const models = await listOllamaModels($('cfg-ollama-url').value.trim());
  dl.innerHTML = '';
  models.forEach((m) => { const o = document.createElement('option'); o.value = m; dl.append(o); });
  det.textContent = models.length ? `· ${models.length} instalados` : '· Ollama não encontrado';
}
function openSettings() {
  fillSettings();
  $('settings-test-result').textContent = '';
  $('settings-modal').hidden = false;
  refreshOllamaModels();
}
function closeSettings() { $('settings-modal').hidden = true; }

$('settings-btn').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);
$('settings-modal').addEventListener('click', (e) => { if (e.target.id === 'settings-modal') closeSettings(); });
document.querySelectorAll('#tr-provider .seg-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#tr-provider .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.provider-block').forEach((el2) => el2.hidden = el2.dataset.provider !== b.dataset.provider);
}));
$('settings-save').addEventListener('click', () => {
  saveCfg(readSettings());
  saveScrapeCfg({ proxyUrl: $('cfg-proxy').value.trim() });
  closeSettings();
  const rec = docs.get(activeId);
  if (rec && rec.ocrPages) renderTranslation(rec); // refresh provider tag/target
});
$('settings-test').addEventListener('click', async () => {
  const r = $('settings-test-result');
  r.textContent = 'Testando…'; r.className = 'test-result';
  try {
    const out = await testConnection(readSettings());
    r.textContent = '✓ Conectado — ' + (out ? `"${out.slice(0, 30)}"` : 'resposta vazia');
    r.className = 'test-result ok';
  } catch (e) {
    r.textContent = '✗ ' + e.message;
    r.className = 'test-result err';
  }
});
