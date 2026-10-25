// Turns posting descriptions (HTML, Markdown or plain text, depending on the
// portal) into a small, safe HTML subset. Postings are untrusted third-party
// content: only an allowlist of formatting tags survives, every attribute is
// dropped except an http(s) href, and the page's CSP blocks scripts anyway.

const ALLOWED = new Set(["p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "h1", "h2", "h3", "h4", "h5", "h6", "a", "blockquote"])
const HEADING = /^h[1-6]$/

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

export function sanitizeHtml(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "")
  return stripped.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)([^>]*)>/g, (_m, close: string, tag: string, attrs: string) => {
    let t = tag.toLowerCase()
    if (!ALLOWED.has(t)) return t === "div" || t === "tr" ? (close ? "" : "<br>") : ""
    if (HEADING.test(t)) t = "h4"
    if (close) return `</${t}>`
    if (t === "a") {
      const href = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)')/i)
      const url = href ? (href[2] ?? href[3] ?? "") : ""
      if (/^https?:\/\//i.test(url)) return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">`
      return "<a>"
    }
    return t === "br" ? "<br>" : `<${t}>`
  })
}

function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>")
}

// Plain text and light Markdown share one renderer: blank lines split
// paragraphs, "-"/"*"/"•" start bullets, "#" lines become headings.
// pageText is for text extracted line-per-block from a web page: every line
// is its own paragraph, and a short unpunctuated line that introduces prose
// is treated as a section heading.
export function textToHtml(text: string, markdown = false, pageText = false): string {
  const out: string[] = []
  let list: string[] = []
  let para: string[] = []
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join("")}</ul>`)
    list = []
  }
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`)
    para = []
  }
  const fmt = markdown ? inlineMd : escapeHtml
  const all = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim())
  for (let i = 0; i < all.length; i++) {
    const line = all[i]
    if (!line) { flushList(); flushPara(); continue }
    if (pageText) {
      const next = all.slice(i + 1).find(Boolean) ?? ""
      if (line.length <= 50 && !/[.!?:,;]$/.test(line) && next.length >= 80) { flushList(); flushPara(); out.push(`<h4>${fmt(line)}</h4>`); continue }
      if (!/^(?:[-*•▪·]|\d+[.)])\s+/.test(line)) { flushList(); flushPara(); out.push(`<p>${fmt(line)}</p>`); continue }
    }
    const heading = markdown && line.match(/^#{1,6}\s+(.*)$/)
    const bullet = line.match(/^(?:[-*•▪·]|\d+[.)])\s+(.*)$/)
    if (heading) { flushList(); flushPara(); out.push(`<h4>${fmt(heading[1])}</h4>`) }
    else if (bullet) { flushPara(); list.push(fmt(bullet[1])) }
    else { flushList(); para.push(fmt(line)) }
  }
  flushList()
  flushPara()
  return out.join("\n")
}

export function renderDescription(d: { html?: string; markdown?: string; text?: string; pageText?: boolean } | undefined): string {
  if (!d) return ""
  if (d.html && /<[a-z][\s\S]*>/i.test(d.html)) return sanitizeHtml(d.html)
  const src = d.html ?? d.markdown ?? d.text
  if (!src) return ""
  return textToHtml(String(src), d.markdown !== undefined, d.pageText === true)
}
