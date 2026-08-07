// ============================================================
//  PaddleOCR (PP-OCRv5) in the browser via ONNX Runtime Web.
//  The heavy inference runs in a dedicated worker (paddle-worker.js)
//  so the UI stays responsive on large scans. Models are vendored
//  locally; onnxruntime-web loads from CDN on first use.
// ============================================================

let worker = null;
let reqSeq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./paddle-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { type, id, text, boxes, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      if (type === 'status') { p.onStatus?.(text); return; }
      pending.delete(id);
      if (type === 'result') p.resolve({ text, boxes });
      else if (type === 'error') p.reject(new Error(error));
    };
    worker.onerror = (e) => {
      // Fail every in-flight request so callers don't hang.
      for (const [, p] of pending) p.reject(new Error(e.message || 'Falha no worker do PaddleOCR'));
      pending.clear();
    };
  }
  return worker;
}

/**
 * Recognize text in a decoded image, off the main thread.
 * @param {{width:number,height:number,data:Uint8Array}} image RGBA/RGB/gray pixels
 * @param {(status:string)=>void} onStatus
 * @returns {Promise<{text:string, boxes:Array<{text:string,x:number,y:number,w:number,h:number,points?:number[][]}>}>}
 */
export function paddleRecognize(image, onStatus) {
  const w = getWorker();
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onStatus });
    // Transfer the pixel buffer to avoid a copy (we don't reuse it here).
    w.postMessage({ type: 'recognize', id, image }, [image.data.buffer]);
  });
}

/** Hard-stop the PaddleOCR worker (used to cancel a running OCR). */
export function terminatePaddle() {
  if (!worker) return;
  for (const [, p] of pending) p.reject(new Error('__cancelled__'));
  pending.clear();
  worker.terminate();
  worker = null;
}
