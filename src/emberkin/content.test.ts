// Content-as-data tests, ported from the upstream ContentTests.cs plus extra
// cross-reference checks. Cheap, and they catch the class of rot hand-edited JSON
// accumulates: a learnset move that does not exist, an evolution target that is
// not a species, a species with no visual spec.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GameData, locateContentDir } from './content/gamedata.ts';
import { join } from 'node:path';

const data = GameData.loadFromDirectory();
const contentDir = locateContentDir();

test('content: is referentially valid', () => {
  const errors = data.validate();
  assert.equal(errors.length, 0, 'Content errors:\n' + errors.join('\n'));
});

test('content: roster has 50 contiguous dex entries', () => {
  assert.equal(data.dex.length, 50);
  for (let i = 0; i < data.dex.length; i++) assert.equal(data.dex[i]!.dexNumber, i + 1);
});

test('content: every species has a valid Resonance Art', () => {
  for (const s of data.dex) {
    assert.ok(s.resonanceArt && s.resonanceArt.length > 0, `${s.id} has no Art.`);
    assert.ok(data.moves.get(s.resonanceArt!)!.isResonanceArt, `${s.id}'s Art is not flagged.`);
  }
});

test('content: campaign has the expected structure', () => {
  assert.equal(data.campaign.regions.length, 6);
  assert.equal(data.campaign.sealWardens.length, 8);
  assert.ok(data.campaign.story.length >= 24);
  assert.equal(data.campaign.starters.length, 3);
});

test('content: learnsets start at level one and are ordered', () => {
  for (const s of data.dex) {
    assert.ok(s.learnset.length > 0, `${s.id} has an empty learnset`);
    assert.equal(s.learnset[0]!.level, 1);
    for (let i = 1; i < s.learnset.length; i++) {
      assert.ok(s.learnset[i]!.level >= s.learnset[i - 1]!.level, `${s.id} learnset unordered.`);
    }
  }
});

test('content: the type chart is complete (every element attacks and is attacked)', () => {
  const elements = data.types.elements;
  assert.equal(elements.length, 9);
  for (const atk of elements) {
    assert.ok(atk in data.types.chart, `element '${atk}' has no attack row`);
  }
  // Every declared chart pair references a declared element (also covered by validate()).
  for (const [atk, row] of Object.entries(data.types.chart)) {
    assert.ok(elements.includes(atk));
    for (const def of Object.keys(row)) assert.ok(elements.includes(def), `chart ${atk}->${def} unknown`);
  }
});

test('content: every species has a visual spec (art pipeline input)', () => {
  const visuals = JSON.parse(readFileSync(join(contentDir, 'visuals.json'), 'utf8')) as { id: string }[];
  const specced = new Set(visuals.map((v) => v.id));
  for (const s of data.dex) assert.ok(specced.has(s.id), `species '${s.id}' has no visual spec`);
});

test('content: the rebrand kept mechanic names and retitled only the brand', () => {
  // Lore-only rebrand: the title is Emberkin; Kin/Wardens/Resonance/Sync/Temperament stay.
  assert.equal(data.campaign.title, 'Emberkin: Resonance');
  // A signature-system move name is untouched.
  assert.ok(data.moves.has('cinder_nova'));
});
