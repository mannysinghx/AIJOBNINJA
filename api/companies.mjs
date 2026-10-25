// GET /api/companies -> every open posting on the company boards in
// api/_lib/companies.json, without descriptions, as compact rows
// [boardIndex, title, location, date, url] (the browser expands them). The answer is the same for
// every visitor, so Vercel's CDN caches it for an hour; filtering by keyword
// and location happens in the browser.
import { BOARDS, fetchBoard, toListing, pool } from './_lib/companies.mjs';
import { json } from './_lib/http.mjs';

export async function GET() {
  const results = await pool(BOARDS, 12, async (board) => (await fetchBoard(board)).map((j) => toListing(board, j)));
  const rows = [];
  const boards = BOARDS.map((b, i) => {
    const r = results[i];
    if (r.ok) for (const j of r.value) rows.push([i, j.title, j.location || '', j.date || '', j.url]);
    return { slug: b.slug, name: b.name, provider: b.provider, status: r.ok ? 'ok' : 'error', count: r.ok ? r.value.length : 0, error: r.ok ? undefined : r.error.slice(0, 160) };
  });
  return json({ fetchedAt: new Date().toISOString(), boards, rows }, { cacheSeconds: 3600 });
}
