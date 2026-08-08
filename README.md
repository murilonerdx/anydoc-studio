<div align="center">

# anydoc studio

**A privacy-first document workbench that runs entirely in your browser.**

Convert, inspect, OCR, map, and translate documents — locally, with no account and no API key required. Nothing is uploaded.

`WebAssembly` · `offline-first` · `no backend` · `MIT`

</div>

---

## What it is

**anydoc studio** turns any office document, PDF, or image into clean Markdown, shows exactly *where* every piece of text sits on the page, runs OCR on scans, and produces **layout-preserving translations** — all client-side, in the browser, via WebAssembly.

It is built on top of Firecrawl's [anydoc](https://github.com/firecrawl/anydoc) and [pdf-inspector](https://github.com/firecrawl/pdf-inspector), and layers on in-browser OCR, a positional overlay editor, and a multi-engine translation pipeline with a translation memory.

The base application is **fully offline**. Heavy optional engines (OCR runtimes, translation models) are loaded on demand and, where they call out at all, only to endpoints **you** configure and control (a local Ollama, a self-hosted LibreTranslate, or an API key you enter yourself).

## Features

| Area | What you get |
| --- | --- |
| **Convert** | 14 office/OpenDocument/RTF/EPUB/CSV/PDF formats → clean GitHub-Flavored Markdown ([anydoc](https://github.com/firecrawl/anydoc)) |
| **Inspect** | Rendered preview, live-editable Markdown source, parsed block structure, embedded assets gallery |
| **PDF analysis** | Type (text/scanned/mixed), confidence, per-page OCR routing, layout complexity, encoding health ([pdf-inspector](https://github.com/firecrawl/pdf-inspector)) |
| **OCR (local)** | Images and scanned PDFs, two selectable engines: **Tesseract.js** (light) and **PaddleOCR PP-OCRv5** (accurate, ONNX). Per-region **confidence** and a **Cancel** button that stops a long run immediately |
| **Positions** | Bounding-box overlay of every detected region, tinted by OCR confidence (isolate the low-confidence ones), + an **edit mode** to move, resize, delete, and edit boxes — by mouse **or keyboard** |
| **Translation** | **Layout-preserving**, real-time, in-document substitution that **streams in region by region**. Batch translation with document-type context, a glossary, and automatic source-language detection (40+ languages) |
| **Ask (RAG)** | Ask questions about a document and get grounded answers **with citations** — chunking + local embeddings (Ollama) + your chosen LLM, entirely in the browser |
| **Scraping** | Paste a URL → clean Markdown ([Readability](https://github.com/mozilla/readability) + [Turndown](https://github.com/mixmark-io/turndown)); a small local proxy handles CORS-restricted sites |
| **Export** | Download the translation as Markdown, or as a **layout-preserving PDF** with the translated text baked onto each page |
| **Word bank** | A translation memory of terms → translations, bucketed by language and document type, reused as context |
| **Installable (PWA)** | Install it as an app; a service worker caches the shell and assets so it keeps working offline |
| **Accessibility** | Region rows and text boxes are keyboard-operable and labelled for assistive tech; OCR and translation progress announce via ARIA live regions |
| **Persistence** | Uploads, OCR results, and translations survive a refresh (IndexedDB) |

### Translation engines

All engines keep a **local option** and never require a bundled key:

- **Bergamot** — neural machine translation **entirely in the browser** (the technology behind Firefox Translations). No server, no key; language models download once and are cached.
- **Ollama** — a local LLM on your machine (`translategemma`, `aya`, `qwen2.5`, `llama3.1`, …).
- **LibreTranslate** — a self-hosted translation API (Argos), no key.
- **OpenAI-compatible API** — any endpoint (OpenAI, Azure, local gateways); the key is stored only in your browser.

## Quick start

**Requirements:** Python 3.11+ (only used as a static file server) and a recent Chromium- or Firefox-based browser. WebAssembly must be served over HTTP — do not open the files via `file://`.

```bash
git clone <your-fork-url> anydoc-studio
cd anydoc-studio
python serve.py 8777
```

Then open **http://127.0.0.1:8777**.

> `serve.py` sends `Cache-Control: no-cache` on HTML/JS/CSS (so updates are picked up on a normal refresh) and the correct `application/wasm` MIME type. Any static server works, but if you use another one during development, disable HTML/JS caching.

That is the entire required setup. OCR, scraping, and translation are optional and configured per-feature below.

## Optional integrations

Each is opt-in and independent — the app works without any of them.

<details>
<summary><b>Local LLM translation (Ollama)</b></summary>

```bash
# Install a model well-suited to document translation
ollama pull translategemma        # or: aya:8b, qwen2.5:7b, llama3.1:8b

# Allow the app's origin to reach Ollama, then start it
OLLAMA_ORIGINS=http://127.0.0.1:8777 ollama serve
```
In the app: **⚙ Settings → Ollama**. Installed models are detected automatically.
</details>

<details>
<summary><b>Self-hosted translation API (LibreTranslate)</b></summary>

```bash
docker run -p 5000:5000 libretranslate/libretranslate
```
In the app: **⚙ Settings → LibreTranslate**, set the URL to `http://localhost:5000`.
</details>

<details>
<summary><b>Web scraping of CORS-restricted sites</b></summary>

```bash
python proxy.py 8788
```
In the app: **⚙ Settings → scraping proxy**, set the URL to `http://localhost:8788`.
Sites that already send permissive CORS headers work without the proxy.
</details>

<details>
<summary><b>OpenAI-compatible API</b></summary>

In the app: **⚙ Settings → API**. Set the base URL (e.g. `https://api.openai.com/v1`), the model, and your key. The key is stored only in this browser's `localStorage` and is sent only to the endpoint you configured.
</details>

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it is built and how data flows.
- [docs/CREDITS.md](docs/CREDITS.md) — every open-source project used, with licenses.

## Privacy

- The core pipeline (conversion, PDF analysis, OCR, positions, Bergamot translation) runs **on-device**.
- Uploaded documents are stored only in your browser's IndexedDB and never leave it.
- Tesseract OCR, PDF.js, and every other engine are **bundled** — no CDN at runtime.
- The only outbound requests are optional and on first use: the PaddleOCR runtime (ONNX Runtime Web) and Bergamot's language models. Translation requests go only to the engine **you** selected and configured.

## License

[MIT](LICENSE). anydoc studio bundles third-party open-source components under their own permissive licenses — see [docs/CREDITS.md](docs/CREDITS.md).
