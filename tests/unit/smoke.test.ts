import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { listTests } from '../../scripts/affected.mjs';

test('the smoke set stays limited to five critical player journeys', () => {
  const tagged = listTests().specs.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/test\('([^']+)'/g)]
      .map((match) => ({ file, title: match[1] }))
      .filter(({ title }) => title.includes('@smoke'));
  });

  expect(tagged).toHaveLength(5);
  expect(tagged.map(({ file }) => file).sort()).toEqual([
    'tests/combat.spec.ts',
    'tests/data.spec.ts',
    'tests/menu.spec.ts',
    'tests/online.spec.ts',
    'tests/online.spec.ts',
  ]);
  expect(tagged.map(({ title }) => title)).toEqual([
    '@smoke pause freezes the turn timer until resumed',
    '@smoke a finished match is registered once and shows in history and ranking',
    '@smoke options persist after reload and clamp the timer',
    '@smoke can create and join an online match',
    '@smoke a shot hands the online turn to the other human before the timer',
  ]);
});
