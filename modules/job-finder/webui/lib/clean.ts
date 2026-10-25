// Jobindex's detail command returns the full text of the page an ad lives on,
// which for externally hosted ads includes the employer site's menus, cookie
// banner and footer. /scrape reads past that; a person shouldn't have to.
// This narrows the text to the ad itself, and falls back to the untouched
// text whenever the heuristics would leave too little behind.

const NOISE = /cookie|samtykke|consent|gdpr|persondatapolitik|privatlivspolitik|password|adgangskode|javascript|browser is outdated|skip to|gå til (sidens|primært) indhold|^©|^&copy;|^&times;$|^×$/i
const ENTITIES: Record<string, string> = { "&amp;": "&", "&nbsp;": " ", "&times;": "×", "&copy;": "©", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" }

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

export function trimPageChrome(text: string, title?: string | null): string {
  const decoded = text.replace(/&(amp|nbsp|times|copy|quot|#39|lt|gt);/g, (m) => ENTITIES[m] ?? m)
  const lines = decoded.split("\n").map((l) => l.trim())
  const long = (l: string) => l.length >= 60

  // Start: the first line naming the job title; failing that, the line before
  // the first real paragraph.
  let start = -1
  const t = title ? norm(title) : ""
  if (t.length >= 4) start = lines.findIndex((l) => { const n = norm(l); return n.length < t.length + 40 && n.includes(t) })
  if (start < 0) {
    const firstPara = lines.findIndex((l) => long(l) && !NOISE.test(l))
    start = Math.max(0, firstPara - 1)
  }

  // End: footer and modal markup show up as a long run of short lines.
  // From a footer run, only contact details and deadlines are worth keeping.
  const KEEP = /@|\+?\d[\d ]{6,}|deadline|frist|contact|kontakt/i
  const out: string[] = []
  let shortRun: string[] = []
  let footer = false
  let prev = ""
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]
    if (NOISE.test(l)) continue
    if (l && l === prev) continue // the same heading repeated on consecutive lines
    if (l) prev = l
    if (!l || l.length < 40) {
      shortRun.push(l)
      if (shortRun.filter(Boolean).length >= 10) { footer = true; break }
      continue
    }
    out.push(...shortRun, l)
    shortRun = []
  }
  const tail = shortRun.filter(Boolean)
  out.push(...(footer ? tail.filter((l) => KEEP.test(l)) : tail).slice(0, 4))

  const kept = out.join("\n").trim()
  // No paragraph survived: the page held a login or application form, not the ad.
  if (!out.some((l) => l.length >= 60)) return decoded.length > 1000 ? "" : decoded
  // Keeping under 200 characters of a substantial page probably cut the ad.
  if (kept.length < 200 && decoded.length > 1000) return decoded
  return kept
}
