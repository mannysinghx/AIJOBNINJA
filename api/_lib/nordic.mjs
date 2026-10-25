// Nordic job-board adapters for the web API: Jobindex, Jobnet, Jobdanmark and
// freehire, ported from the Bun CLIs under
// modules/job-finder/.agents/skills/<portal>-search/cli so they run inside a
// Vercel serverless function. Plain Node ESM (22+), zero dependencies.
//
// Each adapter does two things, in this order, and both are copies:
//   1. what the portal CLI does for the flags the local web UI passes it
//      (request shape, headers, retry/backoff, response reshaping), and
//   2. what modules/job-finder/webui/lib/portals.ts then does to the CLI's JSON
//      (the Job shape, per-portal field mapping, the description hints).
// When a CLI or portals.ts changes, change the matching block here.
//
// Safety: every request URL is built from a fixed portal origin plus a
// validated id or query string, and is checked against that portal's host
// before it is fetched. Nothing a caller passes can choose the host.

export const NORDIC_SOURCES = ['jobindex', 'jobnet', 'jobdanmark', 'freehire'];

const REQUEST_TIMEOUT_MS = 15000; // per request, as in every CLI
const CALL_BUDGET_MS = 20000; // per searchNordic/detailNordic call, all retries included
const MAX_RETRIES = 6;

// Swappable so tests can run the retry paths without real waits.
export const _internals = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

// ---------------------------------------------------------------- webui helpers (portals.ts)

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const isoDate = (v) => {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

const snippetOf = (text, max = 260) => {
  const s = str(text);
  if (!s) return null;
  const flat = s.replace(/[#*_>`]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max).replace(/\s\S*$/, '') + '…' : flat;
};

function baseJob(portal, r, id) {
  return {
    key: `${portal}:${id}`,
    portal,
    id,
    title: str(r.title) ?? 'Untitled posting',
    company: str(r.company),
    location: str(r.location),
    date: isoDate(r.date),
    deadline: isoDate(r.deadline),
    url: str(r.url) ?? '',
    applyUrl: str(r.applyUrl),
    snippet: null,
    tags: [],
    workMode: null,
  };
}

// Same reading of the search form as webui/server.ts parseSearch, applied
// again here so a caller that skips http.mjs still cannot pass odd values on.
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function normalizeParams(p = {}) {
  const days = Number(p.days);
  return {
    q: clip(p.q, 120),
    location: clip(p.location, 80),
    days: [1, 3, 7, 14, 30].includes(days) ? days : null,
    remote: ['remote', 'hybrid', 'onsite'].includes(p.remote) ? p.remote : null,
    sort: p.sort === 'date' ? 'date' : 'relevance',
    page: Math.min(Math.max(Math.trunc(Number(p.page)) || 1, 1), 20),
  };
}

const sinceDate = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- trimPageChrome (webui/lib/clean.ts)
// Jobindex's detail command returns the full text of the page an ad lives on,
// which for externally hosted ads includes the employer site's menus, cookie
// banner and footer. This narrows the text to the ad itself, and falls back to
// the untouched text whenever the heuristics would leave too little behind.

const NOISE = /cookie|samtykke|consent|gdpr|persondatapolitik|privatlivspolitik|password|adgangskode|javascript|browser is outdated|skip to|gå til (sidens|primært) indhold|^©|^&copy;|^&times;$|^×$/i;
const CHROME_ENTITIES = { '&amp;': '&', '&nbsp;': ' ', '&times;': '×', '&copy;': '©', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };
const normTitle = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function trimPageChrome(text, title) {
  const decoded = text.replace(/&(amp|nbsp|times|copy|quot|#39|lt|gt);/g, (m) => CHROME_ENTITIES[m] ?? m);
  const lines = decoded.split('\n').map((l) => l.trim());
  const long = (l) => l.length >= 60;

  let start = -1;
  const t = title ? normTitle(title) : '';
  if (t.length >= 4) start = lines.findIndex((l) => { const n = normTitle(l); return n.length < t.length + 40 && n.includes(t); });
  if (start < 0) {
    const firstPara = lines.findIndex((l) => long(l) && !NOISE.test(l));
    start = Math.max(0, firstPara - 1);
  }

  const KEEP = /@|\+?\d[\d ]{6,}|deadline|frist|contact|kontakt/i;
  const out = [];
  let shortRun = [];
  let footer = false;
  let prev = '';
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (NOISE.test(l)) continue;
    if (l && l === prev) continue;
    if (l) prev = l;
    if (!l || l.length < 40) {
      shortRun.push(l);
      if (shortRun.filter(Boolean).length >= 10) { footer = true; break; }
      continue;
    }
    out.push(...shortRun, l);
    shortRun = [];
  }
  const tail = shortRun.filter(Boolean);
  out.push(...(footer ? tail.filter((l) => KEEP.test(l)) : tail).slice(0, 4));

  const kept = out.join('\n').trim();
  if (!out.some((l) => l.length >= 60)) return decoded.length > 1000 ? '' : decoded;
  if (kept.length < 200 && decoded.length > 1000) return decoded;
  return kept;
}

// ---------------------------------------------------------------- HTTP

function shortError(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Request timed out';
  return String(e?.cause?.message ?? e?.message ?? e).slice(0, 200);
}

/**
 * One request with the CLIs' backoff: 429/5xx retried up to six times,
 * 500ms doubling (capped at `maxDelay`) plus 0-500ms jitter, honouring
 * Retry-After when `useRetryAfter` is set (freehire). Unlike the CLIs, the
 * whole call shares one deadline: a wait that would cross it fails at once
 * with the last status, and each request's timeout shrinks to what is left.
 * Returns the final Response (any non-retryable status) for the caller.
 */
async function portalFetch(url, init, { host, deadline, maxDelay = 5000, useRetryAfter = false, onNetworkError }) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== host) throw new Error('Refusing to fetch outside the portal');
  let delay = 500;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Request timed out');
    let response;
    try {
      response = await fetchFollowing(target.href, init, AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)));
    } catch (e) {
      if (onNetworkError) throw new Error(onNetworkError(e));
      throw new Error(shortError(e));
    }
    if (response.status === 429 || response.status >= 500) {
      const failure = `${useRetryAfter ? 'freehire API request failed' : 'API request failed'}: ${response.status} ${response.statusText}`.trim();
      if (attempt === MAX_RETRIES) throw new Error(failure);
      let wait = delay + Math.floor(_internals.random() * 500);
      if (useRetryAfter) wait = Math.max(wait, retryAfterMs(response.headers.get('Retry-After')) ?? 0);
      if (Date.now() + wait >= deadline) throw new Error(failure);
      await response.body?.cancel().catch(() => {});
      await _internals.sleep(wait);
      delay = Math.min(delay * 2, maxDelay);
      continue;
    }
    return response;
  }
  throw new Error('API request failed after max retries');
}

