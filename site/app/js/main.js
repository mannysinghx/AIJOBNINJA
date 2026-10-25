// AIJobNinja web app. Plain browser modules, no build step. Personal data
// stays in this browser (store.js); job listings come from /api; AI calls go
// from this browser straight to the provider the visitor chose (ai.js).

import { $, $$, h, icon, logo, relPosted, fmtDate, daysFromToday, cap, toast, copyText, emptyState, md, setHtml } from './ui.js';
import * as store from './store.js';
import { SOURCES, sourceName, searchSource, searchCompanies, jobDetail, loadCompanies } from './api.js';
import { PROVIDERS, provider, activeModel, complete, parseJsonObject, AiError } from './ai.js';
import { evaluationPrompt, cvPrompt, letterPrompt, unsupportedFigures, reportToMarkdown } from './prompts.js';
import { rankJobs } from './rank.js';

const ui = store.read('ui', {});
const state = {
  params: { q: '', location: '', days: '', remote: '', sort: 'relevance' },
  enabled: new Set(ui.sources?.length ? ui.sources : SOURCES.map((s) => s.id)),
  page: 1,
  bySource: {},
  status: {},
  jobs: [],
  seq: 0,
  loading: false,
  selected: null,
  detail: new Map(),
  tab: 'posting',
  trackerFilter: 'All',
  running: new Map(), // job key + task -> AbortController
};

const saveUi = () => store.write('ui', { sources: [...state.enabled] });
const view = () => $('#view');

// ------------------------------------------------------------------ routing
function route() {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, ...rest] = path.split('/');
  return { name: name || 'search', arg: rest.join('/'), query: new URLSearchParams(query || '') };
}

function render() {
  const r = route();
  $$('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.route === r.name || (r.name === 'job' && a.dataset.route === 'tracker')));
  closeDrawer();
  if (r.name === 'tracker') return renderTracker();
  if (r.name === 'profile') return renderProfile();
  if (r.name === 'settings') return renderSettings();
  if (r.name === 'job') return renderJobPage(decodeURIComponent(r.arg));
  return renderSearch(r.query);
}
window.addEventListener('hashchange', render);

function updateCounts() {
  $('#trackedCount').textContent = Object.keys(store.getJobs()).length;
}

function banner() {
  const b = $('#banner');
  if (!store.storageAvailable()) {
    b.textContent = 'This browser is blocking site storage, so your profile and tracker last only until you close this tab.';
    b.hidden = false;
  } else b.hidden = true;
}

// ------------------------------------------------------------------ shared bits
function deadlineBadge(iso) {
  const n = daysFromToday(iso);
  if (n === null) return null;
  if (n < 0) return h('span', { class: 'badge danger' }, 'Deadline passed');
  if (n === 0) return h('span', { class: 'badge danger' }, 'Closes today');
  if (n <= 7) return h('span', { class: 'badge warn' }, `Closes in ${n} day${n === 1 ? '' : 's'}`);
  return h('span', { class: 'badge' }, `Apply by ${fmtDate(iso)}`);
}

function scoreBadge(tracked) {
  const r = tracked?.report;
  if (!r) return null;
  const cls = r.score >= 4 ? 'good' : r.score >= 3.5 ? 'warn' : 'danger';
  return h('span', { class: `badge ${cls}` }, `${Number(r.score).toFixed(1)} · ${r.decision}`);
}

function toggleTrack(job, after) {
  const tracked = store.getJob(job.key);
  if (tracked) {
    if (tracked.report || tracked.cv || tracked.letter) {
      if (!confirm('Remove this job from your tracker? Its evaluation, CV and cover letter will be deleted from this browser.')) return;
    }
    store.deleteJob(job.key);
    toast('Removed from tracker');
  } else {
    const { ok } = store.putJob(slim(job));
    toast(ok ? 'Saved to your tracker' : 'Saved for this session (browser storage is full)');
  }
  updateCounts();
  after?.();
}

const slim = (j) => ({ key: j.key, portal: j.portal, board: j.board, id: j.id, title: j.title, company: j.company, location: j.location, date: j.date, deadline: j.deadline, url: j.url, applyUrl: j.applyUrl, tags: j.tags || [] });

function saveButton(job, after) {
  const saved = !!store.getJob(job.key);
  return h('button', {
    type: 'button', class: `save-btn${saved ? ' saved' : ''}`, 'aria-label': saved ? 'Remove from tracker' : 'Save to tracker', title: saved ? 'Saved' : 'Save',
    onclick: (e) => { e.stopPropagation(); toggleTrack(job, after); },
  }, icon('bookmark'));
}

function jobCard(job, { onOpen, selected, after }) {
  const tracked = store.getJob(job.key);
  const posted = relPosted(job.date);
  const isNew = daysFromToday(job.date) !== null && daysFromToday(job.date) >= -2;
  return h('article', {
    class: `job-card${selected ? ' selected' : ''}`, tabindex: '0', role: 'button', 'data-key': job.key,
    'aria-label': `${job.title} at ${job.company || 'unknown company'}`,
    onclick: onOpen, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } },
  },
    logo(job.company || job.title),
    h('div', {},
      h('h3', {}, job.title),
      h('div', { class: 'company' }, job.company || 'Company not listed'),
      h('div', { class: 'meta' },
        job.location ? h('span', {}, icon('pin'), job.location) : null,
        posted ? h('span', {}, icon('clock'), posted) : null),
      h('div', { class: 'badges' },
        h('span', { class: 'badge source' }, job.portal === 'company' ? cap(job.tags?.[0] || 'Company') : sourceName(job.portal)),
        isNew ? h('span', { class: 'badge new' }, 'New') : null,
        deadlineBadge(job.deadline),
        scoreBadge(tracked),
        tracked && !tracked.report ? h('span', { class: 'badge' }, tracked.status) : null)),
    saveButton(job, after));
}

