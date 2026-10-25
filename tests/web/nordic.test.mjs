// Offline tests for api/_lib/nordic.mjs, the serverless port of the
// jobindex / jobnet / jobdanmark / freehire CLIs plus the web UI mapping in
// modules/job-finder/webui/lib/portals.ts.
//
// globalThis.fetch is replaced per test and restored afterwards; nothing
// touches the network. Fixtures in tests/web/fixtures/nordic/ are fictional
// postings in the shape of real responses (the jobindex detail pages and the
// jobdanmark rendered page are the CLI tests' recorded pages). Dates in them
// are 2020-... (always outside a days window) or 2099-... (always inside), so
// nothing here depends on today's date.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NORDIC_SOURCES,
  searchNordic,
  detailNordic,
  trimPageChrome,
  isPublicRedirectTarget,
  _internals,
} from '../../api/_lib/nordic.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nordic');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');

const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const json = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const redirect = (location, status = 302) => new Response(null, { status, headers: { Location: location } });

/**
 * Runs fn with fetch answered by `responder(url, init, callIndex)` (a
 * Response, or an array consumed in order). Retry sleeps are instant.
 * Returns the recorded calls.
 */
async function withFetch(responder, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  const realSleep = _internals.sleep;
  const sleeps = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const r = Array.isArray(responder) ? responder[calls.length - 1] : responder(call.url, init, calls.length - 1);
    if (!r) throw new Error(`unexpected fetch #${calls.length}: ${call.url}`);
    return typeof r === 'function' ? r() : r;
  };
  _internals.sleep = async (ms) => { sleeps.push(ms); };
  try {
    await fn(calls, sleeps);
  } finally {
    globalThis.fetch = realFetch;
    _internals.sleep = realSleep;
  }
  return calls;
}

const header = (call, name) => new Headers(call.init.headers).get(name);
const base = { q: 'data engineer', location: '', days: null, remote: null, sort: 'relevance', page: 1 };

test('exports the four sources', () => {
  assert.deepEqual(NORDIC_SOURCES, ['jobindex', 'jobnet', 'jobdanmark', 'freehire']);
});

