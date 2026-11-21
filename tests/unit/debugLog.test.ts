import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../src/game/engine';
import type { MatchConfig } from '../../src/game/types';

const config = (overrides: Partial<MatchConfig> = {}): MatchConfig => ({
  turnSeconds: 30,
  wind: 'light',
  difficulty: 'veteran',
  seed: 4242,
  wormsPerTeam: 2,
  ...overrides,
});

describe('debug logging', () => {
  test('records match and turn snapshots', () => {
    const engine = new GameEngine(config());
    expect(engine.debugLog.some((entry) => entry.category === 'match.start')).toBe(true);
    expect(engine.debugLog.some((entry) => entry.category === 'turn.start')).toBe(true);
    expect(engine.debugSnapshots.some((snapshot) => snapshot.reason === 'match.start')).toBe(true);
    expect(engine.debugSnapshots.some((snapshot) => snapshot.reason === 'turn.start')).toBe(true);
    expect(engine.sessionId).toBeTruthy();
    expect(engine.matchId).toBeTruthy();
  });

  test('clears debug state', () => {
    const engine = new GameEngine(config());
    engine.clearDebugLog();
    engine.clearDebugSnapshots();
    expect(engine.debugLog).toHaveLength(0);
    expect(engine.debugSnapshots).toHaveLength(0);
  });
});