function skeletons(n) {
  return Array.from({ length: n }, () => h('div', { class: 'skeleton' }, h('div', { class: 'sk l' }), h('div', {}, h('div', { class: 'sk w70' }), h('div', { class: 'sk w40' }), h('div', { class: 'sk w55' }))));
}

function openDrawer(panel) {
  if (!matchMedia('(max-width: 1080px)').matches) return;
  panel.classList.add('open');
  $('#backdrop').hidden = false;
}
function closeDrawer() {
  $$('.detail.open').forEach((el) => el.classList.remove('open'));
  $('#backdrop').hidden = true;
}
$('#backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ------------------------------------------------------------------ search view
function renderSearch(query) {
  for (const k of Object.keys(state.params)) if (query.get(k)) state.params[k] = query.get(k);
  const qInput = h('input', { id: 'q', type: 'search', placeholder: 'Job title, skill or company', maxlength: '120', value: state.params.q, 'aria-label': 'Keywords' });
  const lInput = h('input', { id: 'loc', type: 'text', placeholder: 'City, postal code or country code', maxlength: '80', value: state.params.location, 'aria-label': 'Location' });
  const form = h('form', { class: 'searchbar', role: 'search', autocomplete: 'off', onsubmit: (e) => {
    e.preventDefault();
    state.params.q = qInput.value.trim();
    state.params.location = lInput.value.trim();
    if (!state.params.q && !state.params.location) { qInput.focus(); return toast('Type a keyword or a location'); }
    runSearch(1);
  } },
    h('label', { class: 'sfield' }, icon('search'), qInput),
    h('span', { class: 'divider', 'aria-hidden': 'true' }),
    h('label', { class: 'sfield' }, icon('pin'), lInput),
    h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Search jobs'));

  view().replaceChildren(
    h('section', { class: 'hero' }, h('div', { class: 'hero-inner' },
      h('h1', {}, 'Find your next role'),
      h('p', { class: 'hero-sub' }, 'Nordic job boards and 80+ company career pages in one search. Your profile and tracker never leave this browser.'),
      form,
      h('div', { class: 'chips', id: 'chips' }))),
    h('div', { class: 'layout' },
      h('section', { 'aria-live': 'polite' },
        h('div', { class: 'results-head' }, h('div', {}, h('h2', { id: 'resultsTitle' }), h('p', { class: 'muted', id: 'resultsMeta' }))),
        h('div', { class: 'filterbar', id: 'filters' }),
        h('div', { class: 'job-list', id: 'results' }),
        h('div', { class: 'load-more' }, h('button', { type: 'button', class: 'btn btn-secondary', id: 'loadMore', hidden: true, onclick: () => runSearch(state.page + 1) }, 'Load more'))),
      h('section', { class: 'detail', id: 'detail', 'aria-label': 'Job details' })));
  renderChips();
  renderFilters();
  renderResults();
  renderDetailPanel($('#detail'), state.selected);
  if (hasQuery() && !state.jobs.length && !state.loading) runSearch(1);
}

// Takes whatever is in the search boxes now, so a filter click after typing
// a new query searches the new query, not the last submitted one.
function syncInputs() {
  const q = $('#q'), l = $('#loc');
  if (q) state.params.q = q.value.trim();
  if (l) state.params.location = l.value.trim();
}

function renderFilters() {
  const wrap = $('#filters');
  if (!wrap) return;
  const seg = (key, label, options) => h('div', { class: 'segmented', role: 'group', 'aria-label': label }, options.map(([v, text]) => {
    const on = String(state.params[key] ?? '') === v;
    return h('button', {
      type: 'button', class: on ? 'active' : '', 'aria-pressed': String(on),
      onclick: () => {
        if (on) return;
        state.params[key] = v;
        syncInputs();
        renderFilters();
        if (!hasQuery()) return;
        // Sorting and work mode only reorder or narrow what is already here;
        // the date window changes what the boards return, so it searches again.
        if (key === 'days') runSearch(1);
        else if (key === 'remote' && state.enabled.has('freehire')) runSearch(1);
        else { state.jobs = rankJobs(state.all || state.jobs, state.params); writeHash(); renderResults(); }
      },
    }, text);
  }));
  wrap.replaceChildren(
    seg('days', 'Date posted', [['', 'Any time'], ['1', '24h'], ['7', '7 days'], ['30', '30 days']]),
    seg('sort', 'Sort by', [['relevance', 'Relevance'], ['date', 'Newest']]),
    seg('remote', 'Work mode', [['', 'All'], ['remote', 'Remote'], ['hybrid', 'Hybrid']]));
}

const hasQuery = () => !!(state.params.q || state.params.location);

function renderChips() {
  const wrap = $('#chips');
  if (!wrap) return;
  wrap.replaceChildren(...SOURCES.map((s) => {
    const on = state.enabled.has(s.id);
    const st = state.status[s.id];
    return h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(on), 'data-status': on && st ? st.status : null, title: st?.message || `${s.name} · ${s.region}`,
      onclick: () => {
        if (on && state.enabled.size === 1) return toast('Keep at least one source on');
        on ? state.enabled.delete(s.id) : state.enabled.add(s.id);
        saveUi();
        if (hasQuery()) runSearch(1); else renderChips();
      },
    }, h('span', { class: 'dot' }), s.name, on && st?.status === 'ok' && st.total != null ? h('span', { class: 'count' }, Number(st.total).toLocaleString()) : null);
  }));
}

