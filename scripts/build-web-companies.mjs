#!/usr/bin/env node
// Generates api/_lib/companies.json: the company boards the website searches.
//
//   node scripts/build-web-companies.mjs
//
// Source is templates/portals.example.yml (the same list the CLI scanner
// ships). Only enabled entries that the registry routes to a provider the
// web functions import statically are kept, because Vercel bundles a
// function from its static imports and cannot follow the scanner's
// directory-wide dynamic loading.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from '../lib/yaml-document.mjs';
import { loadProviders, resolveProvider } from '../providers/_registry.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const WEB_PROVIDERS = ['ashby', 'greenhouse', 'lever', 'workable'];

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const cfg = loadYaml(readFileSync(join(ROOT, 'templates', 'portals.example.yml'), 'utf8')) || {};
const providers = await loadProviders(join(ROOT, 'providers'));
const out = [];
const seen = new Set();
for (const entry of cfg.tracked_companies || []) {
  if (entry.enabled === false || !entry.name) continue;
  const hit = resolveProvider(entry, providers);
  const id = hit?.provider?.id;
  if (!WEB_PROVIDERS.includes(id)) continue;
  let slug = slugify(entry.name);
  while (seen.has(slug)) slug += '-2';
  seen.add(slug);
  const row = { slug, name: entry.name, provider: id };
  for (const k of ['careers_url', 'api']) if (entry[k]) row[k] = entry[k];
  out.push(row);
}
out.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(ROOT, 'api', '_lib', 'companies.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${out.length} companies: ${WEB_PROVIDERS.map((p) => `${p} ${out.filter((c) => c.provider === p).length}`).join(', ')}`);
