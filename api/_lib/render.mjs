// Posting descriptions (HTML, Markdown or plain text, depending on the source)
// reduced to a small, safe HTML subset. Postings are untrusted third-party
// content: only an allowlist of formatting tags survives, every attribute is
// dropped except an http(s) href, and the site's CSP blocks scripts anyway.
// Port of modules/job-finder/webui/lib/render.ts.

const ALLOWED = new Set(['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'blockquote']);
const HEADING = /^h[1-6]$/;

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function sanitizeHtml(html) {
  const stripped = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '');
  return stripped.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)([^>]*)>/g, (_m, close, tag, attrs) => {
    let t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return t === 'div' || t === 'tr' ? (close ? '' : '<br>') : '';
    if (HEADING.test(t)) t = 'h4';
    if (close) return `</${t}>`;
    if (t === 'a') {
      const href = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)')/i);
      const url = href ? (href[2] ?? href[3] ?? '') : '';
      if (/^https?:\/\//i.test(url)) return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">`;
      return '<a>';
    }
    return t === 'br' ? '<br>' : `<${t}>`;
  });
}

function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>');
}

// Plain text and light Markdown share one renderer. pageText is for text
// extracted line-per-block from a web page: every line is its own paragraph,
// and a short unpunctuated line that introduces prose becomes a heading.
export function textToHtml(text, markdown = false, pageText = false) {
  const out = [];
  let list = [];
  let para = [];
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };
  const fmt = markdown ? inlineMd : escapeHtml;
  const all = String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    if (!line) { flushList(); flushPara(); continue; }
    if (pageText) {
      const next = all.slice(i + 1).find(Boolean) ?? '';
      if (line.length <= 50 && !/[.!?:,;]$/.test(line) && next.length >= 80) { flushList(); flushPara(); out.push(`<h4>${fmt(line)}</h4>`); continue; }
      if (!/^(?:[-*•▪·]|\d+[.)])\s+/.test(line)) { flushList(); flushPara(); out.push(`<p>${fmt(line)}</p>`); continue; }
    }
    const heading = markdown && line.match(/^#{1,6}\s+(.*)$/);
    const bullet = line.match(/^(?:[-*•▪·]|\d+[.)])\s+(.*)$/);
    if (heading) { flushList(); flushPara(); out.push(`<h4>${fmt(heading[1])}</h4>`); }
    else if (bullet) { flushPara(); list.push(fmt(bullet[1])); }
    else { flushList(); para.push(fmt(line)); }
  }
  flushList();
  flushPara();
  return out.join('\n');
}

export function renderDescription(d) {
  if (!d) return '';
  if (d.html && /<[a-z][\s\S]*>/i.test(d.html)) return sanitizeHtml(d.html);
  const src = d.html ?? d.markdown ?? d.text;
  if (!src) return '';
  return textToHtml(String(src), d.markdown !== undefined, d.pageText === true);
}

// Plain text of a description, for the AI prompt (never HTML).
export function descriptionText(d) {
  const html = renderDescription(d);
  return html
    .replace(/<\/(p|li|h4|blockquote)>/g, '\n')
    .replace(/<br>/g, '\n')
    .replace(/<li>/g, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