function writeHash() {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(state.params)) if (v && !(k === 'sort' && v === 'relevance')) qs.set(k, v);
  history.replaceState(null, '', '#/search' + (qs.toString() ? `?${qs}` : ''));
}

const dedupKey = (j) => `${(j.company || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}|${j.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}`;

function merge(page, fresh) {
  const seen = new Map();
  const out = [];
  const add = (j) => {
    const k = dedupKey(j);
    const prev = seen.get(k);
    if (prev) { if (prev.portal !== j.portal) prev.tags = [...new Set([...(prev.tags || []), `Also on ${sourceName(j.portal)}`])]; return; }
    const c = { ...j, tags: [...(j.tags || [])] };
    seen.set(k, c);
    out.push(c);
  };
  if (page > 1) (state.all || []).forEach(add);
  // Keep each board's own position as a tie-breaker for the shared scoring.
  for (const s of SOURCES) (fresh[s.id] || []).forEach((j, i) => add({ ...j, rank: j.rank ?? i + (page - 1) * 25 }));
  state.all = out;
  return rankJobs(out, state.params);
}

async function runSearch(page) {
  const seq = ++state.seq;
  state.page = page;
  state.loading = true;
  if (page === 1) { state.jobs = []; state.all = []; state.selected = null; writeHash(); renderDetailPanel($('#detail'), null); }
  for (const id of state.enabled) state.status[id] = { status: 'loading' };
  renderChips(); renderResults();
  const fresh = {};
  const params = { q: state.params.q, location: state.params.location, days: state.params.days, remote: state.params.remote, sort: state.params.sort, page: String(page) };
  await Promise.all([...state.enabled].map(async (id) => {
    let res;
    try {
      if (id === 'company') res = page === 1 ? await searchCompanies({ q: state.params.q, location: state.params.location, days: Number(state.params.days) || null }) : { status: 'ok', total: state.status.company?.total ?? 0, jobs: [] };
      else res = await searchSource(id, params);
    } catch (e) { res = { status: 'error', message: e.message, jobs: [] }; }
    if (seq !== state.seq) return;
    fresh[id] = res.jobs || [];
    state.status[id] = { status: res.status, total: res.total, message: res.message || res.note, count: (res.jobs || []).length };
    state.jobs = merge(page, fresh);
    renderChips(); renderResults();
  }));
  if (seq !== state.seq) return;
  state.loading = false;
  state.hasMore = [...state.enabled].some((id) => id !== 'company' && state.status[id]?.status === 'ok' && state.status[id]?.count > 0);
  renderChips(); renderResults();
}

function renderResults() {
  const list = $('#results');
  if (!list) return;
  const title = $('#resultsTitle'), meta = $('#resultsMeta');
  if (!hasQuery() && !state.loading) {
    title.textContent = 'Start a search';
    meta.textContent = 'Search every board at once, then save, evaluate and tailor.';
    list.replaceChildren(emptyState('search', 'One search, every board', 'Results are merged and de-duplicated so you read each posting once.',
      h('div', { class: 'suggestions' }, ['Data engineer', 'Product manager', 'Frontend developer', 'UX designer', 'Machine learning'].map((ex) => h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => { state.params.q = ex; renderSearch(new URLSearchParams()); runSearch(1); } }, ex)))));
    $('#loadMore').hidden = true;
    return;
  }
  const what = [state.params.q, state.params.location && `in ${state.params.location}`].filter(Boolean).join(' ');
  const ok = Object.entries(state.status).filter(([id, s]) => state.enabled.has(id) && s.status === 'ok').length;
  title.textContent = state.loading && !state.jobs.length ? 'Searching…' : `${state.jobs.length.toLocaleString()} job${state.jobs.length === 1 ? '' : 's'}`;
  const modeNote = state.params.remote ? ` · ${cap(state.params.remote)} only, judged from each posting's work-mode data or its title and location` : '';
  meta.textContent = state.loading ? `Looking for “${what}”…` : `for “${what}” · ${ok} of ${state.enabled.size} sources answered${modeNote}`;
  const cards = state.jobs.map((j) => jobCard(j, { selected: state.selected?.key === j.key, onOpen: () => selectJob(j), after: renderResults }));
  if (state.loading) cards.push(...skeletons(state.jobs.length ? 2 : 6));
  else if (!state.jobs.length) {
    const errs = Object.entries(state.status).filter(([id, s]) => state.enabled.has(id) && s.status === 'error');
    if (state.all?.length && state.params.remote) cards.push(emptyState('inbox', `No ${state.params.remote} jobs in these results`, `${state.all.length} jobs matched, but none say they are ${state.params.remote}. Choose "All" to see them.`));
    else cards.push(emptyState('inbox', 'No matching jobs', errs.length ? `Some sources failed: ${errs.map(([id, s]) => `${sourceName(id)} (${s.message})`).join('; ')}` : 'Try a broader keyword, another location, or a longer date range.'));
  }
  list.replaceChildren(...cards);
  $('#loadMore').hidden = state.loading || !state.hasMore || !state.jobs.length;
}

