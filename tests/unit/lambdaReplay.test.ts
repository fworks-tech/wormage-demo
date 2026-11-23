import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../src/game/engine';
import {
  createOnlineMatch,
  getActionLog,
  getOnlineMatch,
  joinOnlineMatch,
  replayOnlineMatch as replayOnClient,
  submitOnlineAction,
} from '../../src/api/mockServer';
import type { OnlineActionLogEntry, OnlineMatch } from '../../src/api/types';

const requireCjs = createRequire(import.meta.url);
const { replayActionLog } = requireCjs('../../infra/lambda/replay.js') as {
  replayActionLog: (input: {
    GameEngine: typeof GameEngine;
    match: OnlineMatch;
    actions: OnlineActionLogEntry[];
  }) => {
    tick: number;
    snapshot: ReturnType<GameEngine['snapshot']>;
    winnerTeam: number | null;
    endReason: string | null;
    kills: number[];
  };
};

describe('lambda replay core', () => {
  test('matches the client replay for the same recorded action log', () => {
    const created = createOnlineMatch({
      playerId: 'p1',
      playerName: 'Alice',
      settings: { seed: 777, wormsPerTeam: 2, turnSeconds: 30, wind: 'light', difficulty: 'veteran' },
    });
    joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
    submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'e1', tick: 0 });
    submitOnlineAction(created.code, { playerId: 'p2', action: { type: 'endTurn' }, clientActionId: 'e2', tick: 1 });

    const match = getOnlineMatch(created.code)!;
    const actions = getActionLog(created.code);
    const server = replayActionLog({ GameEngine, match, actions });
    const client = replayOnClient(created.code)!;

    expect(server.tick).toBe(client.tick);
    expect(server.snapshot).toEqual(client.snapshot);
    expect(server.winnerTeam).toBe(client.winnerTeam);
    expect(server.endReason).toBe(client.endReason);
    expect(server.kills).toEqual(client.kills);
  });

  test('a bad action log does not drift from the client replay', () => {
    const created = createOnlineMatch({
      playerId: 'p1',
      playerName: 'Alice',
      settings: { seed: 4242, wormsPerTeam: 3, turnSeconds: 30, wind: 'off', difficulty: 'rookie' },
    });
    joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
    submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'weapon', id: 'grenade' }, clientActionId: 'w1', tick: 0 });
    submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'f1', tick: 2 });
    submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'e1', tick: 5 });

    const match = getOnlineMatch(created.code)!;
    const server = replayActionLog({ GameEngine, match, actions: getActionLog(created.code) });
    const client = replayOnClient(created.code)!;

    expect(server.snapshot).toEqual(client.snapshot);
    expect(server.tick).toBe(client.tick);
  });
});
