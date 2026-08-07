// ============================================================
//  anydoc studio — conversion worker
//  All document parsing runs here, off the main thread, so the
//  UI stays responsive even on large PDFs. Two Rust/WASM engines
//  live side by side:
//    • anydoc            → every office format → Markdown + model
//    • pdf-inspector     → deep PDF analysis (type, OCR routing,
//                          layout, encoding) + tunable Markdown
//
//  Protocol (main ⇄ worker), all messages carry a monotonic id:
//    → { type:'init' }                     ← { type:'ready' }
//    → { type:'convert', id, payload }     ← { type:'result', id, result }
//                                          ← { type:'error',  id, error }
// ============================================================

import initAnydoc, {
  formatFromBytes,
  formatFromPath,
  toMarkdownBytes,
  toDocument,
} from './vendor/anydoc/anydoc_wasm.js';

import initPdf, {
  processPdf,
  version as pdfVersion,
} from './vendor/pdf-inspector/pdf_inspector_wasm.js';

let ready = false;

async function ensureReady() {
  if (ready) return;
  // Both engines load their .wasm relative to their own glue module.
  await Promise.all([initAnydoc(), initPdf()]);
  ready = true;
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      await ensureReady();
      self.postMessage({ type: 'ready', pdfInspector: safeVersion() });
    } catch (err) {
      self.postMessage({ type: 'fatal', error: String(err?.message ?? err) });
    }
    return;
  }

  if (msg.type === 'convert') {
    const { id, payload } = msg;
    try {
      await ensureReady();
      const result = convert(payload);
      self.postMessage({ type: 'result', id, result });
    } catch (err) {
      self.postMessage({
        type: 'error',
        id,
        error: { code: err?.code || 'error', message: err?.message ?? String(err) },
      });
    }
  }
};

function safeVersion() {
  try { return pdfVersion(); } catch { return null; }
}

function convert(payload) {
  const { name, bytes, options = {} } = payload;
  const format = formatFromBytes(bytes) ?? formatFromPath(name) ?? undefined;
  const out = { format };

  if (format === 'pdf') {
    // Deep PDF path: pdf-inspector gives us classification, OCR routing,
    // layout complexity, encoding health, and tunable Markdown.
    const t0 = performance.now();
    const pdf = processPdf(bytes, {
      profile: options.profile === 'compact' ? 'compact' : 'fidelity',
      includePageMarkers: !!options.pageMarkers,
      includeImages: true,
    });
    out.ms = Math.max(1, Math.round(performance.now() - t0));
    out.markdown = pdf.markdown ?? '';
    out.pdf = {
      pdfType: pdf.pdfType,
      confidence: pdf.confidence,
      pageCount: pdf.pageCount,
      processingTimeMs: pdf.processingTimeMs,
      title: pdf.title ?? null,
      hasEncodingIssues: pdf.hasEncodingIssues,
      pagesNeedingOcr: pdf.pagesNeedingOcr ?? [],
      ocrReasonsByPage: pdf.ocrReasonsByPage ?? [],
      layout: pdf.layout ?? { isComplex: false, pagesWithTables: [], pagesWithColumns: [] },
    };
    out.model = null; // PDFs have no anydoc document model
    return out;
  }

  // Office formats: anydoc Markdown + structured document model.
  const t0 = performance.now();
  out.markdown = toMarkdownBytes(bytes, format);
  out.ms = Math.max(1, Math.round(performance.now() - t0));
  try {
    const t1 = performance.now();
    out.model = toDocument(bytes, format);
    out.modelMs = Math.max(1, Math.round(performance.now() - t1));
  } catch {
    out.model = null;
  }
  return out;
}