function selectJob(job) {
  state.selected = job;
  state.tab = 'posting';
  $$('.job-card').forEach((c) => c.classList.toggle('selected', c.dataset.key === job.key));
  const panel = $('#detail');
  renderDetailPanel(panel, job);
  openDrawer(panel);
  panel.scrollTop = 0;
}

// ------------------------------------------------------------------ job workspace
// Used as the right-hand panel on Search and as a full page under #/job/<key>.
async function ensureDetail(job) {
  const tracked = store.getJob(job.key);
  if (tracked?.posting) return tracked.posting;
  if (state.detail.has(job.key)) return state.detail.get(job.key);
  const d = await jobDetail(job);
  const posting = { html: d.descriptionHtml || '', text: d.descriptionText || '', company: d.company, location: d.location, date: d.date, deadline: d.deadline, applyUrl: d.applyUrl, employmentType: d.employmentType };
  state.detail.set(job.key, posting);
  return posting;
}

function renderDetailPanel(panel, job, { page = false } = {}) {
  if (!panel) return;
  if (!job) {
    panel.classList.remove('open');
    return panel.replaceChildren(h('div', { class: 'detail-empty' }, h('div', {}, icon('briefcase'), h('p', {}, 'Select a job to see the posting, evaluate your fit, and tailor your CV.'))));
  }
  const tracked = store.getJob(job.key);
  const j = { ...job, ...(tracked || {}) };
  const rerender = () => renderDetailPanel(panel, job, { page });
  const tabs = [['posting', 'Posting'], ['evaluation', 'Fit evaluation'], ['cv', 'Tailored CV'], ['letter', 'Cover letter']];
  const body = h('div', { class: 'detail-body' });
  panel.replaceChildren(
    h('div', { class: 'detail-head' },
      h('div', { class: 'detail-top' },
        logo(j.company || j.title),
        h('div', {}, h('h2', {}, j.title), h('div', { class: 'company' }, [j.company, j.location].filter(Boolean).join(' · ') || 'Company not listed')),
        page ? null : h('button', { type: 'button', class: 'icon-btn detail-close', 'aria-label': 'Close', onclick: closeDrawer }, icon('x'))),
      h('div', { class: 'actions' },
        j.url ? h('a', { class: 'btn btn-primary', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), job.portal === 'company' ? 'Open posting' : `View on ${sourceName(job.portal)}`) : null,
        h('button', { type: 'button', class: `btn btn-secondary${tracked ? ' is-on' : ''}`, onclick: () => toggleTrack(job, () => { rerender(); renderResults(); }) }, icon('bookmark'), tracked ? 'Saved' : 'Save'),
        tracked ? statusSelect(tracked, () => { rerender(); renderResults(); }) : null,
        !page && tracked ? h('a', { class: 'btn btn-ghost', href: `#/job/${encodeURIComponent(job.key)}` }, 'Open full page') : null),
      h('div', { class: 'ws-tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', {
        type: 'button', role: 'tab', class: state.tab === id ? 'active' : '', 'aria-selected': String(state.tab === id),
        onclick: () => { state.tab = id; rerender(); },
      }, label)))),
    body);
  if (state.tab === 'evaluation') return renderEvaluationTab(body, job, rerender);
  if (state.tab === 'cv') return renderDocTab(body, job, 'cv', rerender);
  if (state.tab === 'letter') return renderDocTab(body, job, 'letter', rerender);
  return renderPostingTab(body, job);
}

function statusSelect(tracked, after) {
  const sel = h('select', { class: 'status-select', 'aria-label': 'Application status', onclick: (e) => e.stopPropagation(), onchange: () => { store.putJob({ key: tracked.key, status: sel.value }); toast(`Marked ${sel.value}`); after?.(); } },
    store.STATES.map((s) => h('option', { value: s, selected: s === tracked.status ? true : null }, s)));
  return sel;
}

async function renderPostingTab(body, job) {
  body.replaceChildren(h('div', {}, h('div', { class: 'sk w70' }), h('div', { class: 'sk w55' }), h('div', { class: 'sk w40' })));
  try {
    const p = await ensureDetail(job);
    if (state.selected?.key !== job.key && route().name !== 'job') return;
    const facts = [['Posted', fmtDate(job.date || p.date)], ['Deadline', job.deadline || p.deadline ? fmtDate(job.deadline || p.deadline) : 'Not stated'], ['Type', p.employmentType], ['Source', job.portal === 'company' ? `${job.company} careers` : sourceName(job.portal)]].filter(([, v]) => v);
    const prose = setHtml(h('div', { class: 'prose' }), p.html || '<p class="muted">This source did not return a description. Open the posting to read it.</p>');
    body.replaceChildren(
      h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', { class: 'fact' }, h('dt', {}, k), h('dd', {}, v)))),
      h('div', { class: 'callout' }, icon('sparkle'), h('p', {}, 'Use ', h('strong', {}, 'Fit evaluation'), ' to score this job against your CV, then generate a tailored CV and cover letter. Your AI key and CV go only to the AI provider you chose.')),
      prose);
  } catch (e) {
    body.replaceChildren(h('div', { class: 'callout warn' }, icon('warn'), h('p', {}, `Couldn't load the full posting: ${e.message}. Open it on the source site instead.`)));
  }
}

