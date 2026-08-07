// ============================================================
//  Export a translated document as a PDF — the page raster with
//  the translation baked in place, one PDF page per document
//  page. Keeps the original layout (BabelDOC-style output).
// ============================================================

import { jsPDF } from './vendor/jspdf/jspdf.js';

function decodeImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Draw one translated segment onto the page canvas: a faint white backing for
// readability, a white halo, then dark text — sized to fit the box.
function drawSegment(ctx, box, text) {
  const pad = 2;
  const w = Math.max(4, box.w - pad * 2);
  const h = box.h;
  let size = Math.max(6, Math.min(64, Math.floor(h * 0.72)));
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `${size}px Helvetica, Arial, sans-serif`;
  while (ctx.measureText(text).width > w && size > 6) {
    size -= 1;
    ctx.font = `${size}px Helvetica, Arial, sans-serif`;
  }
  // Faint backing so the translation is legible over the original.
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  const x = box.x + pad;
  const y = box.y + h / 2;
  ctx.lineWidth = Math.max(2, size * 0.16);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#141414';
  ctx.fillText(text, x, y);
}

/** Build and download a translated PDF for a record. */
export async function exportTranslatedPDF(rec, onProgress) {
  const pages = rec.ocrPages || [];
  if (!pages.length) throw new Error('Este documento não tem páginas com texto para exportar.');

  let pdf = null;
  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    onProgress && onProgress(pi + 1, pages.length);
    const canvas = document.createElement('canvas');
    canvas.width = pg.width;
    canvas.height = pg.height;
    const ctx = canvas.getContext('2d');

    if (pg.raster) {
      try { ctx.drawImage(await decodeImage(pg.raster), 0, 0, pg.width, pg.height); }
      catch { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pg.width, pg.height); }
    } else {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pg.width, pg.height);
    }

    (pg.boxes || []).forEach((b, bi) => {
      const t = (rec.translations?.[pi]?.[bi] || '').trim();
      if (t) drawSegment(ctx, b, t);
    });

    const data = canvas.toDataURL('image/jpeg', 0.92);
    const orientation = pg.width >= pg.height ? 'landscape' : 'portrait';
    if (!pdf) pdf = new jsPDF({ orientation, unit: 'px', format: [pg.width, pg.height], compress: true });
    else pdf.addPage([pg.width, pg.height], orientation);
    pdf.addImage(data, 'JPEG', 0, 0, pg.width, pg.height);
    canvas.width = canvas.height = 0;
  }

  const lang = (rec.trTarget || 'traduzido').slice(0, 16).replace(/\s+/g, '-');
  pdf.save(`${rec.base}.${lang}.pdf`);
}
