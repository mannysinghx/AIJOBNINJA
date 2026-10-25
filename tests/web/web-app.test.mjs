// tests/web/web-app.test.mjs — the website: API input validation, the
// sanitizer, the AI provider table, prompt helpers, and the deployment config
// that ties them together. Offline: nothing here touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const { sanitizeHtml, textToHtml, descriptionText } = await import('../../api/_lib/render.mjs');
const ai = await import('../../site/app/js/ai.js');
const prompts = await import('../../site/app/js/prompts.js');

test('sanitizer keeps formatting and drops scripts, handlers and unsafe links', () => {
  assert.equal(sanitizeHtml('<p onclick="x()">Hi</p><script>alert(1)</script><img src=x onerror=alert(1)>'), '<p>Hi</p>');
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.match(sanitizeHtml('<a href="https://e.com">x</a>'), /rel="noopener noreferrer nofollow"/);
  assert.equal(textToHtml('<b>x</b>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  assert.equal(descriptionText({ html: '<p>One &amp; two</p><ul><li>a</li></ul>' }), 'One & two\n- a');
});

test('posting endpoint only serves postings from known boards', async () => {
  const { GET } = await import('../../api/posting.mjs');
  for (const q of ['board=nope&url=https://a.example/x', 'board=airtable&url=javascript:alert(1)', 'board=airtable&url=' + 'https://a/'.repeat(300)]) {
    const res = await GET(new Request(`http://x/api/posting?${q}`));
    assert.equal(res.status, 400, q.slice(0, 60));
  }
});

test('search and detail endpoints reject unknown sources and empty searches', async () => {
  const search = (await import('../../api/search.mjs')).GET;
  assert.equal((await search(new Request('http://x/api/search?source=linkedin&q=a'))).status, 400);
  assert.equal((await search(new Request('http://x/api/search?source=jobindex'))).status, 400);
  const detail = (await import('../../api/detail.mjs')).GET;
  assert.equal((await detail(new Request('http://x/api/detail?source=jobindex&id=--help'))).status, 400);
  assert.equal((await detail(new Request('http://x/api/detail?source=nope&id=1'))).status, 400);
});

test('company board list is well formed and uses only statically imported providers', () => {
  const boards = JSON.parse(read('api/_lib/companies.json'));
  assert.ok(boards.length >= 50, `expected the generated board list, got ${boards.length}`);
  const imported = [...read('api/_lib/companies.mjs').matchAll(/import (\w+) from '\.\.\/\.\.\/providers\/(\w+)\.mjs'/g)].map((m) => m[2]);
  const slugs = new Set();
  for (const b of boards) {
    assert.ok(imported.includes(b.provider), `${b.slug}: provider ${b.provider} is not imported by api/_lib/companies.mjs`);
    assert.ok(b.careers_url || b.api, `${b.slug}: needs careers_url or api`);
    assert.ok(!slugs.has(b.slug), `duplicate slug ${b.slug}`);
    slugs.add(b.slug);
  }
});

test('every AI provider host is allowed by the site CSP, and nothing else is', () => {
  const config = JSON.parse(read('vercel.json'));
  const csp = config.headers.find((h) => h.source === '/(.*)').headers.find((h) => h.key === 'Content-Security-Policy').value;
  const connect = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src')).split(/\s+/).slice(1);
  const hosts = ai.PROVIDERS.map((p) => (p.kind === 'anthropic' ? 'https://api.anthropic.com' : new URL(p.base).origin));
  for (const h of hosts) assert.ok(connect.includes(h), `CSP connect-src is missing ${h}`);
  assert.deepEqual(connect.filter((c) => c !== "'self'").sort(), [...new Set(hosts)].sort(), 'CSP allows a host no provider uses');
});

test('each provider starts on its cheapest model, and Meta never silently uses the training tier', () => {
  for (const p of ai.PROVIDERS) assert.ok(p.models.length >= 1, p.id);
  const meta = ai.provider('meta');
  assert.equal(ai.activeModel({ provider: 'meta', models: { meta: 'muse-spark-1.3-contributor' }, metaContributor: false }), 'muse-spark-1.3');
  assert.equal(ai.activeModel({ provider: 'meta', models: { meta: 'muse-spark-1.3-contributor' }, metaContributor: true }), 'muse-spark-1.3-contributor');
  assert.ok(meta.models.find((m) => m.contributor)?.note.includes('train'));
  assert.equal(ai.activeModel({ provider: 'qwen', models: {} }), 'qwen3.7-flash');
});

test('model answers are parsed even when wrapped in prose or a code fence', () => {
  assert.deepEqual(ai.parseJsonObject('Sure:\n```json\n{"score": 4.1}\n```'), { score: 4.1 });
  assert.deepEqual(ai.parseJsonObject('noise {"a": {"b": 1}} trailing'), { a: { b: 1 } });
  assert.equal(ai.parseJsonObject('no json here'), null);
});

test('AI calls refuse to run without a provider or key, before any request', async () => {
  await assert.rejects(ai.complete({ provider: '', keys: {} }, { system: 's', user: 'u' }), /Choose an AI provider/);
  await assert.rejects(ai.complete({ provider: 'openai', keys: {} }, { system: 's', user: 'u' }), /Add your OpenAI API key/);
});

test('figures in generated text that are not in the CV are flagged', () => {
  const profile = { cv: 'Saved $2M/year. Scaled from 2 to 15+ models. 99.7% precision.', name: '', email: '', phone: '', location: '', links: '' };
  const out = prompts.unsupportedFigures('Cut losses by $3M/year, scaled 2 to 15+ models at 99.7% precision, grew revenue 40%.', profile);
  assert.ok(out.includes('$3M'), out.join(','));
  assert.ok(out.some((x) => x.startsWith('40')), out.join(','));
  assert.ok(!out.some((x) => x.startsWith('15') || x.startsWith('99.7')), out.join(','));
});

test('prompts fence the posting as untrusted data and carry the never-invent rule', () => {
  const profile = { cv: 'CV TEXT', name: 'A', location: '', targetRoles: '', dealBreakers: '', preferences: '', email: '', phone: '', links: '', language: 'English' };
  const job = { title: 'Engineer', company: 'Acme', url: 'https://acme.example/job' };
  for (const { system, user } of [prompts.evaluationPrompt(profile, job, 'POSTING TEXT'), prompts.cvPrompt(profile, job, 'POSTING TEXT'), prompts.letterPrompt(profile, job, 'POSTING TEXT')]) {
    assert.match(system, /Never invent/);
    assert.match(system, /untrusted data/);
    assert.match(user, /<<<POSTING\nPOSTING TEXT\nPOSTING>>>/);
    assert.match(user, /<<<CV\nCV TEXT\nCV>>>/);
  }
});

test('Jobdanmark gets Danish municipality names for common English spellings', async () => {
  const { searchNordic } = await import('../../api/_lib/nordic.mjs');
  const real = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return new Response(JSON.stringify({ result: [], pagination: { currentPage: 1, totalItems: 0, itemsPrPage: 30, totalPages: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await searchNordic('jobdanmark', { q: 'data', location: 'Copenhagen', days: null, remote: null, sort: 'relevance', page: 1 }).catch(() => {});
  } finally {
    globalThis.fetch = real;
  }
  const muni = sent?.filters?.find((f) => f.type === 'municipality');
  assert.equal(muni?.value, 'København');
});