function aiReady() {
  const s = store.getAiSettings();
  const profile = store.getProfile();
  const problems = [];
  if (!profile.cv.trim()) problems.push(h('span', {}, 'Add your CV in ', h('a', { href: '#/profile' }, 'Profile'), '.'));
  const p = provider(s.provider);
  if (!p) problems.push(h('span', {}, 'Choose an AI provider in ', h('a', { href: '#/settings' }, 'AI settings'), '.'));
  else if (!s.keys?.[p.id]) problems.push(h('span', {}, `Add your ${p.name} API key in `, h('a', { href: '#/settings' }, 'AI settings'), '.'));
  return { ok: !problems.length, problems, settings: s, profile, p };
}

function setupNotice(problems) {
  return h('div', { class: 'callout warn' }, icon('warn'), h('div', {}, h('p', {}, h('strong', {}, 'Before using AI: ')), ...problems.map((x) => h('p', {}, x))));
}

function modelLine(settings) {
  const p = provider(settings.provider);
  return p ? `${p.name} · ${activeModel(settings)}` : '';
}

async function runTask(job, task, buildPrompt, rerender, onResult) {
  const k = `${job.key}::${task}`;
  if (state.running.has(k)) return;
  const { ok, settings, profile } = aiReady();
  if (!ok) return rerender();
  const ctrl = new AbortController();
  state.running.set(k, ctrl);
  rerender();
  try {
    if (!store.getJob(job.key)) store.putJob(slim(job));
    const posting = await ensureDetail(job);
    if (!store.getJob(job.key).posting) store.putJob({ key: job.key, posting });
    const { system, user } = buildPrompt(profile, job, posting.text);
    const res = await complete(settings, { system, user, maxTokens: task === 'evaluation' ? 6000 : 4000, signal: ctrl.signal });
    onResult(res, profile);
    updateCounts();
  } catch (e) {
    toast(e instanceof AiError ? e.message : `Something went wrong: ${e.message}`);
  } finally {
    state.running.delete(k);
    rerender();
    renderResults();
  }
}

function renderEvaluationTab(body, job, rerender) {
  const tracked = store.getJob(job.key);
  const r = tracked?.report;
  const busy = state.running.has(`${job.key}::evaluation`);
  const ready = aiReady();
  const go = () => runTask(job, 'evaluation', evaluationPrompt, rerender, (res) => {
    const parsed = parseJsonObject(res.text);
    if (!parsed || typeof parsed.score !== 'number') throw new AiError(`${provider(res.provider)?.name || 'The model'} did not return a readable evaluation. Try again, or pick another model.`);
    parsed.score = Math.max(1, Math.min(5, Math.round(parsed.score * 10) / 10));
    const report = { ...parsed, model: res.model, provider: res.provider, at: new Date().toISOString() };
    const cur = store.getJob(job.key);
    store.putJob({ key: job.key, report, status: cur.status === 'Saved' ? 'Evaluated' : cur.status });
    toast(`Scored ${report.score}/5 · ${report.decision}`);
  });
  const bar = h('div', { class: 'gen-bar' },
    busy ? h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => state.running.get(`${job.key}::evaluation`)?.abort() }, h('span', { class: 'spinner' }), 'Evaluating… Stop')
      : h('button', { type: 'button', class: 'btn btn-primary', disabled: ready.ok ? null : true, onclick: go }, icon('sparkle'), r ? 'Re-evaluate' : 'Evaluate my fit'),
    ready.ok ? h('span', { class: 'muted' }, modelLine(ready.settings)) : null,
    r ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => copyText(reportToMarkdown(job, r), 'Report copied as Markdown') }, icon('copy'), 'Copy report') : null);
  const kids = [bar];
  if (!ready.ok) kids.push(setupNotice(ready.problems));
  if (r) {
    const decisionClass = `decision-${String(r.decision).split(' ')[0]}`;
    kids.push(
      h('div', { class: 'score' },
        h('div', { class: `num ${decisionClass}` }, Number(r.score).toFixed(1), h('small', {}, ' / 5')),
        h('div', { class: 'verdict' }, h('strong', { class: decisionClass }, `${r.decision}. `), r.verdict || '', h('div', { class: 'muted' }, `Confidence: ${r.confidence || '—'} · ${provider(r.provider)?.name || ''} ${r.model || ''} · ${fmtDate(r.at)}`))),
      r.score < 4 ? h('div', { class: 'callout warn' }, icon('warn'), h('p', {}, 'Below 4.0 AIJobNinja recommends against applying unless you have a specific reason. A few well-targeted applications beat many generic ones.')) : null,
      setHtml(h('div', { class: 'prose' }), md(reportToMarkdown(job, r).split('\n').slice(4).join('\n'))));
  } else if (!busy && ready.ok) {
    kids.push(emptyState('sparkle', 'No evaluation yet', 'Get a 1–5 fit score, a requirement-by-requirement match against your CV, honest gaps, red flags and an interview plan.'));
  }
  body.replaceChildren(...kids.filter(Boolean));
}

