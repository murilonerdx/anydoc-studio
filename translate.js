// ============================================================
//  Translation connector — always a user-controlled engine.
//  Providers (all local-first, no bundled keys):
//    • ollama   — local LLM on the user's machine
//    • openai   — any OpenAI-compatible API (key stored locally)
//    • libre    — self-hosted LibreTranslate (Argos), no key
//    • bergamot — neural MT in the browser (WASM), fully offline
//  Adds context/glossary-aware batch translation and local
//  language detection (franc).
// ============================================================

import { franc } from './vendor/franc/franc.js';
import { bergamotTranslate, bergamotReady } from './bergamot.js';

export const DEFAULT_CFG = {
  provider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.1',
  apiBase: 'https://api.openai.com/v1',
  apiModel: 'gpt-4o-mini',
  apiKey: '',
  libreUrl: 'http://localhost:5000',
  libreKey: '',
  target: 'Português',
};

const CFG_KEY = 'anydoc-studio-translate';
const GLOSS_KEY = 'anydoc-studio-glossary';

// ISO 639-3 (franc) → human name and ISO 639-1 (for Libre/Bergamot).
const ISO3 = {
  por: ['Português', 'pt'], eng: ['Inglês', 'en'], spa: ['Espanhol', 'es'],
  fra: ['Francês', 'fr'], deu: ['Alemão', 'de'], ita: ['Italiano', 'it'],
  nld: ['Holandês', 'nl'], rus: ['Russo', 'ru'], jpn: ['Japonês', 'ja'],
  cmn: ['Chinês', 'zh'], zho: ['Chinês', 'zh'], kor: ['Coreano', 'ko'], ara: ['Árabe', 'ar'],
  pol: ['Polonês', 'pl'], ukr: ['Ucraniano', 'uk'], tur: ['Turco', 'tr'],
  hin: ['Hindi', 'hi'], ben: ['Bengali', 'bn'], swe: ['Sueco', 'sv'], nob: ['Norueguês', 'nb'],
  dan: ['Dinamarquês', 'da'], fin: ['Finlandês', 'fi'], ell: ['Grego', 'el'], ces: ['Tcheco', 'cs'],
  slk: ['Eslovaco', 'sk'], ron: ['Romeno', 'ro'], hun: ['Húngaro', 'hu'], bul: ['Búlgaro', 'bg'],
  heb: ['Hebraico', 'he'], tha: ['Tailandês', 'th'], vie: ['Vietnamita', 'vi'], ind: ['Indonésio', 'id'],
  msa: ['Malaio', 'ms'], zsm: ['Malaio', 'ms'], fas: ['Persa', 'fa'], pes: ['Persa', 'fa'],
  cat: ['Catalão', 'ca'], hrv: ['Croata', 'hr'], srp: ['Sérvio', 'sr'], slv: ['Esloveno', 'sl'],
  lit: ['Lituano', 'lt'], lav: ['Letão', 'lv'], est: ['Estoniano', 'et'], isl: ['Islandês', 'is'],
  gle: ['Irlandês', 'ga'], glg: ['Galego', 'gl'], eus: ['Basco', 'eu'], afr: ['Africâner', 'af'],
  swa: ['Suaíli', 'sw'], tgl: ['Tagalo', 'tl'], urd: ['Urdu', 'ur'], tam: ['Tâmil', 'ta'],
};

// Target languages offered in the UI. LLM/API accept the name directly; Libre
// and Bergamot use the ISO 639-1 code (pivoting via English when needed).
export const TARGET_LANGS = [
  ['Português', 'pt'], ['Inglês', 'en'], ['Espanhol', 'es'], ['Francês', 'fr'], ['Alemão', 'de'],
  ['Italiano', 'it'], ['Holandês', 'nl'], ['Russo', 'ru'], ['Chinês', 'zh'], ['Japonês', 'ja'],
  ['Coreano', 'ko'], ['Árabe', 'ar'], ['Hindi', 'hi'], ['Turco', 'tr'], ['Polonês', 'pl'],
  ['Ucraniano', 'uk'], ['Sueco', 'sv'], ['Norueguês', 'nb'], ['Dinamarquês', 'da'], ['Finlandês', 'fi'],
  ['Grego', 'el'], ['Tcheco', 'cs'], ['Romeno', 'ro'], ['Húngaro', 'hu'], ['Búlgaro', 'bg'],
  ['Hebraico', 'he'], ['Tailandês', 'th'], ['Vietnamita', 'vi'], ['Indonésio', 'id'], ['Persa', 'fa'],
  ['Catalão', 'ca'], ['Croata', 'hr'], ['Sérvio', 'sr'], ['Esloveno', 'sl'], ['Lituano', 'lt'],
  ['Letão', 'lv'], ['Estoniano', 'et'], ['Galego', 'gl'], ['Africâner', 'af'], ['Suaíli', 'sw'],
];

