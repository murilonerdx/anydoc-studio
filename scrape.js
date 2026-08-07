// ============================================================
//  Web scraping — URL → clean Markdown, in the browser.
//  Readability extracts the main article; Turndown converts the
//  HTML to Markdown, which then flows through the same pipeline
//  as any document (preview, translation, etc.).
//
//  CORS: the browser can only read same-origin or CORS-enabled
//  pages directly. For everything else, point it at a local
//  proxy (see proxy.py) — self-hosted, nothing goes to a cloud.
// ============================================================

let libs = null;
async function getLibs() {
  if (!libs) libs = await import('./vendor/scrape/scrape-libs.js');
  return libs;
}

const CFG_KEY = 'anydoc-studio-scrape';
export function loadScrapeCfg() {
  try { return { proxyUrl: '', ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; }
  catch { return { proxyUrl: '' }; }
}
export function saveScrapeCfg(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) throw new Error('Informe uma URL.');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// Fetch the raw HTML: try direct first, then the configured local proxy.
async function fetchHtml(url) {
  const cfg = loadScrapeCfg();
  // 1) Direct — works for same-origin and CORS-enabled pages.
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (res.ok) return { html: await res.text(), via: 'direto' };
  } catch { /* CORS or network — fall through to the proxy */ }
  // 2) Local proxy — e.g. http://localhost:8788/proxy?url=
  if (cfg.proxyUrl) {
    const purl = cfg.proxyUrl.includes('%s')
      ? cfg.proxyUrl.replace('%s', encodeURIComponent(url))
      : cfg.proxyUrl.replace(/\/+$/, '') + '/proxy?url=' + encodeURIComponent(url);
    const res = await fetch(purl);
    if (!res.ok) throw new Error(`Proxy respondeu ${res.status}.`);
    return { html: await res.text(), via: 'proxy local' };
  }
  throw new Error('Bloqueado por CORS. Rode o proxy local (python proxy.py) e configure a URL do proxy, ou use uma página que permita CORS.');
}

/**
 * Scrape a URL into clean Markdown.
 * @returns {Promise<{title:string, markdown:string, url:string, via:string, bytes:Uint8Array}>}
 */
export async function scrapeUrl(input) {
  const url = normalizeUrl(input);
  const { Readability, TurndownService } = await getLibs();
  const { html, via } = await fetchHtml(url);

  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Resolve relative links/images against the page URL.
  const base = doc.createElement('base');
  base.href = url;
  doc.head?.prepend(base);

  let title = doc.title || url;
  let contentHtml = '';
  try {
    const article = new Readability(doc.cloneNode(true)).parse();
    if (article && article.content) { contentHtml = article.content; title = article.title || title; }
  } catch { /* fall back to body */ }
  if (!contentHtml) contentHtml = doc.body ? doc.body.innerHTML : html;

  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  let markdown = td.turndown(contentHtml).trim();
  markdown = `# ${title}\n\n_[${url}](${url})_\n\n${markdown}`;

  return { title, markdown, url, via, bytes: new TextEncoder().encode(markdown) };
}