function renderDocTab(body, job, kind, rerender) {
  const tracked = store.getJob(job.key);
  const doc = tracked?.[kind];
  const busy = state.running.has(`${job.key}::${kind}`);
  const ready = aiReady();
  const label = kind === 'cv' ? 'CV' : 'cover letter';
  const go = () => runTask(job, kind, (profile, j, text) => (kind === 'cv' ? cvPrompt : letterPrompt)(profile, j, text, store.getJob(job.key)?.report), rerender, (res, profile) => {
    const markdown = res.text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '').trim();
    store.putJob({ key: job.key, [kind]: { markdown, model: res.model, provider: res.provider, at: new Date().toISOString(), truncated: res.truncated, unsupported: unsupportedFigures(markdown, profile) } });
    toast(`Your tailored ${label} is ready`);
  });
  const preview = doc ? setHtml(h('div', { class: 'doc-preview print-target', id: `doc-${kind}` }), md(doc.markdown)) : null;
  const bar = h('div', { class: 'gen-bar' },
    busy ? h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => state.running.get(`${job.key}::${kind}`)?.abort() }, h('span', { class: 'spinner' }), 'Writing… Stop')
      : h('button', { type: 'button', class: 'btn btn-primary', disabled: ready.ok ? null : true, onclick: go }, icon(kind === 'cv' ? 'doc' : 'mail'), doc ? `Rewrite ${label}` : `Write tailored ${label}`),
    doc ? h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => window.print() }, icon('print'), 'Print / save PDF') : null,
    doc ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => copyText(doc.markdown, `${cap(label)} copied as Markdown`) }, icon('copy'), 'Copy') : null,
    ready.ok ? h('span', { class: 'muted' }, modelLine(ready.settings)) : null);
  const kids = [bar];
  if (!ready.ok) kids.push(setupNotice(ready.problems));
  if (doc) {
    if (doc.unsupported?.length) kids.push(h('div', { class: 'callout danger' }, icon('warn'), h('p', {}, h('strong', {}, 'Check these figures: '), `${doc.unsupported.join(', ')} do not appear in your CV. Remove any the AI invented before you send this.`)));
    if (doc.truncated) kids.push(h('div', { class: 'callout warn' }, icon('warn'), h('p', {}, 'The model stopped early, so the end may be missing. Rewrite, or pick another model.')));
    kids.push(h('div', { class: 'callout' }, icon('check'), h('p', {}, `Read every line before you send it. Written by ${provider(doc.provider)?.name || ''} ${doc.model || ''} on ${fmtDate(doc.at)}.${kind === 'cv' && !tracked?.report ? ' Tip: run the fit evaluation first so the CV targets the keywords your CV really supports.' : ''}`)), preview);
  } else if (!busy && ready.ok) {
    kids.push(emptyState(kind === 'cv' ? 'doc' : 'mail', `No ${label} yet`, kind === 'cv' ? 'Reorders and reframes your real experience for this posting. It never adds skills or numbers you do not have.' : 'A one-page letter that maps what the posting asks for to proof from your CV.'));
  }
  body.replaceChildren(...kids.filter(Boolean));
}

function renderJobPage(key) {
  const tracked = store.getJob(key);
  if (!tracked) {
    return view().replaceChildren(h('div', { class: 'page' }, emptyState('inbox', 'Job not found', 'It may have been removed from your tracker.', h('div', { class: 'suggestions' }, h('a', { class: 'btn btn-primary', href: '#/tracker' }, 'Back to tracker')))));
  }
  state.selected = tracked;
  const panel = h('section', { class: 'detail', style: null });
  view().replaceChildren(h('div', { class: 'page' }, h('p', {}, h('a', { href: '#/tracker' }, '← Tracker')), panel));
  panel.style.position = 'static';
  panel.style.maxHeight = 'none';
  renderDetailPanel(panel, tracked, { page: true });
}

// ------------------------------------------------------------------ tracker
function renderTracker() {
  const jobs = Object.values(store.getJobs()).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const groups = [['All', () => true], ['Saved', (j) => j.status === 'Saved'], ['Evaluated', (j) => j.status === 'Evaluated'], ['Applied', (j) => ['Applied', 'Responded', 'Assessment'].includes(j.status)], ['Interview', (j) => j.status === 'Interview'], ['Offer', (j) => ['Offer', 'Hired'].includes(j.status)], ['Closed', (j) => ['Rejected', 'Discarded', 'SKIP'].includes(j.status)]];
  const filter = groups.find(([n]) => n === state.trackerFilter)?.[1] || (() => true);
  const shown = jobs.filter(filter);
  const exportBtn = h('button', { type: 'button', class: 'btn btn-secondary', onclick: exportCsv }, 'Export CSV');
  const row = (j) => h('tr', {},
    h('td', {}, h('a', { href: `#/job/${encodeURIComponent(j.key)}` }, h('strong', {}, j.title)), h('div', { class: 'muted' }, [j.company, j.location].filter(Boolean).join(' · '))),
    h('td', {}, statusSelect(j, renderTracker)),
    h('td', {}, scoreBadge(j) || '—'),
    h('td', {}, [j.cv && 'CV', j.letter && 'Letter'].filter(Boolean).join(' · ') || '—'),
    h('td', {}, fmtDate(j.updatedAt)),
    h('td', {}, h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': `Remove ${j.title}`, title: 'Remove',
      onclick: () => { if (confirm(`Remove "${j.title}" from your tracker?`)) { store.deleteJob(j.key); updateCounts(); renderTracker(); } },
    }, icon('trash'))));
  const table = h('div', { class: 'tracker-table' }, h('table', { class: 't' },
    h('thead', {}, h('tr', {}, ['Role', 'Status', 'Score', 'Documents', 'Updated', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, shown.map(row))));
  const stages = h('div', { class: 'pipeline' }, groups.map(([name, fn]) => h('button', {
    type: 'button', class: `stage${state.trackerFilter === name ? ' active' : ''}`, onclick: () => { state.trackerFilter = name; renderTracker(); },
  }, h('div', { class: 'label' }, name), h('div', { class: 'value' }, jobs.filter(fn).length))));
  let content;
  if (!jobs.length) content = emptyState('bookmark', 'Nothing tracked yet', 'Save jobs from Search to evaluate them, tailor your CV and track where each application stands.', h('div', { class: 'suggestions' }, h('a', { class: 'btn btn-primary', href: '#/search' }, 'Find jobs')));
  else if (!shown.length) content = emptyState('inbox', `No jobs in ${state.trackerFilter}`, 'Pick another stage above.');
  else content = table;
  view().replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Tracker'), h('p', { class: 'muted' }, 'Saved jobs, evaluations and application status. Stored only in this browser.')), jobs.length ? exportBtn : null),
    jobs.length ? stages : null,
    content));
}

