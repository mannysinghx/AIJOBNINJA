// GET /api/search?source=<jobindex|jobnet|jobdanmark|freehire>&q=&location=&days=&remote=&sort=&page=
// One source per request, so the browser can show each board as it answers.
import { NORDIC_SOURCES, searchNordic } from './_lib/nordic.mjs';
import { json, fail, searchParams } from './_lib/http.mjs';

export async function GET(request) {
  const u = new URL(request.url);
  const source = u.searchParams.get('source') || '';
  if (!NORDIC_SOURCES.includes(source)) return fail('Unknown source');
  const params = searchParams(u);
  if (!params.q && !params.location) return fail('Type a keyword or a location');
  try {
    const { jobs, total } = await searchNordic(source, params);
    return json({ source, status: 'ok', total, jobs }, { cacheSeconds: 600 });
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : 'Search failed';
    return json({ source, status: e?.skip ? 'skipped' : 'error', message, jobs: [], total: null });
  }
}
