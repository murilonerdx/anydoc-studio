// ============================================================
//  Bergamot — neural machine translation fully in the browser
//  (Mozilla/Firefox Translations tech, Marian NMT via WASM).
//  No server, no API key. The WASM engine is vendored locally;
//  language models download once from the public registry and
//  are cached by the browser. Pivots through English when a
//  direct pair is unavailable (e.g. pt→es via pt→en→es).
// ============================================================

let translatorPromise = null;

async function getTranslator() {
  if (!translatorPromise) {
    translatorPromise = (async () => {
      const { BatchTranslator } = await import('./vendor/bergamot/translator.js');
      // One worker keeps memory modest; the engine caches loaded models.
      return new BatchTranslator({ workers: 1, cacheSize: 2 ** 13 });
    })();
  }
  return translatorPromise;
}

/** Warm up / verify a language pair is loadable (downloads models once). */
export async function bergamotReady(to = 'en') {
  const from = to === 'en' ? 'pt' : 'en';
  await bergamotTranslate('Hello', from, to);
}

/**
 * Translate one string with Bergamot.
 * @param {string} text
 * @param {string} from ISO 639-1 source (e.g. 'pt')
 * @param {string} to   ISO 639-1 target (e.g. 'en')
 */
export async function bergamotTranslate(text, from, to) {
  const t = (text || '').trim();
  if (!t) return '';
  if (!from || from === to) return text;
  const translator = await getTranslator();
  try {
    const res = await translator.translate({ from, to, text, html: false });
    return (res?.target?.text || '').trim();
  } catch (err) {
    throw new Error(
      `Bergamot não tem o par ${from}→${to} (${err?.message || err}). ` +
      'Ele cobre os principais idiomas europeus via inglês; tente outro idioma ou use Ollama/LibreTranslate.');
  }
}
