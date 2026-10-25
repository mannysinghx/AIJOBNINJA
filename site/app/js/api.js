// Client for the site's own job-search functions under /api. Job listings are
// public data; nothing personal is sent here.

export const SOURCES = [
  { id: 'jobindex', name: 'Jobindex', region: 'Denmark' },
  { id: 'jobnet', name: 'Jobnet', region: 'Denmark' },
  { id: 'jobdanmark', name: 'Jobdanmark', region: 'Denmark' },
  { id: 'freehire', name: 'freehire', region: 'Global' },
  { id: 'company', name: 'Company boards', region: '80+ tech companies' },
];
export const sourceName = (id) => SOURCES.find((s) => s.id === id)?.name ?? id;

async function getJson(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function searchSource(source, params) {
  const qs = new URLSearchParams({ source, ...params });
  return getJson(`/api/search?${qs}`);
}

// The company boards come back as one cached list for everyone; it is
// fetched once per visit and filtered here.
let companies = null;
export function loadCompanies() {
  companies ??= getJson('/api/companies').then((d) => {
    const jobs = d.rows.map(([b, title, location, date, url]) => {
      const board = d.boards[b];
      return {
        key: `company:${board.slug}:${url}`, portal: 'company', board: board.slug, id: url,
        title, company: board.name, location: location || null, date: date || null, deadline: null,
        url, applyUrl: null, snippet: null, tags: [board.provider], workMode: null,
      };
    });
    return { jobs, boards: d.boards, fetchedAt: d.fetchedAt };
  }).catch((e) => { companies = null; throw e; });
  return companies;
}

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9+#]+/).filter((w) => w.length > 1);

export async function searchCompanies({ q, location, days }) {
  const { jobs, boards } = await loadCompanies();
  const qw = words(q);
  const lw = words(location);
  const since = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : null;
  const hits = [];
  for (const j of jobs) {
    if (since && j.date && j.date < since) continue;
    const title = words(j.title).join(' ');
    const hay = `${title} ${words(j.company).join(' ')}`;
    if (qw.length && !qw.every((w) => hay.includes(w))) continue;
    if (lw.length) {
      const loc = words(j.location).join(' ');
      if (!lw.some((w) => loc.includes(w))) continue;
    }
    // Title hits rank above company-name hits; newer above older.
    const score = qw.filter((w) => title.includes(w)).length * 10 + (j.date ? Number(j.date.replaceAll('-', '')) / 1e8 : 0);
    hits.push({ j, score });
  }
  hits.sort((a, b) => b.score - a.score);
  const ok = boards.filter((b) => b.status === 'ok').length;
  return { status: 'ok', total: hits.length, jobs: hits.slice(0, 60).map((x) => x.j), note: `${ok} of ${boards.length} company boards` };
}

export function jobDetail(job) {
  if (job.portal === 'company') {
    return getJson(`/api/posting?${new URLSearchParams({ board: job.board, url: job.url })}`);
  }
  return getJson(`/api/detail?${new URLSearchParams({ source: job.portal, id: job.id, title: job.title || '' })}`);
}
