// ============================================================
//  RAG — ask questions about a document, in the browser.
//  Chunks the Markdown, embeds each chunk with a local model
//  (Ollama, e.g. nomic-embed-text), retrieves the most relevant
//  passages by cosine similarity, and answers with the LLM you
//  configured — with citations. No backend, no upload.
// ============================================================

import { loadCfg, chat, chatStream } from './translate.js';

const EMBED_MODEL = 'nomic-embed-text';

// Split Markdown into overlapping passages on paragraph boundaries.
export function chunkText(md, size = 700, overlap = 120) {
  const paras = (md || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur.length + p.length + 2) > size) {
      chunks.push(cur);
      cur = (cur.length > overlap ? cur.slice(-overlap) + '\n\n' : '') + p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
    // A single huge paragraph: hard-split it.
    while (cur.length > size * 1.6) { chunks.push(cur.slice(0, size)); cur = cur.slice(size - overlap); }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

async function ollamaEmbed(text, cfg) {
  const url = (cfg.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/api/embeddings';
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.embedModel || EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Embeddings do Ollama responderam ${res.status}. Instale o modelo: ollama pull ${cfg.embedModel || EMBED_MODEL}`);
  const j = await res.json();
  if (!Array.isArray(j.embedding)) throw new Error('Resposta de embedding inválida do Ollama.');
  return j.embedding;
}

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/** Build the searchable index: [{ text, vec }]. */
export async function buildIndex(markdown, onProgress) {
  const cfg = loadCfg();
  const chunks = chunkText(markdown);
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress && onProgress(i + 1, chunks.length);
    out.push({ text: chunks[i], vec: await ollamaEmbed(chunks[i], cfg) });
  }
  return out;
}

/** Retrieve the top-k most relevant chunks for a question. */
export async function retrieve(question, index, k = 5) {
  const cfg = loadCfg();
  const q = await ollamaEmbed(question, cfg);
  return index
    .map((c, i) => ({ i, text: c.text, score: cosine(q, c.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function answerPrompt(question, passages) {
  const context = passages.map((p, n) => `[${n + 1}] ${p.text}`).join('\n\n');
  return `Você é um assistente que responde SOMENTE com base nos trechos do documento abaixo.
Regras: responda na língua da pergunta; seja preciso e conciso; cite os trechos usados como [n]; se a resposta não estiver nos trechos, diga "Não encontrei isso no documento."

Trechos:
${context}

Pergunta: ${question}

Resposta:`;
}

/** Answer a question grounded in the retrieved passages, with citations. */
export async function answer(question, passages, cfg, signal) {
  return chat(answerPrompt(question, passages), cfg, signal);
}

/** Streaming variant — onToken(delta, full) is called as the answer arrives. */
export async function answerStream(question, passages, cfg, onToken, signal) {
  return chatStream(answerPrompt(question, passages), cfg, onToken, signal);
}