test('an unknown source is rejected before any request', async () => {
  await withFetch([], async (calls) => {
    await assert.rejects(searchNordic('linkedin', base), /Unknown source/);
    await assert.rejects(detailNordic('__proto__', 'x'), /Unknown source/);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------- jobindex

test('jobindex search: query + location, jobage, sort and page map like portals.ts', async () => {
  await withFetch(() => html(fixture('jobindex-search.html')), async (calls) => {
    await searchNordic('jobindex', { ...base, location: 'København', days: 7, sort: 'date', page: 2 });
    await searchNordic('jobindex', base);
    assert.equal(calls[0].url, 'https://www.jobindex.dk/jobsoegning?q=data+engineer+K%C3%B8benhavn&page=2&jobage=7&sort=date');
    assert.equal(calls[1].url, 'https://www.jobindex.dk/jobsoegning?q=data+engineer&page=1&jobage=9999&sort=score');
    assert.equal(header(calls[0], 'user-agent'), 'Mozilla/5.0 (compatible; jobindex-cli/1.0)');
    assert.equal(header(calls[0], 'accept-language'), 'da,en;q=0.9');
  });
});

test('jobindex search: Stash results normalize into the Job shape', async () => {
  await withFetch(() => html(fixture('jobindex-search.html')), async () => {
    const { jobs, total } = await searchNordic('jobindex', base);
    assert.equal(total, 435);
    assert.deepEqual(jobs, [
      {
        key: 'jobindex:h1689961', portal: 'jobindex', id: 'h1689961', title: 'Data Engineer', company: 'Acme A/S',
        location: 'København', date: '2099-01-10', deadline: '2099-02-11', url: 'https://www.jobindex.dk/jobannonce/h1689961',
        applyUrl: null, snippet: null, tags: [], workMode: null,
      },
      {
        key: 'jobindex:r14058023', portal: 'jobindex', id: 'r14058023', title: 'Senior Data Engineer "Platform" {team}',
        company: 'Example Co', location: 'Aarhus', date: '2020-01-02', deadline: null,
        url: 'https://www.jobindex.dk/jobannonce/r14058023', applyUrl: null, snippet: null, tags: [], workMode: null,
      },
      {
        key: 'jobindex:h1700001', portal: 'jobindex', id: 'h1700001', title: 'Analytics Engineer', company: 'Beta ApS',
        location: null, date: null, deadline: '2099-03-01', url: 'https://www.jobindex.dk/jobannonce/h1700001',
        applyUrl: null, snippet: null, tags: [], workMode: null,
      },
    ]);
  });
});

test('jobindex search: days filter drops older postings, keeps undated ones', async () => {
  await withFetch(() => html(fixture('jobindex-search.html')), async () => {
    const { jobs, total } = await searchNordic('jobindex', { ...base, days: 7 });
    assert.deepEqual(jobs.map((j) => j.id), ['h1689961', 'h1700001']);
    assert.equal(total, 435, 'total stays the portal hit count');
  });
});

test('jobindex search: no keyword is a skip, with no request', async () => {
  await withFetch([], async (calls) => {
    await assert.rejects(searchNordic('jobindex', { ...base, q: '  ' }), (e) => e.message === 'Needs a keyword' && e.skip === true);
    assert.equal(calls.length, 0);
  });
});

test('jobindex search: a page without the Stash blob fails with a message', async () => {
  await withFetch(() => html('<html><body>no data</body></html>'), async () => {
    await assert.rejects(searchNordic('jobindex', base), /Could not locate Stash blob/);
  });
});

test('jobindex detail: native jd-* page', async () => {
  await withFetch(() => html(fixture('jobindex-detail-native.html')), async (calls) => {
    const d = await detailNordic('jobindex', 'h1690934', 'Udvikler til Camunda/AWS');
    assert.equal(calls[0].url, 'https://www.jobindex.dk/jobannonce/h1690934');
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(d.key, 'jobindex:h1690934');
    assert.equal(d.title, 'Udvikler til Camunda/AWS');
    assert.equal(d.company, 'VELLIV');
    assert.equal(d.location, 'Ballerup');
    assert.equal(d.date, '2026-08-12');
    assert.equal(d.deadline, '2026-09-13');
    assert.equal(d.employmentType, 'Fast');
    assert.equal(d.url, 'https://www.jobindex.dk/jobannonce/h1690934');
    assert.equal(d.applyUrl, 'https://www.jobindex.dk/c?t=h1690934&ctx=w');
    assert.equal(d.description.pageText, true);
    assert.match(d.description.text, /Camunda, AWS og automatisering/);
  });
});

test('jobindex detail: external ATS page goes through trimPageChrome', async () => {
  const title = 'C#-udvikler til kritiske analyseløsninger i elnettet';
  await withFetch(() => html(fixture('jobindex-detail-external.html')), async () => {
    const d = await detailNordic('jobindex', 'h1690445', title);
    assert.equal(d.company, null, 'the ATS brand is never the company');
    assert.equal(d.location, 'Fredericia');
    assert.equal(d.deadline, '2026-09-21');
    assert.equal(d.url, 'https://www.jobindex.dk/jobannonce/h1690445');
    assert.equal(
      d.description.text,
      [
        title,
        'Vil du være med til at udvikle og drifte de systemer, der understøtter udbygningen af Danmarks kommende elnet? Vi arbejder i krydsfeltet mellem IT og energi.',
        'Du bliver en del af et team på otte udviklere, der bygger analyseværktøjer i C# og .NET til planlægning af elnettet.',
        'Workplace',
        'Fredericia',
        'Application due',
        '21-09-2026',
      ].join('\n'),
    );
    assert.doesNotMatch(d.description.text, /cookies|padding-bottom|primært indhold/);
  });
});

test('jobindex detail: the title hint falls back to the page title', async () => {
  await withFetch(() => html(fixture('jobindex-detail-external.html')), async () => {
    const d = await detailNordic('jobindex', 'h1690445');
    assert.match(d.description.text, /^C#-udvikler/);
  });
});

test('jobindex detail: id validation and URL forms', async () => {
  await withFetch(() => html(fixture('jobindex-detail-native.html')), async (calls) => {
    for (const bad of ['', '  ', '-h1', 'a b', '../h1', 'h1/../x', 'x'.repeat(301), 'https://evil.example/jobannonce/h1',
      'https://jobindex.dk.evil.example/jobannonce/h1', 'https://www.jobindex.dk/somewhere-else', 'javascript:alert(1)', 42, null]) {
      await assert.rejects(detailNordic('jobindex', bad), /Invalid job id/, `accepted ${bad}`);
    }
    assert.equal(calls.length, 0);
    await detailNordic('jobindex', 'https://www.jobindex.dk/jobannonce/h1690934/udvikler?ctx=w');
    assert.equal(calls[0].url, 'https://www.jobindex.dk/jobannonce/h1690934');
  });
});

test('jobindex detail: 404 is "Job not found"', async () => {
  await withFetch(() => html('gone', 404), async () => {
    await assert.rejects(detailNordic('jobindex', 'h1'), { message: 'Job not found' });
  });
});

test('jobindex detail: follows redirects to a public ATS, refuses private targets', async () => {
  await withFetch([redirect('https://candidate.hr-manager.net/ApplicationInit.aspx?cid=1'), html(fixture('jobindex-detail-external.html'))], async (calls) => {
    const d = await detailNordic('jobindex', 'h1690445', '');
    assert.equal(calls[1].url, 'https://candidate.hr-manager.net/ApplicationInit.aspx?cid=1');
    assert.equal(d.url, 'https://www.jobindex.dk/jobannonce/h1690445', 'url stays the jobannonce page');
  });
  for (const target of ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data', 'http://localhost:3000/', 'file:///etc/passwd', 'http://[::1]/', 'http://10.0.0.5/']) {
    await withFetch([redirect(target)], async (calls) => {
      await assert.rejects(detailNordic('jobindex', 'h1'), /non-public address/, target);
      assert.equal(calls.length, 1);
    });
  }
});

test('redirect target check', () => {
  assert.equal(isPublicRedirectTarget('https://plantorama.easycruit.com/vacancy/1'), true);
  assert.equal(isPublicRedirectTarget('https://www.jobindex.dk/x'), true);
  for (const bad of ['http://192.168.1.1/', 'http://172.16.0.1/', 'http://0x7f000001/', 'http://2130706433/', 'https://user:pw@example.com/', 'https://example.com:8443/', 'http://intranet/', 'http://db.internal/']) {
    assert.equal(isPublicRedirectTarget(bad), false, bad);
  }
});

test('retry: 429/5xx back off and retry, as the CLIs do', async () => {
  await withFetch([html('busy', 503), html('slow', 429), html(fixture('jobindex-search.html'))], async (calls, sleeps) => {
    const { jobs } = await searchNordic('jobindex', base);
    assert.equal(jobs.length, 3);
    assert.equal(calls.length, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[0] >= 500 && sleeps[0] < 1000 && sleeps[1] >= 1000 && sleeps[1] < 1500, String(sleeps));
  });
  await withFetch(() => html('down', 502), async (calls) => {
    await assert.rejects(searchNordic('jobindex', base), /API request failed: 502/);
    assert.equal(calls.length, 7, 'one try plus six retries');
  });
});

test('a network failure surfaces as a short message', async () => {
  await withFetch(() => () => { throw Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND www.jobindex.dk') }); }, async () => {
    await assert.rejects(searchNordic('jobindex', base), { message: 'getaddrinfo ENOTFOUND www.jobindex.dk' });
  });
});

// ---------------------------------------------------------------- jobnet

test('jobnet search: text vs 4-digit postal code mapping, fixed per-page and order', async () => {
  await withFetch(() => json(fixture('jobnet-search.json')), async (calls) => {
    await searchNordic('jobnet', { ...base, location: 'København', page: 3, sort: 'date' });
    await searchNordic('jobnet', { ...base, location: '2100' });
    await searchNordic('jobnet', { ...base, q: '', location: '' });
    assert.equal(calls[0].url, 'https://jobnet.dk/bff/FindJob/Search?resultsPerPage=20&pageNumber=3&orderType=PublicationDate&searchString=data+engineer+K%C3%B8benhavn');
    assert.equal(calls[1].url, 'https://jobnet.dk/bff/FindJob/Search?resultsPerPage=20&pageNumber=1&orderType=PublicationDate&searchString=data+engineer&postalCode=2100&kmRadius=50');
    assert.equal(calls[2].url, 'https://jobnet.dk/bff/FindJob/Search?resultsPerPage=20&pageNumber=1&orderType=PublicationDate');
    assert.equal(header(calls[0], 'user-agent'), 'Mozilla/5.0 (compatible; jobnet-cli/1.0)');
    assert.equal(header(calls[0], 'x-csrf'), '1');
  });
});

test('jobnet search: normalization into the Job shape', async () => {
  await withFetch(() => json(fixture('jobnet-search.json')), async () => {
    const { jobs, total } = await searchNordic('jobnet', base);
    assert.equal(total, 110);
    assert.deepEqual(jobs[0], {
      key: 'jobnet:e5a1c2d4-1111-4f00-9a00-000000000001', portal: 'jobnet', id: 'e5a1c2d4-1111-4f00-9a00-000000000001',
      title: 'Data Engineer', company: 'Acme A/S', location: 'København Ø', date: '2099-01-02', deadline: '2099-02-01',
      url: 'https://jobnet.dk/find-job/e5a1c2d4-1111-4f00-9a00-000000000001', applyUrl: 'https://careers.acme.example/jobs/1',
      snippet: null, tags: ['Dataingeniør'], workMode: null,
    });
    // 1900-01-01 deadline sentinel -> null; a non-http jobAdUrl is never an applyUrl.
    assert.equal(jobs[1].deadline, null);
    assert.equal(jobs[1].applyUrl, null);
    assert.equal(jobs[1].location, 'Aarhus');
    assert.deepEqual(jobs[1].tags, ['Part-time']);
    assert.equal(jobs[2].date, null);
    assert.equal(jobs[2].location, null);
  });
});

test('jobnet search: days filter', async () => {
  await withFetch(() => json(fixture('jobnet-search.json')), async () => {
    const { jobs } = await searchNordic('jobnet', { ...base, days: 30 });
    assert.deepEqual(jobs.map((j) => j.id.slice(-1)), ['1', '3']);
  });
});

test('jobnet search: an unexpected body is an error, not an empty list', async () => {
  await withFetch(() => json({ error: 'nope' }), async () => {
    await assert.rejects(searchNordic('jobnet', base), /unexpected response/);
  });
});

test('jobnet detail: portals.ts mapping, verbatim', async () => {
  const id = 'e5a1c2d4-1111-4f00-9a00-000000000001';
  await withFetch(() => json(fixture('jobnet-detail.json')), async (calls) => {
    const d = await detailNordic('jobnet', id, 'Data Engineer');
    assert.equal(calls[0].url, `https://jobnet.dk/bff/FindJob/JobAdDetails/${id}?incrementViews=false`);
    assert.equal(d.title, 'Data Engineer');
    assert.equal(d.key, `jobnet:${id}`);
    assert.deepEqual(d.description, { html: '<p>Vi søger en <strong>data engineer</strong>.</p><ul><li>Python</li></ul>' });
    // portals.ts reads these from fields the detail JSON lacks; the UI fills
    // them from the search row, so the port reproduces the nulls exactly.
    assert.equal(d.company, null);
    assert.equal(d.location, null);
    assert.equal(d.url, '');
    assert.equal(d.employmentType, null);
  });
});

test('jobnet detail: 404 falls back to the search endpoint (external ads)', async () => {
  const id = 'e5a1c2d4-1111-4f00-9a00-000000000001';
  await withFetch([json({}, 404), json(fixture('jobnet-search.json'))], async (calls) => {
    const d = await detailNordic('jobnet', `https://jobnet.dk/find-job/${id}`, '');
    assert.equal(calls[1].url, `https://jobnet.dk/bff/FindJob/Search?searchString=${id}&resultsPerPage=5&pageNumber=1&orderType=PublicationDate`);
    assert.equal(d.title, 'Data Engineer');
    assert.deepEqual(d.description, { html: '<p>Bulky HTML</p>' });
  });
  await withFetch([json({}, 404), json(fixture('jobnet-search.json'))], async () => {
    await assert.rejects(detailNordic('jobnet', 'no-such-ad'), { message: 'Job ad not found' });
  });
});

test('jobnet detail: id validation', async () => {
  await withFetch([], async (calls) => {
    for (const bad of ['a/b', '../x', 'https://evil.example/find-job/abc', 'https://jobnet.dk/other/abc', 'https://jobnet.dk/x?y=/find-job/abc', 'ftp://jobnet.dk/find-job/abc', '-x']) {
      await assert.rejects(detailNordic('jobnet', bad), /Invalid job id/, bad);
    }
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------- jobdanmark

test('jobdanmark search: POST body maps text, zip and municipality', async () => {
  await withFetch(() => json(fixture('jobdanmark-search.json')), async (calls) => {
    await searchNordic('jobdanmark', { ...base, location: 'København', page: 3 });
    await searchNordic('jobdanmark', { ...base, location: '5000' });
    await searchNordic('jobdanmark', { ...base, q: '', location: '' });
    assert.equal(calls[0].url, 'https://jobdanmark.dk/api/jobsearch/search/3');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(header(calls[0], 'content-type'), 'application/json');
    assert.equal(header(calls[0], 'user-agent'), 'Mozilla/5.0 (compatible; jobdanmark-cli/1.0)');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      jobTypes: [],
      filters: [
        { type: 'freetext', value: 'data engineer', displayText: 'data engineer' },
        { type: 'municipality', value: 'København', displayText: 'København' },
      ],
      locationMode: 'Text',
      distance: 50,
    });
    assert.deepEqual(JSON.parse(calls[1].init.body).filters[1], { type: 'zip', value: '5000', displayText: '5000' });
    assert.deepEqual(JSON.parse(calls[2].init.body).filters, []);
  });
});

test('jobdanmark search: normalization into the Job shape', async () => {
  await withFetch(() => json(fixture('jobdanmark-search.json')), async () => {
    const { jobs, total } = await searchNordic('jobdanmark', base);
    assert.equal(total, 61);
    assert.deepEqual(jobs[0], {
      key: 'jobdanmark:softwareudvikler-til-statens-it', portal: 'jobdanmark', id: 'softwareudvikler-til-statens-it',
      title: 'Softwareudvikler', company: 'Statens It', location: 'Ballerup', date: '2099-01-03', deadline: '2099-02-17',
      url: 'https://jobdanmark.dk/job/softwareudvikler-til-statens-it', applyUrl: null, snippet: null, tags: ['fuldtid'], workMode: null,
    });
    assert.equal(jobs[1].location, 'Greve');
    assert.deepEqual(jobs[1].tags, ['fuldtid', 'deltid']);
    assert.equal(jobs[2].location, null, 'a 4-digit street number is not a postcode');
    assert.equal(jobs[2].date, null, 'non-date publishedDate');
  });
});

test('jobdanmark search: days filter', async () => {
  await withFetch(() => json(fixture('jobdanmark-search.json')), async () => {
    const { jobs } = await searchNordic('jobdanmark', { ...base, days: 3 });
    assert.deepEqual(jobs.map((j) => j.id), ['softwareudvikler-til-statens-it', 'udvikler-vejle']);
  });
});

test('jobdanmark detail: JSON-LD page', async () => {
  await withFetch(() => html(fixture('jobdanmark-detail-jsonld.html')), async (calls) => {
    const d = await detailNordic('jobdanmark', 'udvikler', 'Udvikler');
    assert.equal(calls[0].url, 'https://jobdanmark.dk/job/udvikler');
    assert.equal(header(calls[0], 'accept'), 'text/html,application/xhtml+xml');
    assert.equal(d.title, 'Udvikler');
    assert.equal(d.company, 'Acme A/S');
    assert.equal(d.location, 'Odense');
    assert.equal(d.date, '2099-07-13');
    assert.equal(d.deadline, '2099-08-13');
    assert.equal(d.employmentType, 'FULL_TIME, PART_TIME');
    assert.equal(d.url, 'https://jobdanmark.dk/job/udvikler');
    assert.deepEqual(d.description, { text: 'Vi søger en udvikler til R&D.\nSecond para\nline two\nPython & Go\nSQL' });
  });
});

test('jobdanmark detail: rendered-HTML fallback (node-html-parser behaviour)', async () => {
  await withFetch(() => html(fixture('jobdanmark-detail-rendered.html')), async () => {
    const d = await detailNordic('jobdanmark', 'journalistisk-udvikler');
    assert.equal(d.title, 'Journalistisk udvikler søges');
    assert.equal(d.company, 'JFM');
    assert.equal(d.location, 'Odense C');
    assert.equal(d.date, '2026-07-03');
    assert.equal(d.deadline, null, 'Løbende is a rolling deadline');
    assert.equal(d.employmentType, 'Fuldtid', 'the malformed </ li > is stripped');
    assert.equal(d.applyUrl, 'https://jfm.career.emply.com/da/apply/example?a=1&b=2');
    assert.deepEqual(d.description, {
      text: 'Hvad nu hvis du med få klik kunne undersøge dit lokalområde?\nidentificere relevante datasæt og muligheder',
    });
  });
});

test('jobdanmark detail: 404 and a rendered not-found page are "Job not found"', async () => {
  await withFetch(() => html('', 404), async () => {
    await assert.rejects(detailNordic('jobdanmark', 'gone'), { message: 'Job not found' });
  });
  await withFetch(() => html('<html><head><title>404 | Jobdanmark</title></head><body></body></html>'), async () => {
    await assert.rejects(detailNordic('jobdanmark', 'gone'), { message: 'Job not found' });
  });
  await withFetch(() => html('<html><head><title>Jobdanmark</title></head><body></body></html>'), async () => {
    await assert.rejects(detailNordic('jobdanmark', 'broken'), /Failed to parse job page HTML/);
  });
});

test('jobdanmark detail: slug validation and URL forms', async () => {
  await withFetch(() => html(fixture('jobdanmark-detail-jsonld.html')), async (calls) => {
    for (const bad of ['..', 'a b', 'https://evil.example/job/..', '/job/"x"', 'x/y', '-x']) {
      await assert.rejects(detailNordic('jobdanmark', bad), /Invalid job id/, bad);
    }
    assert.equal(calls.length, 0);
    await detailNordic('jobdanmark', 'https://jobdanmark.dk/job/data-engineer?utm=x#top');
    // Any /job/<slug> input is reduced to the slug and rebuilt on jobdanmark.dk (CLI behaviour).
    await detailNordic('jobdanmark', 'https://elsewhere.example/job/data-engineer');
    assert.deepEqual(calls.map((c) => c.url), ['https://jobdanmark.dk/job/data-engineer', 'https://jobdanmark.dk/job/data-engineer']);
  });
});

// ---------------------------------------------------------------- freehire

test('freehire search: query, page, days, remote and country/city mapping', async () => {
  await withFetch(() => json(fixture('freehire-search.json')), async (calls) => {
    await searchNordic('freehire', { ...base, q: 'python', location: 'dk', days: 14, remote: 'remote', page: 2 });
    await searchNordic('freehire', { ...base, q: 'python', location: 'Copenhagen, Aarhus' });
    await searchNordic('freehire', { ...base, q: '', location: '' });
    assert.equal(calls[0].url, 'https://freehire.me/api/v1/agent/jobs/search?q=python&limit=25&offset=25&description_format=text&posted_within_days=14&work_mode=remote&countries=DK');
    assert.equal(calls[1].url, 'https://freehire.me/api/v1/agent/jobs/search?q=python&limit=25&offset=0&description_format=text&cities=Copenhagen&cities=Aarhus');
    assert.equal(calls[2].url, 'https://freehire.me/api/v1/agent/jobs/search?limit=25&offset=0&description_format=text');
    assert.equal(header(calls[0], 'user-agent'), 'mannysinghx/AIJOBNINJA/1.0 (freehire-search)');
    assert.equal(header(calls[0], 'accept'), 'application/json');
  });
});

test('freehire search: normalization into the Job shape', async () => {
  await withFetch(() => json(fixture('freehire-search.json')), async () => {
    const { jobs, total } = await searchNordic('freehire', { ...base, q: 'python' });
    assert.equal(total, 30);
    assert.deepEqual(jobs[0], {
      key: 'freehire:backend-engineer-acme-ab12cd34', portal: 'freehire', id: 'backend-engineer-acme-ab12cd34',
      title: 'Python & Data Engineer', company: 'Acme', location: 'Copenhagen, Denmark', date: '2099-07-06', deadline: null,
      url: 'https://boards.greenhouse.io/acme/jobs/1', applyUrl: null,
      snippet: 'About Acme builds data tools. You will write Python.',
      tags: ['python', 'sql', 'airflow', 'dbt', 'spark', 'kafka'], workMode: 'hybrid',
    });
    assert.equal(jobs[1].title, '(untitled)');
    assert.equal(jobs[1].company, null);
    assert.equal(jobs[1].snippet, null);
  });
});

test('freehire search: days filter applies on top of posted_within_days', async () => {
  await withFetch(() => json(fixture('freehire-search.json')), async () => {
    const { jobs } = await searchNordic('freehire', { ...base, days: 1 });
    assert.deepEqual(jobs.map((j) => j.id), ['backend-engineer-acme-ab12cd34']);
  });
});

test('freehire detail: cleaned description as markdown, skills, work mode, employment type', async () => {
  await withFetch(() => json(fixture('freehire-detail.json')), async (calls) => {
    const d = await detailNordic('freehire', 'https://freehire.me/jobs/backend-engineer-acme-ab12cd34/');
    assert.equal(calls[0].url, 'https://freehire.me/api/v1/jobs/backend-engineer-acme-ab12cd34');
    assert.equal(d.title, 'Python & Data Engineer');
    assert.equal(d.company, 'Acme');
    assert.equal(d.date, '2099-07-06');
    assert.equal(d.tags.length, 7);
    assert.equal(d.workMode, 'hybrid');
    assert.equal(d.employmentType, 'full_time');
    assert.deepEqual(d.description, { markdown: 'Build APIs\nShip & iterate' });
  });
});

test('freehire detail: 404, API error bodies and slug validation', async () => {
  await withFetch(() => json({}, 404), async () => {
    await assert.rejects(detailNordic('freehire', 'gone-slug'), { message: 'job not found' });
  });
  await withFetch(() => json({ error: 'limit must be <= 100' }, 400), async () => {
    await assert.rejects(searchNordic('freehire', base), { message: 'limit must be <= 100' });
  });
  await withFetch([], async (calls) => {
    for (const bad of ['https://freehire.me.evil.io/jobs/x', 'https://freehire.me@evil.io/jobs/x', 'https://boards.greenhouse.io/jobs/1', 'bad_slug!', 'a/b', '-x']) {
      await assert.rejects(detailNordic('freehire', bad), /Invalid job id/, bad);
    }
    assert.equal(calls.length, 0);
  });
});

test('freehire: a Retry-After past the call budget fails at once', async () => {
  await withFetch(() => json({}, 429, { 'Retry-After': '60' }), async (calls, sleeps) => {
    await assert.rejects(searchNordic('freehire', base), /freehire API request failed: 429/);
    assert.equal(calls.length, 1);
    assert.equal(sleeps.length, 0);
  });
  await withFetch([json({}, 503, { 'Retry-After': '2' }), json(fixture('freehire-search.json'))], async (calls, sleeps) => {
    await searchNordic('freehire', base);
    assert.equal(calls.length, 2);
    assert.ok(sleeps[0] >= 2000, 'waits at least Retry-After');
  });
});

// ---------------------------------------------------------------- shared

test('search params are cleaned like server.ts parseSearch', async () => {
  await withFetch(() => json(fixture('jobnet-search.json')), async (calls) => {
    await searchNordic('jobnet', { q: `a\u0000b${'x'.repeat(200)}`, location: '  ', days: 5, remote: 'mars', sort: 'nope', page: 99 });
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('searchString'), `a b${'x'.repeat(117)}`);
    assert.equal(u.searchParams.get('pageNumber'), '20');
  });
});

test('trimPageChrome matches the web UI cleanup', () => {
  const long = 'This paragraph is the actual job advert and it is comfortably longer than sixty characters.';
  const page = ['Menu', 'Cookie settings', 'Senior Data Engineer', long, long + ' Again.', 'Contact: jobs desk', ...Array.from({ length: 12 }, (_, i) => `Footer link ${i}`), '© Example'].join('\n');
  assert.equal(trimPageChrome(page, 'Senior Data Engineer'), ['Senior Data Engineer', long, long + ' Again.', 'Contact: jobs desk'].join('\n'));
  assert.equal(trimPageChrome('short &amp; sweet', null), 'short & sweet');
});
