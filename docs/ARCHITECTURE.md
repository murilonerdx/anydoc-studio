# Architecture

anydoc studio is a **static, browser-only application**. There is no backend: the
server (`serve.py`) only ships files. Every capability runs on the client, most of
it in WebAssembly.

```
┌──────────────────────────── Browser tab ────────────────────────────┐
│                                                                      │
│  index.html + styles.css                                             │
│                                                                      │
│  app.js  (main thread / UI)                                          │
│   ├─ intake ──► Web Worker (worker.js) ──► anydoc-wasm  (Office→MD)  │
│   │                                    └─► pdf-inspector-wasm (PDF)  │
│   ├─ IndexedDB  (persist bytes + results)                           │
│   ├─ OCR:   paddle.js ─► onnxruntime-web + PaddleOCR models          │
│   │         Tesseract.js (CDN)                                       │
│   │         PDF.js (CDN)  ─► page rasters                            │
│   ├─ Translate: translate.js ─► Ollama | LibreTranslate | API       │
│   │             bergamot.js  ─► Bergamot WASM (worker)               │
│   │             franc         ─► language detection                 │
│   └─ Scrape: scrape.js ─► Readability + Turndown (+ optional proxy)  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Threading

Document parsing (anydoc, pdf-inspector) is synchronous and CPU-bound, so it runs
in a dedicated **Web Worker** (`worker.js`) to keep the UI responsive. The main
thread talks to it through a small request/response protocol keyed by a monotonic
id:

```
main → { type: 'convert', id, payload } → worker
main ← { type: 'result',  id, result  } ← worker   (or { type: 'error', id, error })
```

OCR and translation each run in their own workers too: Tesseract.js and Bergamot
manage their own worker internally; ONNX Runtime Web runs single-threaded WASM.

## Data model

Each open document is a record (`rec`) held in a `Map` and mirrored into
IndexedDB. Only the **raw bytes plus derived metadata** are stored — never
anything the app cannot regenerate from the bytes.

Key fields:

- `bytes`, `name`, `format` — the source.
- `markdown`, `model` — anydoc output (Markdown + block model).
- `pdf` — pdf-inspector analysis.
- `ocrPages[]` — per page: `{ width, height, scale, boxes[], raster }` where each
  box is `{ text, x, y, w, h, points? }` in page-pixel space and `raster` is the
  cached page image (so views never re-render the PDF).
- `translations[pi][bi]` — the translation of each box, aligned to `ocrPages`.
- `docType`, `trTarget`, `overlayFont` — translation context and view state.

Persistence stores bytes + these fields and re-derives the rest on load. Storing
only bytes keeps the store small and correct across app updates.

## Rendering the OCR/translation views

Positions and Translation both draw the page raster with an overlay:

- A **cached raster** (`ocrPages[i].raster`, a JPEG data URL captured during OCR)
  is used as the page image, so opening these views is instant and never depends
  on re-rendering the PDF. Older documents self-heal by rendering once, in a
  foreground tab, and caching the result.
- Region boxes are positioned as **percentages** of the page, so they scale with
  the responsive page image at any width.
- In edit mode, boxes become draggable/resizable overlays (`wireEbox`): press and
  drag to move, the corner handle to resize, the × to delete, double-click to edit
  the text.

## Translation pipeline

1. Detect the source language with `franc`.
2. Load the glossary for the target language and infer the document type
   (`classifyDocType`) as context.
3. Translate in **batches** (numbered round-trip for LLM providers, native array
   for LibreTranslate, per-segment for Bergamot), injecting the glossary so
   terminology stays consistent.
4. Fill each segment card and its in-document overlay **live** as batches return.
5. Short terms are recorded into the glossary (translation memory), bucketed by
   language and document type, for reuse on similar documents.

A run re-translates the whole document, so changing the target language or simply
clicking again always works.

## Offline posture

- The base app (convert, inspect, analyze, OCR, positions, Bergamot translate) is
  fully offline. Tesseract.js (engine, WASM core, language data) and PDF.js are
  **vendored** under `vendor/tesseract/` and `vendor/pdfjs/` — no CDN at runtime.
- ONNX Runtime Web (for the PaddleOCR engine) and Bergamot's language models are
  still fetched on first use and then cached by the browser.
- Ollama, LibreTranslate, an API endpoint, and the scraping proxy are all optional
  and only ever contacted at the address the user configures.

## File map

| File | Responsibility |
| --- | --- |
| `index.html` / `styles.css` | Markup and styling |
| `app.js` | UI, state, IndexedDB, OCR/positions/translation/scrape orchestration |
| `worker.js` | Off-thread document conversion (anydoc + pdf-inspector) |
| `paddle.js` | PaddleOCR (ONNX) OCR engine |
| `translate.js` | Providers, batch translation, language detection, glossary |
| `bergamot.js` | In-browser neural translation (Bergamot WASM) |
| `scrape.js` | URL → Markdown (Readability + Turndown) |
| `serve.py` | Static server with no-cache headers for code |
| `proxy.py` | Optional local CORS proxy for scraping |