// The first URL is always the portal's own (checked above). Portals do
// redirect elsewhere: Jobindex sends an externally hosted ad to the
// employer's ATS (hr-manager.net, easycruit.com, ...), and the CLIs follow
// that, so this does too. Each hop is followed by hand so that a redirect can
// never point the function at a local or private-network address.
const MAX_REDIRECTS = 5;

export function isPublicRedirectTarget(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  if (u.port && !['80', '443'].includes(u.port)) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.includes(':')) return false; // IPv6 literal: real ATS hosts never redirect to one
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  } else if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    return false; // shorthand/hex IPv4 spellings
  }
  return true;
}

async function fetchFollowing(href, init, signal) {
  let url = href;
  let method = init.method ?? 'GET';
  let body = init.body;
  for (let hop = 0; ; hop++) {
    const response = await fetch(url, { ...init, method, body, redirect: 'manual', signal });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status > 399 || !location) return response;
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
    const next = new URL(location, url).href;
    if (!isPublicRedirectTarget(next)) throw new Error('Refused a redirect to a non-public address');
    url = next;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
  }
}

function retryAfterMs(header, now = Date.now()) {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(date - now, 0);
}

const statusError = (r) => new Error(`API request failed: ${r.status} ${r.statusText}`.trim());

async function readJson(response, portalName) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${portalName} returned an unreadable response`);
  }
}

// ---------------------------------------------------------------- HTML entity decoding
// he.decode's behaviour for numeric references and for the named references
// job ads actually use (Latin-1, Danish letters, typography). Named references
// outside this table, and legacy ones written without a semicolon, are left
// as written; node-html-parser (via he) knows all 2,231 of them.

const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
const NAMED = Object.fromEntries(LATIN1.map((n, i) => [n, String.fromCodePoint(160 + i)]));
Object.assign(NAMED, {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ',
  fnof: 'ƒ', circ: 'ˆ', tilde: '˜', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍',
  lrm: '‎', rlm: '‏', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”',
  bdquo: '„', dagger: '†', Dagger: '‡', bull: '•', hellip: '…', permil: '‰', prime: '′', Prime: '″', lsaquo: '‹',
  rsaquo: '›', oline: '‾', euro: '€', trade: '™', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', minus: '−',
  hyphen: '‐', dash: '‐', NewLine: '\n', Tab: '\t', colon: ':', comma: ',', period: '.', excl: '!', quest: '?',
  num: '#', percnt: '%', lpar: '(', rpar: ')', ast: '*', plus: '+', sol: '/', bsol: '\\', semi: ';', equals: '=',
  commat: '@', lsqb: '[', rsqb: ']', lowbar: '_', grave: '`', lcub: '{', rcub: '}', verbar: '|', vert: '|',
  check: '✓', cross: '✗', star: '☆', starf: '★', middot: '·', laquo: '«', raquo: '»',
});
// HTML's remapping of C1 control references (&#128; etc.) to windows-1252.
const C1 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8e: 0x17d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9e: 0x17e, 0x9f: 0x178 };

function codePointText(cp) {
  if (C1[cp]) return String.fromCodePoint(C1[cp]);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}

function heDecode(s) {
  if (!s || !s.includes('&')) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([A-Za-z][A-Za-z0-9]*);)/g, (m, hex, dec, name) => {
    if (hex) return codePointText(parseInt(hex, 16));
    if (dec) return codePointText(parseInt(dec, 10));
    return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : m;
  });
}

// ---------------------------------------------------------------- mini DOM (node-html-parser 6.1.13 subset)
// Jobdanmark's detail parser is written against node-html-parser. This is a
// line-for-line port of the parts it uses: the same markup regex, the same
// implicit-close and repair rules (so malformed markup nests the same way),
// .text, .structuredText, getAttribute and querySelector(All) for the
// selector shapes the parser uses (tag, .class, [attr="v"], [attr^="v"],
// descendant combinator, comma lists).

