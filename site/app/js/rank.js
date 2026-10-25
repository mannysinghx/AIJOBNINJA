// Ranking and work-mode filtering for merged search results. Each board
// returns its own relevance order, so interleaving them puts one board's
// tenth-best hit next to another's best. Instead every job is scored against
// the query the same way, here, after the boards answer.

const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a');
export const words = (s) => fold(s).split(/[^a-z0-9+#]+/).filter((w) => w.length > 1);

// English job words and their Danish counterparts (the Nordic boards return
// Danish titles), so "developer" also matches "Softwareudvikler".
const SYNONYMS = {
  developer: ['udvikler', 'programmer', 'programmor'],
  programmer: ['udvikler', 'developer', 'programmor'],
  engineer: ['ingenior', 'engineering'],
  manager: ['chef', 'leder', 'manager'],
  lead: ['leder', 'lead'],
  analyst: ['analytiker', 'analyst'],
  consultant: ['konsulent', 'radgiver'],
  advisor: ['radgiver', 'konsulent'],
  designer: ['designer'],
  architect: ['arkitekt'],
  nurse: ['sygeplejerske'],
  teacher: ['laerer', 'underviser'],
  accountant: ['bogholder', 'revisor', 'regnskab'],
  sales: ['salg', 'saelger'],
  marketing: ['marketing', 'markedsforing'],
  researcher: ['forsker', 'research'],
  scientist: ['forsker', 'scientist'],
  student: ['studentermedhjaelper', 'studiejob'],
  intern: ['praktikant', 'praktik'],
  data: ['data'],
  software: ['software', 'it'],
};

function variants(w) {
  const out = new Set([w]);
  for (const s of SYNONYMS[w] || []) out.add(s);
  // crude stemming: developers -> developer, udviklere -> udvikler
  if (w.length > 4 && w.endsWith('s')) out.add(w.slice(0, -1));
  if (w.length > 5 && w.endsWith('e')) out.add(w.slice(0, -1));
  return [...out];
}

// A word "hits" a text if any variant appears as a word or as part of a
// compound (Danish writes "softwareudvikler" as one word).
const hits = (variantsOf, textWords, joined) => variantsOf.some((v) => textWords.includes(v) || (v.length >= 4 && joined.includes(v)));

export function relevance(job, q, location) {
  const qw = words(q);
  const titleWords = words(job.title);
  const title = titleWords.join(' ');
  const titleJoined = titleWords.join('');
  let score = 0;
  if (qw.length) {
    const phrase = qw.join(' ');
    if (title.includes(phrase)) score += 60;
    let inTitle = 0;
    const other = words(`${job.company} ${job.snippet || ''} ${(job.tags || []).join(' ')}`);
    const otherJoined = other.join('');
    for (const w of qw) {
      const v = variants(w);
      if (hits(v, titleWords, titleJoined)) { inTitle++; score += 14; }
      else if (hits(v, other, otherJoined)) score += 3;
    }
    if (inTitle === qw.length) score += 25;
    if (inTitle === 0) score -= 20; // the board matched it on body text only
  }
  const lw = words(location);
  if (lw.length) {
    const loc = words(job.location).join(' ');
    if (lw.some((w) => loc.includes(w))) score += 8;
  }
  if (job.date) {
    const age = (Date.now() - new Date(job.date + 'T00:00:00').getTime()) / 86400000;
    if (age >= 0) score += Math.max(0, 6 - age / 5); // up to +6 for today, fades over a month
  }
  return score;
}

const REMOTE_RE = /\b(remote|fully remote|work from home|wfh|anywhere|hjemmearbejde|fjernarbejde|distancearbejde)\b/;
const HYBRID_RE = /\b(hybrid|delvis hjemmearbejde|flexible location|fleksibel arbejdsplads)\b/;

export function workMode(job) {
  const declared = String(job.workMode || '').toLowerCase();
  if (declared === 'remote' || declared === 'hybrid' || declared === 'onsite') return declared;
  const text = fold(`${job.title} ${job.location || ''} ${(job.tags || []).join(' ')}`);
  if (HYBRID_RE.test(text)) return 'hybrid';
  if (REMOTE_RE.test(text)) return 'remote';
  return null;
}

// remote: '' | 'remote' | 'hybrid'. freehire filters on the server, so its
// results already match; everything else is judged from the posting itself.
export function matchesWorkMode(job, remote) {
  if (!remote) return true;
  if (job.portal === 'freehire') return true;
  return workMode(job) === remote;
}

// Filter by work mode, then order by relevance (or newest first). Ties keep
// each board's own order, so a board's best hit still leads its group.
export function rankJobs(jobs, { q = '', location = '', remote = '', sort = 'relevance' } = {}) {
  const kept = jobs.filter((j) => matchesWorkMode(j, remote));
  if (sort === 'date') return kept.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const scored = kept.map((j, i) => ({ j, i, s: relevance(j, q, location) - (j.rank ?? 0) * 0.15 }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return diversify(scored);
}

// Equally relevant results from one board would otherwise fill the page (a
// global board can return 25 identical titles). Each further pick from the
// same board costs a little, so close scores alternate between boards while
// a clearly better match still wins outright.
const SAME_SOURCE_COST = 4;
function diversify(scored) {
  const out = [];
  const used = new Map();
  const pool = scored.slice();
  while (pool.length) {
    let best = 0, bestScore = -Infinity;
    for (let k = 0; k < pool.length && k < 60; k++) {
      const adj = pool[k].s - (used.get(pool[k].j.portal) || 0) * SAME_SOURCE_COST;
      if (adj > bestScore) { bestScore = adj; best = k; }
    }
    const [pick] = pool.splice(best, 1);
    used.set(pick.j.portal, (used.get(pick.j.portal) || 0) + 1);
    out.push(pick.j);
  }
  return out;
}