// Human name (accent/case-insensitive) → ISO 639-1.
const NAME_ISO1 = (() => {
  const m = {};
  for (const [name, code] of TARGET_LANGS) m[deaccentRaw(name)] = code;
  // extra aliases
  Object.assign(m, { english: 'en', spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt' });
  return m;
})();
function deaccentRaw(s) { return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
const deaccent = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function nameToIso1(name) { return NAME_ISO1[deaccent(name)] || deaccent(name).slice(0, 2); }

export function detectLang(text) {
  const code = franc(text || '', { minLength: 10 });
  const [name, iso1] = ISO3[code] || [code, ''];
  return { iso3: code, name, iso1 };
}

// List the models installed in a local Ollama, for the settings dropdown.
export async function listOllamaModels(url) {
  try {
    const base = (url || DEFAULT_CFG.ollamaUrl).replace(/\/+$/, '');
    const res = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.models || []).map((m) => m.name).sort();
  } catch { return []; }
}

// Curated local models that do well on document translation (must be pulled
// with `ollama pull <name>`). Shown as suggestions in settings.
export const RECOMMENDED_LOCAL = [
  { name: 'translategemma', note: 'especializado em tradução (Gemma) — ótimo p/ documentos' },
  { name: 'aya:8b', note: 'multilíngue (Cohere), 100+ idiomas' },
  { name: 'qwen2.5:7b', note: 'forte em contexto técnico/tabelas' },
  { name: 'llama3.1:8b', note: 'equilibrado, bom em instruções' },
];

export function loadCfg() {
  try { return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; }
  catch { return { ...DEFAULT_CFG }; }
}
export function saveCfg(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

// ---- Glossary (term → translation, per target language) ----
export function loadGlossaryBank() {
  try { return JSON.parse(localStorage.getItem(GLOSS_KEY) || '{}'); } catch { return {}; }
}
export function saveGlossaryBank(bank) { localStorage.setItem(GLOSS_KEY, JSON.stringify(bank || {})); }
export function loadGlossary(targetName) {
  try {
    const bank = JSON.parse(localStorage.getItem(GLOSS_KEY) || '{}');
    return bank[deaccent(targetName)] || {};
  } catch { return {}; }
}
export function recordGlossary(orig, translated, targetName, docType) {
  const short = (orig || '').trim();
  if (!short || short.length > 40 || (short.match(/\S+/g) || []).length > 4) return;
  try {
    const bank = JSON.parse(localStorage.getItem(GLOSS_KEY) || '{}');
    const lang = deaccent(targetName);
    bank[lang] = bank[lang] || {};
    bank[lang][short] = { t: translated, type: docType || 'geral' };
    localStorage.setItem(GLOSS_KEY, JSON.stringify(bank));
  } catch { /* storage optional */ }
}

// ============================================================
//  Prompt (LLM providers)
// ============================================================
function glossaryLines(glossary) {
  const keys = Object.keys(glossary || {});
  if (!keys.length) return '';
  const pairs = keys.slice(0, 60).map((k) => `${k} = ${glossary[k].t || glossary[k]}`);
  return `\nGlossário (use EXATAMENTE estas traduções quando o termo aparecer):\n${pairs.join('\n')}\n`;
}

function batchPrompt(segments, target, glossary, sourceName, docType) {
  const numbered = segments.map((s, i) => `${i + 1}. ${s.replace(/\n/g, ' ')}`).join('\n');
  return `Você é um tradutor profissional${docType && docType !== 'geral' ? ` especializado em documentos do tipo "${docType}"` : ''}. Traduza cada segmento numerado ${sourceName ? `do ${sourceName} ` : ''}para ${target}.
Regras: preserve números, siglas, nomes próprios, URLs e pontuação; mantenha o registro (técnico/formal) e a terminologia própria de "${docType || 'documento'}"; mantenha a consistência de termos ao longo do documento.${glossaryLines(glossary)}
Responda APENAS com as traduções, uma por linha, no formato "N. tradução", exatamente ${segments.length} linhas, sem comentários.

Segmentos:
${numbered}`;
}

function parseNumbered(text, n) {
  const out = new Array(n).fill(null);
  const lines = (text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)[.)\]]\s*(.*)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < n) out[idx] = m[2].trim();
    }
  }
  return out;
}

