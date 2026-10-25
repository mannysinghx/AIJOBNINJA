// tests/web/rank.test.mjs — how the website orders and filters merged search
// results (site/app/js/rank.js). Offline and deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rankJobs, relevance, workMode, matchesWorkMode } = await import('../../site/app/js/rank.js');

const today = new Date().toISOString().slice(0, 10);
const job = (title, extra = {}) => ({ title, company: 'Acme', location: 'Copenhagen', date: today, portal: 'jobindex', tags: [], ...extra });

test('a title that matches the whole query ranks above a body-only match', () => {
  const jobs = [
    job('PhD scholarship in hybrid wind power plants', { portal: 'jobdanmark', rank: 0 }),
    job('Software Developer', { portal: 'freehire', rank: 3 }),
    job('Senior Business Central Udvikler', { portal: 'jobnet', rank: 0 }),
  ];
  const ranked = rankJobs(jobs, { q: 'software developer' }).map((j) => j.title);
  assert.equal(ranked[0], 'Software Developer');
  assert.equal(ranked.at(-1), 'PhD scholarship in hybrid wind power plants');
});

test('English job words match their Danish counterparts, including compounds', () => {
  assert.ok(relevance(job('Sygeplejerske til akutmodtagelsen'), 'nurse', '') > relevance(job('Lagermedarbejder'), 'nurse', ''));
  assert.ok(relevance(job('Softwareudvikler til fintech'), 'developer', '') > relevance(job('Bogholder'), 'developer', ''));
});

test('a matching location adds weight', () => {
  assert.ok(relevance(job('Data Engineer', { location: 'Aarhus N' }), 'data engineer', 'Aarhus') > relevance(job('Data Engineer', { location: 'Odense' }), 'data engineer', 'Aarhus'));
});

test('one board cannot fill the top of the page with equally relevant results', () => {
  const jobs = [
    ...Array.from({ length: 10 }, (_, i) => job('Software Developer', { portal: 'freehire', company: `F${i}`, rank: i })),
    job('Software Developer', { portal: 'jobindex', company: 'J', rank: 0 }),
  ];
  const top3 = rankJobs(jobs, { q: 'software developer' }).slice(0, 3).map((j) => j.portal);
  assert.ok(top3.includes('jobindex'), top3.join(','));
});

test('newest sorts by date, ignoring relevance', () => {
  const jobs = [job('Old exact match', { date: '2026-01-01' }), job('Fresh partial', { date: today })];
  assert.deepEqual(rankJobs(jobs, { q: 'old exact match', sort: 'date' }).map((j) => j.title), ['Fresh partial', 'Old exact match']);
});

test('work mode comes from declared data first, then title and location text', () => {
  assert.equal(workMode(job('Engineer', { workMode: 'hybrid' })), 'hybrid');
  assert.equal(workMode(job('Engineer', { location: 'Skive og mulighed for hjemmearbejde' })), 'remote');
  assert.equal(workMode(job('Engineer (Remote, EU)')), 'remote');
  assert.equal(workMode(job('Engineer', { location: 'Hybrid - Copenhagen' })), 'hybrid');
  assert.equal(workMode(job('Engineer')), null);
});

test('the remote filter keeps only remote postings, trusting freehire which filters on the server', () => {
  assert.equal(matchesWorkMode(job('Engineer'), 'remote'), false);
  assert.equal(matchesWorkMode(job('Engineer', { portal: 'freehire' }), 'remote'), true);
  assert.equal(matchesWorkMode(job('Engineer'), ''), true);
  const kept = rankJobs([job('Engineer'), job('Engineer (Remote)')], { q: 'engineer', remote: 'remote' });
  assert.deepEqual(kept.map((j) => j.title), ['Engineer (Remote)']);
});
