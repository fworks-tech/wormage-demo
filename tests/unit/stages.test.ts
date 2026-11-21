import { expect, test } from 'vitest';
import { STAGES, nextStage } from '../../src/state/stages';

test('nextStage returns the following stage in order', () => {
  expect(nextStage('1-3')?.id).toBe('2-3');
  expect(nextStage('2-3')?.id).toBe('3-3');
});

test('nextStage returns null on the final stage', () => {
  expect(nextStage('3-3')).toBeNull();
});

test('nextStage returns null for unknown id', () => {
  expect(nextStage('nope')).toBeNull();
});

test('STAGES has three stages ending at 3-3', () => {
  expect(STAGES.length).toBe(3);
  expect(STAGES[STAGES.length - 1].id).toBe('3-3');
});