// ============================================================
//  PaddleOCR (PP-OCRv5) in the browser via ONNX Runtime Web.
//  Higher accuracy than Tesseract on real-world scans, tables
//  and 100+ languages — still fully local, no API key.
//
//  onnxruntime-web loads lazily from CDN (it resolves its own
//  wasm); the paddleocr.js runtime and the ONNX models are
//  vendored locally. Processing never leaves the device.
// ============================================================

const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.mjs';
const MODELS = {
  preset: 'PP-OCRv5_mobile',
  det: 'models/ppocrv5_mobile/PP-OCRv5_mobile_det_infer.onnx',
  rec: 'models/ppocrv5_mobile/PP-OCRv5_mobile_rec_infer.onnx',
  dict: 'models/ppocrv5_mobile/ppocrv5_dict.txt',
};

let ortPromise = null;
let servicePromise = null;

function loadOrt() {
  if (!ortPromise) ortPromise = (async () => {
    const ort = await import(ORT_CDN);
    // Single-threaded WASM: no cross-origin isolation / SharedArrayBuffer needed.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    return ort;
  })();
  return ortPromise;
}

// Build (once) the PaddleOCR service with det + rec models loaded.
function getService(onStatus) {
  if (!servicePromise) servicePromise = (async () => {
    onStatus?.('Carregando ONNX Runtime…');
    const ort = await loadOrt();
    onStatus?.('Baixando modelos PaddleOCR (uma vez, fica em cache)…');
    const [mod, detBuf, recBuf, dictText] = await Promise.all([
      import('./vendor/paddleocr-js/paddleocr.mjs'),
      fetch(MODELS.det).then((r) => r.arrayBuffer()),
      fetch(MODELS.rec).then((r) => r.arrayBuffer()),
      fetch(MODELS.dict).then((r) => r.text()),
    ]);
    onStatus?.('Inicializando o modelo…');
    // Build the character dictionary. The PaddleOCR dict file already carries
    // the CTC blank as its first line (index 0); the model's last class is the
    // space character (use_space_char), which the file omits — so append a
    // single space to reach the model's class count without shifting any glyph.
    const lines = dictText.replace(/\r/g, '').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const charactersDictionary = [...lines, ' '];
    return mod.PaddleOcrService.createInstance({
      ort,
      modelPreset: MODELS.preset,
      detection: { modelBuffer: detBuf },
      recognition: { modelBuffer: recBuf, charactersDictionary },
    });
  })();
  return servicePromise;
}

/**
 * Recognize text in a decoded image, returning both the joined text and the
 * per-region boxes (with their recognized text) for positional overlays.
 * @param {{width:number,height:number,data:Uint8Array}} image RGBA/RGB/gray pixels
 * @param {(status:string)=>void} onStatus
 * @returns {Promise<{text:string, boxes:Array<{text:string,x:number,y:number,w:number,h:number,points?:number[][]}>}>}
 */
export async function paddleRecognize(image, onStatus) {
  const svc = await getService(onStatus);
  onStatus?.('Detectando e reconhecendo texto…');
  const results = await svc.recognize(image);
  const text = svc.processRecognition(results).text || '';
  const boxes = results.map((r) => {
    const b = r.box || {};
    const points = b.points ? b.points.map((p) => [p.x, p.y]) : null;
    return { text: r.text || '', x: b.x || 0, y: b.y || 0, w: b.width || 0, h: b.height || 0, points };
  });
  return { text, boxes };
}
