// GET /api/detail?source=<nordic source>&id=<posting id>&title=<title hint>
import { NORDIC_SOURCES, detailNordic } from './_lib/nordic.mjs';
import { json, fail, clip } from './_lib/http.mjs';
import { renderDescription, descriptionText } from './_lib/render.mjs';

export async function GET(request) {
  const u = new URL(request.url);
  const source = u.searchParams.get('source') || '';
  const id = (u.searchParams.get('id') || '').trim();
  if (!NORDIC_SOURCES.includes(source) || !id || id.length > 300 || id.startsWith('-')) return fail('Unknown posting');
  try {
    const d = await detailNordic(source, id, clip(u.searchParams.get('title'), 300));
    const { description, ...rest } = d;
    return json({ ...rest, key: `${source}:${id}`, portal: source, id, descriptionHtml: renderDescription(description), descriptionText: descriptionText(description) }, { cacheSeconds: 3600 });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Could not load the posting', 502);
  }
}
