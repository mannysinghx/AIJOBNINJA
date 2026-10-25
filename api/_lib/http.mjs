// Response helpers shared by the web API functions.

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

// cacheSeconds > 0 lets Vercel's CDN serve the same answer to everyone for
// that long (job listings are public, identical for every visitor, and
// carry nothing personal), then refresh it in the background.
export function json(data, { status = 200, cacheSeconds = 0 } = {}) {
  const headers = { ...BASE_HEADERS };
  headers['Cache-Control'] = cacheSeconds > 0
    ? `public, max-age=60, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 6}`
    : 'no-store';
  return new Response(JSON.stringify(data), { status, headers });
}

export function fail(message, status = 400) {
  return json({ error: String(message).slice(0, 300) }, { status });
}

const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// One search form, read the same way by every source.
export function searchParams(url) {
  const p = url.searchParams;
  const days = Number(p.get('days'));
  const remote = p.get('remote');
  return {
    q: clip(p.get('q'), 120),
    location: clip(p.get('location'), 80),
    days: [1, 3, 7, 14, 30].includes(days) ? days : null,
    remote: ['remote', 'hybrid', 'onsite'].includes(remote) ? remote : null,
    sort: p.get('sort') === 'date' ? 'date' : 'relevance',
    page: Math.min(Math.max(Number(p.get('page')) || 1, 1), 20),
  };
}

export { clip };