function download(name, type, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportCsv() {
  const cols = ['title', 'company', 'location', 'status', 'score', 'decision', 'url', 'notes', 'updatedAt'];
  // Prefix formula-leading cells so a spreadsheet never evaluates them.
  const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const rows = Object.values(store.getJobs()).map((j) => ({ ...j, score: j.report?.score ?? '', decision: j.report?.decision ?? '' }));
  download(`aijobninja-tracker-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
}

// ------------------------------------------------------------------ profile
function renderProfile() {
  const p = store.getProfile();
  const f = {};
  const input = (key, label, attrs = {}, hint) => h('label', { class: 'field' }, h('span', {}, label), (f[key] = h('input', { class: 'input', value: p[key], ...attrs })), hint ? h('small', {}, hint) : null);
  const area = (key, label, attrs = {}, hint) => h('label', { class: 'field' }, h('span', {}, label), (f[key] = h('textarea', { class: `textarea${key === 'cv' ? ' cv' : ''}`, ...attrs })), hint ? h('small', {}, hint) : null);
  const fileInput = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/plain,text/markdown', class: 'sr-only', onchange: async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 500_000) return toast('That file is too large for a CV (500 KB max)');
    f.cv.value = await file.text();
    toast('CV loaded. Review it, then save');
  } });
  const save = () => {
    const next = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
    if (!store.saveProfile({ ...store.EMPTY_PROFILE, ...next })) return toast('Could not save: browser storage is full or blocked');
    toast('Profile saved in this browser');
  };
  const backupInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', onchange: async () => {
    try {
      const n = store.importAll(JSON.parse(await backupInput.files[0].text()));
      toast(`Imported ${n} jobs and your profile`);
      updateCounts(); renderProfile();
    } catch (e) { toast(e.message || 'Could not read that file'); }
  } });

  view().replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Profile'), h('p', { class: 'muted' }, 'Everything here is stored only in this browser and is sent only to the AI provider you choose, when you ask for an evaluation or a document.')), h('button', { type: 'button', class: 'btn btn-primary', onclick: save }, 'Save profile')),
    h('div', { class: 'card' },
      h('h2', {}, 'Your CV'),
      h('p', { class: 'muted' }, 'Paste your CV as plain text or Markdown, or load a .md / .txt file. This is the single source of truth: the AI may reorder and reword it, never add to it.'),
      h('div', { class: 'stack' },
        area('cv', 'CV', { placeholder: '# Your Name\n\n## Experience\n### Job Title — Company\nCity · 2021–2024\n- What you did, with real numbers\n\n## Education\n...' }),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => fileInput.click() }, icon('doc'), 'Load .md or .txt file'), fileInput, h('span', { class: 'muted' }, 'Have a PDF or Word CV? Open it, select all, copy, and paste here.')))),
    h('div', { class: 'card' },
      h('h2', {}, 'Contact and targeting'),
      h('p', { class: 'muted' }, 'Contact details go into your tailored CV header. Targeting shapes the fit score.'),
      h('div', { class: 'grid2' },
        input('name', 'Full name', { autocomplete: 'name' }),
        input('email', 'Email', { type: 'email', autocomplete: 'email' }),
        input('phone', 'Phone (optional)', { type: 'tel', autocomplete: 'tel' }),
        input('location', 'Location', { placeholder: 'City, Country' }),
        input('links', 'Links (optional)', { placeholder: 'linkedin.com/in/you · github.com/you' }),
        h('label', { class: 'field' }, h('span', {}, 'Output language'), (f.language = h('select', { class: 'select' }, ['English', 'Danish', 'German', 'Swedish', 'Norwegian', 'Dutch', 'French', 'Spanish', 'Portuguese', 'Italian', 'Polish'].map((l) => h('option', { value: l, selected: l === p.language ? true : null }, l)))))),
      h('div', { class: 'stack' },
        area('targetRoles', 'Target roles', { rows: 2, placeholder: 'Senior data engineer, analytics engineer' }),
        area('dealBreakers', 'Deal-breakers', { rows: 2, placeholder: 'No fully on-site roles, no relocation, no defence industry' }),
        area('preferences', 'Anything else the evaluator should know', { rows: 3, placeholder: 'Salary target, visa status, industries you love or avoid, the kind of team you thrive in' }))),
    h('div', { class: 'card' },
      h('h2', {}, 'Backup and privacy'),
      h('p', { class: 'muted' }, 'Your data exists only in this browser on this device. Export a backup to move it or keep it safe. API keys are never included in backups.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => download(`aijobninja-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify(store.exportAll(), null, 2)) }, 'Export backup'),
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => backupInput.click() }, 'Import backup'), backupInput,
        h('button', { type: 'button', class: 'btn btn-danger', onclick: () => { if (confirm('Delete your profile, tracker, evaluations and saved API keys from this browser? This cannot be undone.')) { store.wipeAll(); updateCounts(); toast('All data deleted from this browser'); renderProfile(); } } }, icon('trash'), 'Delete everything')))));
  f.cv.value = p.cv;
  for (const k of ['targetRoles', 'dealBreakers', 'preferences']) f[k].value = p[k];
}

