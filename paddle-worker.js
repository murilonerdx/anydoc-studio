// ============================================================
//  PaddleOCR worker — runs the ONNX inference off the main
//  thread so the UI never freezes on large scans.
//
//  Protocol:
//    → { type:'recognize', id, image:{width,height,data} }
//    ← { type:'status', id, text }        (progress)
//    ← { type:'result', id, text, boxes } | { type:'error', id, error }
// ============================================================

const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.mjs';
const MODELS = {
  preset: 'PP-OCRv5_mobile',
  det: 'models/ppocrv5_mobile/PP-OCRv5_mobile_det_infer.onnx',
  rec: 'models/ppocrv5_mobile/PP-OCRv5_mobile_rec_infer.onnx',
  dict: 'models/ppocrv5_mobile/ppocrv5_dict.txt',
};

let servicePromise = null;

function getService(status) {
  if (!servicePromise) servicePromise = (async () => {
    status('Carregando ONNX Runtime…');
    const ort = await import(ORT_CDN);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    status('Baixando modelos PaddleOCR (uma vez, fica em cache)…');
    const [mod, detBuf, recBuf, dictText] = await Promise.all([
      import('./vendor/paddleocr-js/paddleocr.mjs'),
      fetch(MODELS.det).then((r) => r.arrayBuffer()),
      fetch(MODELS.rec).then((r) => r.arrayBuffer()),
      fetch(MODELS.dict).then((r) => r.text()),
    ]);
    status('Inicializando o modelo…');
    const lines = dictText.replace(/\r/g, '').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const charactersDictionary = [...lines, ' ']; // CTC: append the space class
    return mod.PaddleOcrService.createInstance({
      ort,
      modelPreset: MODELS.preset,
      detection: { modelBuffer: detBuf },
      recognition: { modelBuffer: recBuf, charactersDictionary },
    });
  })();
  return servicePromise;
}

self.onmessage = async (e) => {
  const { type, id, image } = e.data;
  if (type !== 'recognize') return;
  const status = (text) => self.postMessage({ type: 'status', id, text });
  try {
    const svc = await getService(status);
    status('Detectando e reconhecendo texto…');
    const results = await svc.recognize(image);
    const text = svc.processRecognition(results).text || '';
    const boxes = results.map((r) => {
      const b = r.box || {};
      const points = b.points ? b.points.map((p) => [p.x, p.y]) : null;
      return { text: r.text || '', x: b.x || 0, y: b.y || 0, w: b.width || 0, h: b.height || 0, points };
    });
    self.postMessage({ type: 'result', id, text, boxes });
  } catch (err) {
    self.postMessage({ type: 'error', id, error: String(err?.message ?? err) });
  }
};
