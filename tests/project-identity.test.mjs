// tests/project-identity.test.mjs — several files describe this project in a
// one-line blurb (package.json, the plugin manifests, the marketplace entry).
// A description is read by people, not by code, so drift produces no error;
// these assertions compare the files to EACH OTHER, never to a string kept
// here, so there is no extra copy to keep in sync.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

test('every short blurb describes the same project in the same words', () => {
  const pkg = JSON.parse(read('package.json'));
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));

  // package.json is the reference only because npm publishes it; it carries no
  // more authority than the others. What matters is that they agree.
  const blurbs = [
    ['package.json', pkg.description],
    ['.claude-plugin/plugin.json', JSON.parse(read('.claude-plugin/plugin.json')).description],
    ['.github/plugin/plugin.json', JSON.parse(read('.github/plugin/plugin.json')).description],
    ['.claude-plugin/marketplace.json metadata', marketplace.metadata?.description],
    // Enumerated from the file, not from a count kept here: a marketplace with a
    // second plugin one day should widen this automatically.
    ...(marketplace.plugins ?? []).map((pl, i) => [`.claude-plugin/marketplace.json plugins[${i}]`, pl.description]),
  ];

  for (const [where, blurb] of blurbs) {
    assert.ok(blurb, `${where} must carry a description`);
  }
  for (const [where, blurb] of blurbs.slice(1)) {
    assert.equal(
      blurb,
      pkg.description,
      `${where} drifted from package.json: these are the same sentence for the same ` +
      'audience, so if one changes, change them all in the same commit',
    );
  }
});