// ============================================================
//  Provider calls
// ============================================================
async function llmComplete(prompt, cfg, signal) {
  if (cfg.provider === 'ollama') {
    const url = (cfg.ollamaUrl || DEFAULT_CFG.ollamaUrl).replace(/\/+$/, '') + '/api/generate';
    const res = await fetch(url, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.ollamaModel || 'llama3.1', prompt, stream: false, options: { temperature: 0.1 } }),
    });
    if (!res.ok) throw new Error(`Ollama respondeu ${res.status}. Verifique o modelo e OLLAMA_ORIGINS.`);
    return ((await res.json()).response || '').trim();
  }
  const base = (cfg.apiBase || DEFAULT_CFG.apiBase).replace(/\/+$/, '');
  const res = await fetch(base + '/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (cfg.apiKey || '') },
    body: JSON.stringify({ model: cfg.apiModel || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.1 }),
  });
  if (!res.ok) throw new Error(`API respondeu ${res.status}. Verifique base URL, modelo e chave.`);
  return ((await res.json()).choices?.[0]?.message?.content || '').trim();
}

async function libreTranslate(segments, cfg, signal, sourceIso1, targetIso1) {
  const url = (cfg.libreUrl || DEFAULT_CFG.libreUrl).replace(/\/+$/, '') + '/translate';
  const res = await fetch(url, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: segments, source: sourceIso1 || 'auto', target: targetIso1 || 'en', format: 'text', ...(cfg.libreKey ? { api_key: cfg.libreKey } : {}) }),
  });
  if (!res.ok) throw new Error(`LibreTranslate respondeu ${res.status}. Verifique a URL e os idiomas.`);
  const j = await res.json();
  const t = j.translatedText;
  return Array.isArray(t) ? t : segments.map(() => (typeof t === 'string' ? t : ''));
}

// ============================================================
//  Public API
// ============================================================

/** Translate a batch of segments; returns an array aligned to the input. */
export async function translateBatch(segments, cfg, signal, ctx = {}) {
  if (!segments.length) return [];
  const target = cfg.target || 'Português';

  if (cfg.provider === 'libre') {
    return libreTranslate(segments, cfg, signal, ctx.sourceIso1, nameToIso1(target));
  }
  if (cfg.provider === 'bergamot') {
    const outs = [];
    for (const s of segments) outs.push(await bergamotTranslate(s, ctx.sourceIso1 || 'pt', nameToIso1(target)));
    return outs;
  }

  // LLM providers: one request per batch, numbered round-trip with fallback.
  const prompt = batchPrompt(segments, target, ctx.glossary, ctx.sourceName, ctx.docType);
  const raw = await llmComplete(prompt, cfg, signal);
  const parsed = parseNumbered(raw, segments.length);
  // Fill any missing lines by translating them individually.
  for (let i = 0; i < segments.length; i++) {
    if (parsed[i] == null || parsed[i] === '') {
      parsed[i] = await translateText(segments[i], cfg, signal, ctx);
    }
  }
  return parsed;
}

/** Translate one string (used by the connection test and as a fallback). */
export async function translateText(text, cfg, signal, ctx = {}) {
  if (!text || !text.trim()) return '';
  const target = cfg.target || 'Português';
  if (cfg.provider === 'libre') return (await libreTranslate([text], cfg, signal, ctx.sourceIso1, nameToIso1(target)))[0] || '';
  if (cfg.provider === 'bergamot') return bergamotTranslate(text, ctx.sourceIso1 || 'pt', nameToIso1(target));
  const prompt = `Traduza para ${target}, respondendo APENAS com a tradução:\n\n${text}`;
  return llmComplete(prompt, cfg, signal);
}

/** Free-form completion for RAG answering — uses the LLM providers only
 *  (Ollama / OpenAI-compatible); Libre/Bergamot fall back to Ollama. */
export async function chat(prompt, cfg, signal) {
  const c = (cfg.provider === 'ollama' || cfg.provider === 'openai') ? cfg : { ...cfg, provider: 'ollama' };
  return llmComplete(prompt, c, signal);
}

/** Connectivity/health check per provider. */
export async function testConnection(cfg) {
  if (cfg.provider === 'bergamot') {
    await bergamotReady(cfg.target ? nameToIso1(cfg.target) : 'en');
    return await bergamotTranslate('Hello world', 'en', nameToIso1(cfg.target || 'Português'));
  }
  return translateText('Hello world', { ...cfg, target: cfg.target || 'Português' });
}
