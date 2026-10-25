// GET /api/posting?board=<slug>&url=<posting url> -> the full description of
// one company-board posting. The posting must belong to a board in
// companies.json, so this can never be pointed at an arbitrary URL.
import { BOARDS, fetchBoard, toListing } from './_lib/companies.mjs';
import { json, fail } from './_lib/http.mjs';
import { renderDescription, descriptionText } from './_lib/render.mjs';

export async function GET(request) {
  const u = new URL(request.url);
  const board = BOARDS.find((b) => b.slug === u.searchParams.get('board'));
  const url = u.searchParams.get('url') || '';
  if (!board || !/^https:\/\//.test(url) || url.length > 2000) return fail('Unknown posting');
  let jobs;
  try { jobs = await fetchBoard(board); } catch (e) { return fail(`Could not reach ${board.name}'s job board`, 502); }
  const job = jobs.find((j) => j.url === url);
  if (!job) return fail('This posting is no longer on the board', 404);
  const description = { text: job.description || '' };
  return json({ ...toListing(board, job), descriptionHtml: renderDescription(description), descriptionText: descriptionText(description) }, { cacheSeconds: 3600 });
}