const MARKUP = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][-.:0-9_a-zA-Z]*)((?:\s+[^>]*?(?:(?:'[^']*')|(?:"[^"]*"))?)*)\s*(\/?)>/g;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].flatMap((t) => [t, t.toUpperCase()]));
const RAW_TEXT = /^(script|noscript|style|pre)$/i;
const pairs = (keys) => Object.fromEntries(keys.flatMap((k) => [[k, true], [k.toUpperCase(), true]]));
const CLOSED_BY_OPENING = {};
for (const [k, v] of Object.entries({ li: ['li'], p: ['p', 'div'], b: ['div'], td: ['td', 'th'], th: ['td', 'th'], h1: ['h1'], h2: ['h2'], h3: ['h3'], h4: ['h4'], h5: ['h5'], h6: ['h6'] })) {
  CLOSED_BY_OPENING[k] = CLOSED_BY_OPENING[k.toUpperCase()] = pairs(v);
}
const CLOSED_BY_CLOSING = {};
for (const [k, v] of Object.entries({ li: ['ul', 'ol'], a: ['div'], b: ['div'], i: ['div'], p: ['div'], td: ['tr', 'table'], th: ['tr', 'table'] })) {
  CLOSED_BY_CLOSING[k] = CLOSED_BY_CLOSING[k.toUpperCase()] = pairs(v);
}
const BLOCK = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'details', 'dialog', 'dd', 'div', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'table', 'td', 'tr', 'address', 'article', 'aside', 'blockquote', 'br', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'ul'].flatMap((t) => [t, t.toUpperCase()]));

const newEl = (tag, rawAttrs) => ({ kind: 'el', tag, rawAttrs, children: [], parent: null, attrs: null });
const newText = (raw) => ({ kind: 'text', raw, parent: null });
function appendChild(parent, node) {
  if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
  parent.children.push(node);
  node.parent = parent;
}
const upper = (el) => (el.tag ? el.tag.toUpperCase() : el.tag);

export function parseHtml(html) {
  const FRAME = 'documentfragmentcontainer';
  const data = `<${FRAME}>${html}</${FRAME}>`;
  const dataEndPos = data.length - (FRAME.length + 2);
  const root = newEl(null, '');
  const stack = [root];
  let current = root;
  let lastTextPos = -1;
  const re = new RegExp(MARKUP.source, 'g');
  let m;
  while ((m = re.exec(data))) {
    const [matchText, , tagName, attributes, closingSlash] = m;
    let leadingSlash = m[1];
    const tagEndPos = re.lastIndex;
    const tagStartPos = tagEndPos - matchText.length;
    if (lastTextPos > -1 && lastTextPos + matchText.length < tagEndPos) {
      appendChild(current, newText(data.substring(lastTextPos, tagStartPos)));
    }
    lastTextPos = re.lastIndex;
    if (tagName === FRAME) continue;
    if (matchText[1] === '!') continue; // comments are dropped
    if (!leadingSlash) {
      if (!closingSlash && CLOSED_BY_OPENING[current.tag]?.[tagName]) {
        stack.pop();
        current = stack[stack.length - 1];
      }
      const el = newEl(tagName, attributes.slice(1));
      appendChild(current, el);
      current = el;
      stack.push(el);
      if (RAW_TEXT.test(tagName)) {
        const closeMarkup = `</${tagName}>`;
        const closeIndex = data.indexOf(closeMarkup, re.lastIndex);
        const textEnd = closeIndex === -1 ? dataEndPos : closeIndex;
        const inner = data.substring(tagEndPos, textEnd);
        if (inner.length > 0 && /\S/.test(inner)) appendChild(el, newText(inner));
        if (closeIndex === -1) {
          lastTextPos = re.lastIndex = data.length + 1;
        } else {
          lastTextPos = re.lastIndex = closeIndex + closeMarkup.length;
          leadingSlash = '/';
        }
      }
    }
    if (leadingSlash || closingSlash || VOID.has(tagName)) {
      for (;;) {
        if (current.tag === tagName) {
          stack.pop();
          current = stack[stack.length - 1];
          break;
        }
        if (CLOSED_BY_CLOSING[upper(current)]?.[tagName]) {
          stack.pop();
          current = stack[stack.length - 1];
          continue;
        }
        break;
      }
    }
  }
  // Repair elements left open, exactly as node-html-parser's parse() does.
  while (stack.length > 1) {
    const last = stack.pop();
    const oneBefore = stack[stack.length - 1];
    if (last.parent && last.parent.parent) {
      if (last.parent === oneBefore && upper(last) === upper(oneBefore)) {
        oneBefore.children = oneBefore.children.filter((c) => c !== last);
        for (const child of [...last.children]) appendChild(oneBefore.parent, child);
        stack.pop();
      } else {
        oneBefore.children = oneBefore.children.filter((c) => c !== last);
        for (const child of [...last.children]) appendChild(oneBefore, child);
      }
    }
  }
  return root;
}

function rawText(node) {
  if (node.kind === 'text') return node.raw;
  if (node.tag && /^br$/i.test(node.tag)) return '\n';
  return node.children.map(rawText).join('');
}

export const textOf = (node) => (node ? heDecode(rawText(node)) : '');

function trimText(text) {
  let i = 0;
  let startPos;
  let endPos;
  while (i >= 0 && i < text.length) {
    if (/\S/.test(text[i])) {
      if (startPos === undefined) {
        startPos = i;
        i = text.length;
      } else {
        endPos = i;
        i = undefined;
      }
    }
    if (startPos === undefined) i++;
    else i--;
  }
  if (startPos === undefined) startPos = 0;
  if (endPos === undefined) endPos = text.length - 1;
  const hasLeadingSpace = startPos > 0 && /[^\S\r\n]/.test(text[startPos - 1]);
  const hasTrailingSpace = endPos < text.length - 1 && /[^\S\r\n]/.test(text[endPos + 1]);
  return (hasLeadingSpace ? ' ' : '') + text.slice(startPos, endPos + 1) + (hasTrailingSpace ? ' ' : '');
}

export function structuredText(node) {
  let currentBlock = [];
  const blocks = [currentBlock];
  const dfs = (n) => {
    if (n.kind === 'el') {
      if (BLOCK.has(n.tag)) {
        if (currentBlock.length > 0) blocks.push((currentBlock = []));
        n.children.forEach(dfs);
        if (currentBlock.length > 0) blocks.push((currentBlock = []));
      } else {
        n.children.forEach(dfs);
      }
    } else if (/^(\s|&nbsp;)*$/.test(n.raw)) {
      currentBlock.prependWhitespace = true;
    } else {
      let text = trimText(heDecode(n.raw));
      if (currentBlock.prependWhitespace) {
        text = ` ${text}`;
        currentBlock.prependWhitespace = false;
      }
      currentBlock.push(text);
    }
  };
  dfs(node);
  return blocks.map((b) => b.join('').replace(/\s{2,}/g, ' ')).join('\n').replace(/\s+$/, '');
}

export function getAttribute(el, name) {
  if (!el || el.kind !== 'el') return undefined;
  if (!el.attrs) {
    const raw = {};
    const re = /([a-zA-Z()[\]#@$.?:][a-zA-Z0-9-_:()[\]#]*)(?:\s*=\s*((?:'[^']*')|(?:"[^"]*")|\S+))?/g;
    let m;
    while ((m = re.exec(el.rawAttrs || ''))) {
      let val = m[2] || null;
      if (val && (val[0] === "'" || val[0] === '"')) val = val.slice(1, val.length - 1);
      raw[m[1]] = raw[m[1]] || val;
    }
    el.attrs = {};
    for (const key of Object.keys(raw)) el.attrs[key.toLowerCase()] = heDecode(raw[key] || '');
  }
  return Object.prototype.hasOwnProperty.call(el.attrs, name.toLowerCase()) ? el.attrs[name.toLowerCase()] : undefined;
}

function parseSelector(selector) {
  return selector.split(',').map((group) =>
    group.trim().split(/\s+/).map((compound) => {
      const part = { tag: null, classes: [], attrs: [] };
      const re = /^([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(\^?=)"([^"]*)"\]/g;
      let m;
      let consumed = 0;
      while ((m = re.exec(compound)) && m.index === consumed) {
        consumed += m[0].length;
        if (m[1]) part.tag = m[1].toLowerCase();
        else if (m[2]) part.classes.push(m[2]);
        else part.attrs.push({ name: m[3], op: m[4], value: m[5] });
      }
      if (consumed !== compound.length) throw new Error(`Unsupported selector: ${selector}`);
      return part;
    }));
}

function matchesCompound(el, part) {
  if (part.tag && (el.tag || '').toLowerCase() !== part.tag) return false;
  if (part.classes.length) {
    const cls = (getAttribute(el, 'class') ?? '').split(/\s+/);
    if (!part.classes.every((c) => cls.includes(c))) return false;
  }
  for (const a of part.attrs) {
    const v = getAttribute(el, a.name);
    if (v === undefined) return false;
    if (a.op === '=' ? v !== a.value : !(a.value && v.startsWith(a.value))) return false;
  }
  return true;
}

function matchesChain(el, chain) {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  let anc = el.parent;
  while (i >= 0 && anc) {
    if (anc.tag !== null && matchesCompound(anc, chain[i])) i--;
    anc = anc.parent;
  }
  return i < 0;
}

export function querySelectorAll(root, selector) {
  const groups = parseSelector(selector);
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.kind !== 'el') continue;
      if (groups.some((g) => matchesChain(c, g))) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

export const querySelector = (root, selector) => querySelectorAll(root, selector)[0] ?? null;

// ================================================================ JOBINDEX
// CLI: jobindex-search/cli/src/{helpers.ts,commands/search.ts,commands/detail.ts}

const JOBINDEX_HOST = 'www.jobindex.dk';
const JOBINDEX_BASE = 'https://www.jobindex.dk';
const JOBINDEX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; jobindex-cli/1.0)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'da,en;q=0.9',
};

async function jobindexHtml(url, deadline) {
  const r = await portalFetch(url, { headers: JOBINDEX_HEADERS, redirect: 'follow' }, { host: JOBINDEX_HOST, deadline });
  if (r.status === 404) throw new Error('Job not found');
  if (!r.ok) throw statusError(r);
  return r.text();
}

export function extractStash(html) {
  const marker = 'var Stash = ';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('Could not locate Stash blob in jobindex HTML');
  const open = start + marker.length;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let j = open; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = j + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error('Unterminated Stash blob in jobindex HTML');
  return JSON.parse(html.slice(open, end));
}

function findSearchResponse(node) {
  if (node && typeof node === 'object') {
    if (!Array.isArray(node)) {
      if (node.searchResponse && typeof node.searchResponse === 'object' && Array.isArray(node.searchResponse.results)) {
        return node.searchResponse;
      }
      for (const key of Object.keys(node)) {
        const found = findSearchResponse(node[key]);
        if (found) return found;
      }
    } else {
      for (const item of node) {
        const found = findSearchResponse(item);
        if (found) return found;
      }
    }
  }
  return null;
}

export function parseJobindexSearchPage(html) {
  const sr = findSearchResponse(extractStash(html));
  if (!sr) throw new Error('Could not locate searchResponse in jobindex Stash');
  const results = (sr.results ?? []).map((r) => {
    const tid = r.tid ?? '';
    let location = r.area ?? null;
    if (!location) location = r.geojson?.features?.[0]?.properties?.title ?? null;
    let deadline = null;
    if (r.apply_deadline_asap) deadline = null;
    else if (typeof r.apply_deadline === 'string') deadline = r.apply_deadline.slice(0, 10);
    else if (typeof r.lastdate === 'string') deadline = r.lastdate;
    return {
      id: tid,
      title: r.headline ?? '',
      company: r.company?.name ?? r.companytext ?? null,
      companyUrl: r.company?.homeurl ?? null,
      location,
      date: r.firstdate ?? null,
      deadline,
      url: tid ? `${JOBINDEX_BASE}/jobannonce/${tid}` : (r.share_url ?? r.url ?? ''),
      description: null,
    };
  });
  return { total: typeof sr.hitcount === 'number' ? sr.hitcount : results.length, results };
}

const numericEntity = (cp) => (cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '');

function jobindexDecode(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&oslash;/g, 'ø')
    .replace(/&Oslash;/g, 'Ø')
    .replace(/&aelig;/g, 'æ')
    .replace(/&AElig;/g, 'Æ')
    .replace(/&aring;/g, 'å')
    .replace(/&Aring;/g, 'Å')
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ');
}