// ------------------------------------------------------------------ AI settings
function renderSettings() {
  const s = store.getAiSettings();
  const sel = provider(s.provider) || PROVIDERS[0];
  const pick = (id) => { store.saveAiSettings({ ...store.getAiSettings(), provider: id }); renderSettings(); };
  const keyInput = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: sel.keyHint, value: s.keys?.[sel.id] || '', 'aria-label': `${sel.name} API key` });
  const modelSelect = h('select', { class: 'select', 'aria-label': 'Model' }, sel.models.map((m) => h('option', { value: m.id, selected: m.id === (s.models?.[sel.id] || sel.models[0].id) ? true : null }, `${m.id} — ${m.price}`)));
  const remember = h('input', { type: 'checkbox', checked: s.remember ? true : null });
  const contributor = h('input', { type: 'checkbox', checked: s.metaContributor ? true : null });
  const note = h('p', { class: 'muted' });
  const showNote = () => { note.textContent = sel.models.find((m) => m.id === modelSelect.value)?.note || ''; };
  modelSelect.addEventListener('change', showNote);
  showNote();
  const persist = () => {
    const cur = store.getAiSettings();
    store.saveAiSettings({ ...cur, provider: sel.id, models: { ...cur.models, [sel.id]: modelSelect.value }, keys: { ...cur.keys, [sel.id]: keyInput.value.trim() }, remember: remember.checked, metaContributor: contributor.checked });
  };
  const testBtn = h('button', { type: 'button', class: 'btn btn-secondary', onclick: async () => {
    persist();
    testBtn.disabled = true;
    testBtn.replaceChildren(h('span', { class: 'spinner' }), 'Testing…');
    try {
      const res = await complete(store.getAiSettings(), { system: 'Reply with the single word OK.', user: 'Connection test.', maxTokens: 400 });
      toast(`${sel.name} works (${res.model})`);
    } catch (e) { toast(e.message); }
    finally { testBtn.disabled = false; testBtn.replaceChildren('Test connection'); }
  } }, 'Test connection');

  view().replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'AI settings'), h('p', { class: 'muted' }, 'Bring your own API key. It is stored in this browser and sent only to the provider you pick, never to AIJobNinja.'))),
    h('div', { class: 'card' },
      h('h2', {}, '1. Choose a provider'),
      h('p', { class: 'muted' }, 'Sorted by price. Each starts on its cheapest model; prices are USD per million input / output tokens. A typical evaluation uses about 6–10K input and 2–4K output tokens.'),
      h('div', { class: 'providers' }, PROVIDERS.map((p) => h('button', { type: 'button', class: `prov${p.id === sel.id ? ' active' : ''}`, onclick: () => pick(p.id) },
        h('strong', {}, p.name), h('span', { class: 'sub' }, p.vendor), h('span', { class: 'price' }, `${p.models.find((m) => !m.contributor)?.id || p.models[0].id} · ${(p.models.find((m) => !m.contributor) || p.models[0]).price}`),
        s.keys?.[p.id] ? h('span', { class: 'has-key' }, '✓ Key added') : null)))),
    h('div', { class: 'card' },
      h('h2', {}, `2. ${sel.name} key and model`),
      h('p', { class: 'muted' }, 'Get a key from ', h('a', { href: sel.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, `${sel.vendor}`), '. Set a monthly spending limit there; you pay the provider directly.'),
      h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', {}, 'API key'), h('div', { class: 'row' }, keyInput, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }, 'Show'))),
        h('label', { class: 'field' }, h('span', {}, 'Model'), modelSelect, note),
        sel.id === 'meta' ? h('label', { class: 'check' }, contributor, 'Allow the Contributor tier: about 10× cheaper, but Meta may use everything I send, including my CV, to train its models.') : null,
        sel.privacy ? h('p', { class: 'muted' }, sel.privacy) : null,
        h('label', { class: 'check' }, remember, 'Remember my keys on this device (otherwise they are forgotten when this tab closes)'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { persist(); toast(`${sel.name} saved`); renderSettings(); } }, 'Save'),
          testBtn,
          s.keys?.[sel.id] ? h('button', { type: 'button', class: 'btn btn-danger', onclick: () => { const cur = store.getAiSettings(); const keys = { ...cur.keys }; delete keys[sel.id]; store.saveAiSettings({ ...cur, keys }); toast('Key removed from this browser'); renderSettings(); } }, 'Remove key') : null))),
    h('div', { class: 'card' },
      h('h2', {}, 'How your key is handled'),
      h('div', { class: 'prose' }, setHtml(h('div'), md([
        '- Requests go **directly from your browser** to the provider. The AIJobNinja server never receives your key, your CV or the AI output.',
        '- Your key is stored in this browser (or only for this tab, if you untick "Remember"). Anyone with access to this browser profile can read it, so do not use a shared computer.',
        '- Use a key with a low spending limit, and delete it at the provider if you stop using AIJobNinja.',
      ].join('\n')))))));
}

// ------------------------------------------------------------------ boot
banner();
updateCounts();
render();
loadCompanies().catch(() => {}); // warm the company list while the visitor types