const stripTags = (html) => html.replace(/<[^>]+>/g, '').trim();

/** detail.ts buildUrl: a bare id, or a jobindex.dk /jobannonce/<id> URL. */
export function jobindexNormalizeId(idOrUrl) {
  const trimmed = String(idOrUrl).trim();
  if (/^https?:\/\//i.test(trimmed)) {
    let host;
    try {
      host = new URL(trimmed).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (host !== 'jobindex.dk' && !host.endsWith('.jobindex.dk')) return null;
    const match = trimmed.match(/\/jobannonce\/([a-zA-Z]\d+)/);
    return match ? match[1] : null;
  }
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

const DANISH_MONTHS = { januar: '01', februar: '02', marts: '03', april: '04', maj: '05', juni: '06', juli: '07', august: '08', september: '09', oktober: '10', november: '11', december: '12' };

function jobindexIsoDate(value) {
  if (!value) return null;
  const text = value.trim();
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = text.match(/^(\d{1,2})\.?\s+([a-zæøå]+)\s+(\d{4})/i);
  if (m) {
    const month = DANISH_MONTHS[m[2].toLowerCase()];
    if (month) return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function metaContent(html, matcher) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name|itemprop)="${matcher}"[^>]+content="([^"]*)"|<meta[^>]+content="([^"]*)"[^>]+(?:property|name|itemprop)="${matcher}"`,
    'i',
  );
  const m = html.match(re);
  const value = m ? (m[1] ?? m[2]) : null;
  return value ? jobindexDecode(value).trim() || null : null;
}

function jdBlockValue(html, cls) {
  const m = html.match(new RegExp(`class="${cls}"[^>]*>[\\s\\S]*?<p[^>]*>([\\s\\S]*?)</p>`, 'i'));
  return m ? jobindexDecode(stripTags(m[1])).replace(/\s+/g, ' ').trim() || null : null;
}

function visibleHtml(html) {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function jobindexBodyText(html) {
  const text = jobindexDecode(stripTags(visibleHtml(html).replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, '\n')))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return text || null;
}

/** detail.ts parseDetailPage (regex-based in the CLI too; no DOM library). */
export function parseJobindexDetailPage(html, url, id) {
  const isNative = html.includes('class="jd-');
  const ogTitle = metaContent(html, 'og:title');
  const itempropName = metaContent(html, 'name');
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Title = h1 ? jobindexDecode(stripTags(h1[1])).replace(/\s+/g, ' ').trim() : null;
  const title = ogTitle ?? itempropName ?? h1Title ?? '';
  if (!title) throw new Error('Failed to parse job listing HTML');

  let company = null;
  if (isNative) {
    const titleTag = html.match(/<title>([\s\S]*?)<\/title>/i);
    const pageTitle = titleTag ? jobindexDecode(titleTag[1]).replace(/\s+/g, ' ').trim() : '';
    if (pageTitle.endsWith(` - ${title}`)) company = pageTitle.slice(0, -(title.length + 3)).trim() || null;
  }

  let location = null;
  let deadline = null;
  let employmentType = null;
  let hours = null;
  let description = null;
  if (isNative) {
    location = jdBlockValue(html, 'jd-location');
    deadline = jobindexIsoDate(jdBlockValue(html, 'jd-deadline'));
    employmentType = jdBlockValue(html, 'jd-type');
    hours = jdBlockValue(html, 'jd-workhours');
    const desc = html.match(/class="jd-description"[^>]*>([\s\S]*?)<\/div>/i);
    description = desc ? jobindexDecode(stripTags(desc[1])).replace(/\s+/g, ' ').trim() || null : null;
  } else {
    const workplace = visibleHtml(html).match(/class="workplace[^"]*"[\s\S]*?<span class="empty">([\s\S]*?)<\/span>/i);
    location = workplace ? jobindexDecode(stripTags(workplace[1])).replace(/\s+/g, ' ').trim() || null : null;
    const due = visibleHtml(html).match(
      /(?:Ansøgningsfrist|Application\s*due|Frist)[\s\S]{0,300}?(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.?\s+[a-zæøå]+\s+\d{4})/i,
    );
    deadline = due ? jobindexIsoDate(due[1]) : null;
    description = jobindexBodyText(html);
    if (!description || description.length < 100) {
      description = metaContent(html, 'og:description') ?? metaContent(html, 'description') ?? description;
    }
  }
  if (!description) description = metaContent(html, 'og:description');

  let applyUrl = null;
  const ctMatch = html.match(/href="(\/c\?t=[^"]+)"/);
  if (ctMatch) applyUrl = `${JOBINDEX_BASE}${jobindexDecode(ctMatch[1])}`;
  const timeMatch = html.match(/<time[^>]+datetime="([^"]+)"/);

  return {
    id, title, company, companyUrl: null, location,
    date: timeMatch ? jobindexIsoDate(timeMatch[1]) : null,
    deadline, employmentType, hours, applyUrl, url, description,
  };
}

const jobindex = {
  // portals.ts searchArgs + search.ts handler
  async search(p, deadline) {
    if (!p.q) throw Object.assign(new Error('Needs a keyword'), { skip: true });
    const query = p.location ? `${p.q} ${p.location}` : p.q;
    const params = new URLSearchParams({
      q: query,
      page: String(p.page),
      jobage: String(p.days ?? 9999),
      sort: p.sort === 'date' ? 'date' : 'score',
    });
    const html = await jobindexHtml(`${JOBINDEX_BASE}/jobsoegning?${params.toString()}`, deadline);
    const parsed = parseJobindexSearchPage(html);
    return { meta: { total: parsed.total, page: p.page, perPage: 20 }, results: parsed.results };
  },
  normalize: (raw) => (raw.results ?? []).map((r) => baseJob('jobindex', r, String(r.id))),
  total: (raw) => raw.meta?.total ?? null,
  normalizeId: jobindexNormalizeId,
  async detail(id, deadline) {
    const url = `${JOBINDEX_BASE}/jobannonce/${id}`;
    let html;
    try {
      html = await jobindexHtml(url, deadline);
    } catch (e) {
      if (/Job not found|404|NOT_FOUND/.test(e.message)) throw new Error('Job not found');
      throw e;
    }
    const data = parseJobindexDetailPage(html, url, id);
    if (!data.title) throw new Error('Failed to parse job listing HTML');
    return data;
  },
  normalizeDetail: (r, id, titleHint) => ({
    ...baseJob('jobindex', r, id),
    employmentType: str(r.employmentType),
    snippet: null,
    description: { text: r.description ? trimPageChrome(String(r.description), titleHint || r.title) : null, pageText: true },
  }),
};

// ================================================================ JOBNET
// CLI: jobnet-search/cli/src/{helpers.ts,commands/search.ts,commands/detail.ts}

const JOBNET_HOST = 'jobnet.dk';
const JOBNET_BFF = 'https://jobnet.dk/bff';
const JOBNET_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; jobnet-cli/1.0)', 'x-csrf': '1' };

async function jobnetApi(path, params, deadline) {
  const qs = new URLSearchParams(params).toString();
  const r = await portalFetch(`${JOBNET_BFF}${path}${qs ? `?${qs}` : ''}`, { headers: JOBNET_HEADERS }, { host: JOBNET_HOST, deadline });
  if (!r.ok) throw Object.assign(statusError(r), { status: r.status });
  return readJson(r, 'Jobnet');
}

/** helpers.ts normalizeJobId: a bare id or a jobnet.dk ad URL. */
export function jobnetNormalizeId(input) {
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed;
  let url;
  try {
    const hostLike = /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed);
    url = new URL(hostLike ? `https://${trimmed}` : trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname !== 'jobnet.dk' && !url.hostname.endsWith('.jobnet.dk')) return null;
  const match = url.pathname.match(/(?:\/find-job\/|\/JobAdDetails\/|\/Details\/)(?:detaljer\/)?([a-zA-Z0-9_-]+)(?:\/|$)/i);
  return match ? match[1] : null;
}

function jobnetExternalAdUrl(job) {
  const raw = job.jobAdUrl?.trim();
  if (!job.isExternal || !raw) return null;
  try {
    const { protocol } = new URL(raw);
    return protocol === 'https:' || protocol === 'http:' ? raw : null;
  } catch {
    return null;
  }
}

// search.ts createSearchOutput, results only (facets are not used downstream).
function jobnetSearchOutput(data, page, perPage) {
  if (!Array.isArray(data?.jobAds)) throw new Error('Jobnet returned an unexpected response');
  const results = data.jobAds.map((job) => {
    const destination = jobnetExternalAdUrl(job);
    return {
      jobAdId: job.jobAdId,
      title: job.title,
      hiringOrgName: job.hiringOrgName,
      occupation: job.occupation ?? null,
      municipality: job.municipality ?? null,
      postalCode: job.postalCode ?? null,
      postalDistrictName: job.postalDistrictName ?? null,
      country: job.country,
      publicationDate: job.publicationDate,
      applicationDeadline: job.applicationDeadline ?? null,
      workHourPartTime: job.workHourPartTime,
      isExternal: job.isExternal,
      jobAdUrl: destination,
      id: job.jobAdId,
      company: job.hiringOrgName,
      location: job.postalDistrictName ?? job.municipality ?? null,
      date: job.publicationDate ? job.publicationDate.slice(0, 10) : null,
      deadline: job.applicationDeadline && !job.applicationDeadline.startsWith('1900-01-01') ? job.applicationDeadline.slice(0, 10) : null,
      url: `https://jobnet.dk/find-job/${job.jobAdId}`,
      applyUrl: destination,
    };
  });
  return { meta: { totalJobAdCount: data.totalJobAdCount, pageNumber: page, resultsPerPage: perPage, searchString: data.searchString ?? null }, results };
}

// detail.ts mapSearchAdToDetail: the search ad reshaped as a detail record,
// used when JobAdDetails 404s for an external ad.
function jobnetSearchAdToDetail(raw) {
  const street = raw.workPlaceAddress ? raw.workPlaceAddress.trim() : null;
  return {
    id: raw.jobAdId,
    title: raw.title,
    body: raw.description ?? '',
    publicationDateTime: raw.publicationDate ?? '',
    unpublicationDateTime: null,
    hasLogo: Boolean(raw.hasLogo),
    logoUrl: raw.logoUrl ?? null,
    isExternal: true,
    source: 'search-fallback',
    employer: { cvrNumber: raw.cvr ?? null, pNumber: null, name: raw.hiringOrgName ?? '', hasCompanyLogo: Boolean(raw.hasLogo) },
    job: {
      type: raw.jobAnnouncementTypeName ?? (raw.workHourPartTime != null ? (raw.workHourPartTime ? 'PartTime' : 'FullTime') : null),
      address: {
        streetName: street && street.length > 0 ? street : null,
        city: raw.postalDistrictName ?? raw.municipality ?? null,
        postalCode: raw.postalCode ? String(raw.postalCode) : null,
        municipality: raw.municipality ?? null,
        countryCode: raw.country === 'Danmark' ? 'DK' : (raw.country || 'DK'),
        countryName: raw.country || 'Danmark',
      },
      isPartTime: raw.workHourPartTime != null ? Boolean(raw.workHourPartTime) : null,
      preferredLabelDa: raw.occupation ?? null,
    },
    application: {
      deadlineDate: raw.applicationDeadline ?? null,
      contactPersons: [],
      url: raw.jobAdUrl && raw.jobAdUrl.trim().length > 0 ? raw.jobAdUrl.trim() : null,
      isApplicationDeadlineASAP: raw.applicationDeadlineStatus ? raw.applicationDeadlineStatus === 'NotDisclosed' : null,
    },
  };
}

function jobnetPrepareDetail(data) {
  const deadline = data?.application?.deadlineDate;
  if (deadline && deadline.startsWith('1900-01-01')) data.application.deadlineDate = null;
  return data;
}

const jobnet = {
  async search(p, deadline) {
    // portals.ts: --page, --per-page 20, text = q + non-postal location, --postal-code for 4 digits.
    const postal = /^\d{4}$/.test(p.location);
    const text = [p.q, postal ? '' : p.location].filter(Boolean).join(' ');
    // search.ts buildSearchParams with the CLI defaults (order PublicationDate, radius 50).
    const params = { resultsPerPage: '20', pageNumber: String(p.page), orderType: 'PublicationDate' };
    if (text) params.searchString = text;
    if (postal) {
      params.postalCode = p.location;
      params.kmRadius = '50';
    }
    return jobnetSearchOutput(await jobnetApi('/FindJob/Search', params, deadline), p.page, 20);
  },
  normalize: (raw) =>
    (raw.results ?? []).map((r) => ({
      ...baseJob('jobnet', r, String(r.id ?? r.jobAdId)),
      location: str(r.location) ?? str(r.postalDistrictName) ?? str(r.municipality),
      tags: [str(r.occupation), r.workHourPartTime ? 'Part-time' : null].filter(Boolean),
    })),
  total: (raw) => raw.meta?.totalJobAdCount ?? null,
  normalizeId: jobnetNormalizeId,
  async detail(id, deadline) {
    try {
      return jobnetPrepareDetail(await jobnetApi(`/FindJob/JobAdDetails/${id}`, { incrementViews: 'false' }, deadline));
    } catch (e) {
      if (!(e.status === 404 || /404|Not Found/.test(e.message))) throw e;
    }
    let data = null;
    try {
      const found = await jobnetApi('/FindJob/Search', { searchString: id, resultsPerPage: '5', pageNumber: '1', orderType: 'PublicationDate' }, deadline);
      const match = found.jobAds?.find((ad) => ad.jobAdId === id);
      if (match) data = jobnetPrepareDetail(jobnetSearchAdToDetail(match));
    } catch {
      // fall through to not found, as the CLI does
    }
    if (!data) throw new Error('Job ad not found');
    return data;
  },
  // portals.ts normalizeDetail, verbatim. NB: it reads company/location/date/
  // url from fields the detail JSON does not have, so those come back null/""
  // here exactly as in the local UI, which fills them from the search row.
  normalizeDetail: (r, id) => ({
    ...baseJob('jobnet', r, id),
    company: str(r.company) ?? str(r.hiringOrgName),
    employmentType: str(r.employmentType) ?? str(r.workHours),
    description: { html: r.body ?? r.description },
  }),
};

// ================================================================ JOBDANMARK
// CLI: jobdanmark-search/cli/src/{helpers.ts,commands/search.ts,commands/detail.ts}

const JOBDANMARK_HOST = 'jobdanmark.dk';
const JOBDANMARK_BASE = 'https://jobdanmark.dk';
const JOBDANMARK_UA = 'Mozilla/5.0 (compatible; jobdanmark-cli/1.0)';

/** helpers.ts normalizeSlug, plus a stricter final check (see below). */
export function jobdanmarkNormalizeSlug(input) {
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\/job\/([^/?#]+)/);
  let slug = null;
  if (match) slug = match[1];
  else if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) slug = trimmed;
  // The CLI accepts any [^/?#]+ after /job/. The URL is always rebuilt on
  // jobdanmark.dk, but a segment like ".." or one with spaces/quotes would
  // still reach a different path; real slugs are URL-safe tokens.
  if (slug && (!/^[A-Za-z0-9._~%-]+$/.test(slug) || /^\.+$/.test(slug))) return null;
  return slug;
}

export function jobdanmarkContractDate(value) {
  const match = value?.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : (value ?? null);
}

export function jobdanmarkCity(address) {
  if (!address) return null;
  const city = address.match(/\d{4}\s+(.+)$/)?.[1] ?? address.match(/\d{4}\s*,\s*([^\d,].*)$/)?.[1];
  const trimmed = city?.trim();
  return trimmed ? trimmed : null;
}

function jobdanmarkItem(item) {
  const relativeUrl = item.url;
  const fullUrl = relativeUrl.startsWith('http') ? relativeUrl : `${JOBDANMARK_BASE}${relativeUrl}`;
  const slug = relativeUrl.replace(/^\/job\//, '');
  return {
    title: item.title,
    companyName: item.companyName,
    companyAddress: item.companyAddress,
    jobTypes: item.jobTypes,
    publishedDate: item.publishedDate,
    applicationDeadline: item.applicationDeadline ?? null,
    url: fullUrl,
    slug,
    id: slug,
    company: item.companyName,
    location: jobdanmarkCity(item.companyAddress),
    date: jobdanmarkContractDate(item.publishedDate),
    deadline: jobdanmarkContractDate(item.applicationDeadline),
  };
}

const STRAY_CLOSING_TAG = /<\s*\/\s*[a-z][a-z0-9-]*\s*>/gi;
const jdmClean = (text) => text.replace(STRAY_CLOSING_TAG, ' ').replace(/\s+/g, ' ').trim();

function jdmDescriptionToText(html) {
  if (!html) return '';
  return structuredText(parseHtml(html)).split('\n').map(jdmClean).filter(Boolean).join('\n');
}

function jdmNormalizeUrl(value) {
  if (!value) return null;
  const decoded = value.replace(/&amp;/g, '&');
  if (decoded.startsWith('http')) return decoded;
  if (decoded.startsWith('/')) return `${JOBDANMARK_BASE}${decoded}`;
  return decoded;
}

const isJobPosting = (v) => Boolean(v && typeof v === 'object' && v['@type'] === 'JobPosting');

function jdmFindJsonLd(root) {
  for (const script of querySelectorAll(root, 'script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(textOf(script));
      if (isJobPosting(parsed)) return parsed;
      if (Array.isArray(parsed)) {
        const found = parsed.find(isJobPosting);
        if (found) return found;
      }
    } catch {
      // next script
    }
  }
  return null;
}

function jdmFromJsonLd(jp, slug, url) {
  const org = jp.hiringOrganization;
  const address = jp.jobLocation?.address;
  const employmentType = Array.isArray(jp.employmentType) ? jp.employmentType : jp.employmentType ? [jp.employmentType] : [];
  return {
    slug, url,
    title: jp.title ?? '',
    datePosted: jp.datePosted ?? '',
    validThrough: jp.validThrough ?? null,
    employmentType,
    hiringOrganization: { name: org?.name ?? '', logo: org?.logo ?? null },
    jobLocation: {
      streetAddress: address?.streetAddress ?? null,
      addressLocality: address?.addressLocality ?? null,
      addressRegion: address?.addressRegion ?? null,
      postalCode: address?.postalCode ?? null,
      addressCountry: address?.addressCountry ?? null,
    },
    description: jdmDescriptionToText(jp.description),
    applyUrl: null,
  };
}

function jdmOverviewDate(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^løbende$/iu.test(trimmed)) return null;
  const match = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : jobdanmarkContractDate(trimmed);
}

function jdmOverviewValue(root, label) {
  const wanted = label.toLowerCase();
  for (const item of querySelectorAll(root, '.job-overview li')) {
    const strong = querySelector(item, 'strong');
    const strongText = strong ? textOf(strong) : '';
    if (jdmClean(strongText).replace(/:$/, '').toLowerCase() !== wanted) continue;
    const value = jdmClean(textOf(item).replace(strongText, ''));
    return value.replace(/^:\s*/, '') || null;
  }
  return null;
}

function jdmFromRenderedHtml(root, slug, url) {
  const pageTitle = jdmClean(textOf(querySelector(root, 'title')));
  const titleLower = pageTitle.toLowerCase();
  const bodyText = textOf(root).toLowerCase();
  if (bodyText.includes('siden blev ikke fundet') || titleLower.startsWith('404') || titleLower.includes('page not found') || titleLower.includes('siden blev ikke fundet')) {
    throw new Error('NOT_FOUND');
  }
  const title =
    jdmClean(textOf(querySelector(root, '.job-list-details .title'))) ||
    jdmClean(textOf(querySelector(root, 'h1'))) ||
    jdmClean(textOf(querySelector(root, 'h3'))).replace(/\s+\|\s+jobdanmark$/, '');
  if (!title) throw new Error('Failed to parse job page HTML');

  const companyName = jdmClean(textOf(querySelector(root, '.job-details-head a[href^="/virksomheder/"]')));
  const logoSrc =
    getAttribute(querySelector(root, '.company-logo img'), 'src') ??
    getAttribute(querySelector(root, '.company-logo source'), 'srcset')?.split(/\s+/)[0];
  const workplace = jdmOverviewValue(root, 'Arbejdssted');
  const description = querySelectorAll(root, '.job-list-details p, .job-list-details li')
    .map((n) => jdmClean(textOf(n)))
    .filter(Boolean)
    .join('\n');
  const employmentType = jdmOverviewValue(root, 'Jobtype');
  const applyUrl = jdmNormalizeUrl(getAttribute(querySelector(root, 'a.action.primary'), 'href'));
  return {
    slug, url, title,
    datePosted: jdmOverviewDate(jdmOverviewValue(root, 'Udgivet')) ?? '',
    validThrough: jdmOverviewDate(jdmOverviewValue(root, 'Ansøgningsfrist')),
    employmentType: employmentType ? [employmentType] : [],
    hiringOrganization: { name: companyName, logo: jdmNormalizeUrl(logoSrc) },
    jobLocation: { streetAddress: workplace, addressLocality: jobdanmarkCity(workplace), addressRegion: null, postalCode: null, addressCountry: 'DK' },
    description,
    applyUrl,
  };
}

/** detail.ts parseJobPostingFromHtml, on the mini DOM above. */
export function parseJobdanmarkDetail(html, slug, url) {
  const root = parseHtml(html);
  const jp = jdmFindJsonLd(root);
  return jp ? jdmFromJsonLd(jp, slug, url) : jdmFromRenderedHtml(root, slug, url);
}

// Jobdanmark matches municipalities by their Danish names only ("Copenhagen"
// returns nothing, "København" returns results), so common English spellings
// are translated before the search.
const DANISH_CITY_NAMES = {
  copenhagen: 'København', 'copenhagen k': 'København', elsinore: 'Helsingør', 'aarhus c': 'Aarhus',
  zealand: 'Sjælland', jutland: 'Jylland', funen: 'Fyn',
};

const jobdanmark = {
  async search(p, deadline) {
    // portals.ts: --text q, --zip for 4 digits, otherwise --municipality.
    const filters = [];
    if (p.q) filters.push({ type: 'freetext', value: p.q, displayText: p.q });
    if (/^\d{4}$/.test(p.location)) filters.push({ type: 'zip', value: p.location, displayText: p.location });
    else if (p.location) {
      const municipality = DANISH_CITY_NAMES[p.location.trim().toLowerCase()] || p.location;
      filters.push({ type: 'municipality', value: municipality, displayText: municipality });
    }
    const body = { jobTypes: [], filters, locationMode: 'Text', distance: 50 };
    const r = await portalFetch(
      `${JOBDANMARK_BASE}/api/jobsearch/search/${p.page}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': JOBDANMARK_UA }, body: JSON.stringify(body) },
      { host: JOBDANMARK_HOST, deadline },
    );
    if (!r.ok) throw statusError(r);
    const data = await readJson(r, 'Jobdanmark');
    if (!Array.isArray(data?.items)) throw new Error('Jobdanmark returned an unexpected response');
    return {
      meta: { currentPage: data.currentPage, totalItems: data.totalItems, itemsPrPage: data.itemsPrPage, totalPages: data.totalPages },
      results: data.items.map(jobdanmarkItem),
    };
  },
  normalize: (raw) =>
    (raw.results ?? []).map((r) => ({
      ...baseJob('jobdanmark', r, String(r.slug)),
      tags: (r.jobTypes ?? []).map(String),
    })),
  total: (raw) => raw.meta?.totalItems ?? null,
  normalizeId: jobdanmarkNormalizeSlug,
  async detail(slug, deadline) {
    const url = `${JOBDANMARK_BASE}/job/${slug}`;
    const r = await portalFetch(url, { headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': JOBDANMARK_UA } }, { host: JOBDANMARK_HOST, deadline });
    if (r.status === 404) throw new Error('Job not found');
    if (!r.ok) throw statusError(r);
    try {
      return parseJobdanmarkDetail(await r.text(), slug, url);
    } catch (e) {
      if (e.message.includes('NOT_FOUND')) throw new Error('Job not found');
      throw e;
    }
  },
  normalizeDetail: (r, id) => ({
    ...baseJob('jobdanmark', r, id),
    company: str(r.hiringOrganization?.name),
    location: str(r.jobLocation?.addressLocality) ?? str(r.jobLocation?.streetAddress),
    date: isoDate(r.datePosted),
    deadline: isoDate(r.validThrough),
    employmentType: Array.isArray(r.employmentType) ? r.employmentType.join(', ') : str(r.employmentType),
    description: { text: r.description },
  }),
};

// ================================================================ FREEHIRE
// CLI: freehire-search/cli/src/{helpers.ts,commands/search.ts,commands/detail.ts,cli.ts}
// FREEHIRE_API_URL (self-hosting) is deliberately not supported here: the
// host is fixed so no environment value can redirect requests.

const FREEHIRE_HOST = 'freehire.me';
const FREEHIRE_BASE = 'https://freehire.me';
const FREEHIRE_UA = 'mannysinghx/AIJOBNINJA/1.0 (freehire-search)';

async function freehireGet(path, deadline) {
  const r = await portalFetch(
    `${FREEHIRE_BASE}${path}`,
    { headers: { 'User-Agent': FREEHIRE_UA, Accept: 'application/json' }, redirect: 'follow' },
    {
      host: FREEHIRE_HOST, deadline, maxDelay: 8000, useRetryAfter: true,
      onNetworkError: (e) => `could not reach the freehire API at ${FREEHIRE_BASE} (${shortError(e)})`,
    },
  );
  if (r.status === 404) return null;
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error || `freehire API request failed: ${r.status} ${r.statusText}`.trim());
  if (!body) throw new Error('freehire API returned an unparseable response body');
  return body;
}

function freehireDecode(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ');
}

const freehireDate = (value) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? '');
  return m ? m[1] : null;
};

function freehireResult(j) {
  return {
    id: j.public_slug,
    title: freehireDecode(j.title || '').trim() || '(untitled)',
    company: j.company || null,
    company_slug: j.company_slug || null,
    location: j.location || null,
    date: freehireDate(j.posted_at),
    url: j.url,
    work_mode: j.work_mode || null,
    regions: j.regions,
    countries: j.countries,
    skills: j.skills,
    description: j.description || null,
  };
}

function freehireCleanHtml(html) {
  if (!html) return null;
  const withBreaks = html.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|li|ul|ol|div|h\d)>/gi, '\n');
  const text = freehireDecode(withBreaks.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

function freehireDetailResult(j) {
  const e = j.enrichment ?? {};
  let salary = null;
  if (e.salary_min != null || e.salary_max != null) {
    const cur = e.salary_currency ? `${e.salary_currency} ` : '';
    const per = e.salary_period ? `/${e.salary_period}` : '';
    salary = e.salary_min != null && e.salary_max != null ? `${cur}${e.salary_min}–${e.salary_max}${per}` : `${cur}${e.salary_min ?? e.salary_max}${per}`;
  }
  return {
    ...freehireResult(j),
    cities: j.cities,
    seniority: e.seniority || null,
    category: e.category || null,
    employment_type: e.employment_type || null,
    salary,
    description: freehireCleanHtml(j.description),
  };
}

/** helpers.ts normalizeSlug, with freehire.me as the only accepted host. */
export function freehireNormalizeSlug(input) {
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const hasScheme = /^https?:\/\//i.test(trimmed);
  if (hasScheme || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) {
    let parsed;
    try {
      parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    } catch {
      return null;
    }
    if (!/(^|\.)freehire\.me$/i.test(parsed.hostname)) return null;
    const m = parsed.pathname.match(/^\/jobs\/([a-z0-9][a-z0-9-]*)\/?$/i);
    return m ? m[1] : null;
  }
  return /^[a-z0-9][a-z0-9-]*$/i.test(trimmed) ? trimmed : null;
}

const commaList = (raw) => raw.split(',').map((s) => s.trim()).filter(Boolean);

const freehire = {
  async search(p, deadline) {
    // portals.ts flags -> cli.ts opts -> search.ts buildQuery.
    const qs = new URLSearchParams();
    if (p.q) qs.set('q', p.q);
    qs.set('limit', '25');
    qs.set('offset', String((p.page - 1) * 25));
    qs.set('description_format', 'text');
    if (p.days) qs.set('posted_within_days', String(p.days));
    if (p.remote) qs.set('work_mode', p.remote);
    if (/^[a-z]{2}$/i.test(p.location)) qs.append('countries', p.location.toUpperCase());
    else if (p.location) for (const city of commaList(p.location)) qs.append('cities', city);
    const path = '/api/v1/agent/jobs/search';
    const env = await freehireGet(`${path}?${qs.toString()}`, deadline);
    if (!env) throw new Error(`${path} not found on the freehire API`);
    const rows = (env.data ?? []).map(freehireResult);
    return { meta: { count: rows.length, page: p.page, total: env.meta?.total ?? rows.length }, results: rows };
  },
  normalize: (raw) =>
    (raw.results ?? []).map((r) => ({
      ...baseJob('freehire', r, String(r.id)),
      snippet: snippetOf(r.description),
      tags: (r.skills ?? []).slice(0, 6).map(String),
      workMode: str(r.work_mode),
    })),
  total: (raw) => raw.meta?.total ?? null,
  normalizeId: freehireNormalizeSlug,
  async detail(slug, deadline) {
    const env = await freehireGet(`/api/v1/jobs/${encodeURIComponent(slug)}`, deadline);
    if (!env) throw new Error('job not found');
    if (!env.data || typeof env.data !== 'object') throw new Error('freehire API returned an unexpected response');
    return freehireDetailResult(env.data);
  },
  normalizeDetail: (r, id) => ({
    ...baseJob('freehire', r, id),
    tags: (r.skills ?? []).map(String),
    workMode: str(r.work_mode),
    employmentType: str(r.employment_type),
    description: { markdown: r.description },
  }),
};

// ================================================================ public API

const ADAPTERS = { jobindex, jobnet, jobdanmark, freehire };

function adapterFor(source) {
  if (!Object.prototype.hasOwnProperty.call(ADAPTERS, source)) throw new Error('Unknown source');
  return ADAPTERS[source];
}

/**
 * Search one portal with the shared search form.
 * Resolves { jobs, total }. Rejects with a short, user-presentable Error;
 * an Error with `skip: true` (jobindex without a keyword: "Needs a keyword")
 * means the portal cannot run this query, which the local UI shows as
 * "skipped" rather than as a failure.
 */
export async function searchNordic(source, params) {
  const adapter = adapterFor(source);
  const p = normalizeParams(params);
  const raw = await adapter.search(p, Date.now() + CALL_BUDGET_MS);
  let jobs = adapter.normalize(raw);
  // Not every portal filters by age server-side; apply it uniformly (server.ts).
  if (p.days) {
    const since = sinceDate(p.days);
    jobs = jobs.filter((j) => !j.date || j.date >= since);
  }
  return { jobs, total: adapter.total(raw) };
}

/**
 * Full posting for one search hit. `id` is the Job.id from searchNordic (the
 * CLIs' URL forms are accepted too, on the portal's own host only);
 * `titleHint` is the search result's title, used to trim Jobindex page chrome.
 */
export async function detailNordic(source, id, titleHint) {
  const adapter = adapterFor(source);
  const rawId = typeof id === 'string' ? id.trim() : '';
  if (!rawId || rawId.length > 300 || rawId.startsWith('-')) throw new Error('Invalid job id');
  const canonical = adapter.normalizeId(rawId);
  if (!canonical) throw new Error('Invalid job id');
  const raw = await adapter.detail(canonical, Date.now() + CALL_BUDGET_MS);
  const hint = String(titleHint ?? '').slice(0, 300);
  return adapter.normalizeDetail(raw, rawId, hint);
}
