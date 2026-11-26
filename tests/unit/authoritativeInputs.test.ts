import { expect, test } from 'vitest';
import { AIM } from '../../src/game/config';
import { GameEngine } from '../../src/game/engine';
import type { MatchConfig } from '../../src/game/types';
import {
  createOnlineMatch,
  getActionLog,
  getOnlineMatch,
  joinOnlineMatch,
  replayActions,
  replayOnlineMatch,
  submitOnlineAction,
} from '../../src/api/mockServer';

const DT = 1 / 60;

const config = (): MatchConfig => ({
  turnSeconds: 30,
  wind: 'off',
  difficulty: 'rookie',
  seed: 4242,
  wormsPerTeam: 1,
  map: 'island',
  mode: 'deathmatch',
});

function aimPhase(engine: GameEngine): void {
  let guard = 0;
  while (engine.phase !== 'aim' && engine.phase !== 'gameover' && guard < 60 * 60) {
    engine.update(DT);
    guard += 1;
  }
  expect(engine.phase).toBe('aim');
}

test('move and reel only log direction transitions', () => {
  const engine = new GameEngine(config());
  aimPhase(engine);

  engine.recordMove(1);
  engine.recordMove(1);
  engine.recordMove(1);
  engine.recordReel(-1);
  engine.recordReel(-1);
  expect(engine.log.filter((entry) => entry.action.type === 'move')).toHaveLength(1);
  expect(engine.log.filter((entry) => entry.action.type === 'reel')).toHaveLength(1);

  engine.recordMove(0);
  engine.recordReel(0);
  expect(engine.log.filter((entry) => entry.action.type === 'move')).toHaveLength(2);
  expect(engine.log.filter((entry) => entry.action.type === 'reel')).toHaveLength(2);
  expect(engine.moveDir).toBe(0);
  expect(engine.reelDir).toBe(0);
});

test('aimAt and setPower clamp to the same bounds as pointer input', () => {
  const engine = new GameEngine(config());
  aimPhase(engine);
  const worm = engine.activeWorm;
  expect(worm).not.toBeNull();

  engine.applyAction({ type: 'aimAt', angle: 0 });
  expect(worm!.aimAngle).toBe(AIM.max);
  engine.applyAction({ type: 'aimAt', angle: -3.1 });
  expect(worm!.aimAngle).toBe(AIM.min);
  engine.applyAction({ type: 'setPower', power: 1.5 });
  expect(engine.power).toBe(1);
  engine.applyAction({ type: 'setPower', power: -0.5 });
  expect(engine.power).toBe(0);
});

test('a recorded shot replays to the same snapshot on a fresh engine', () => {
  const live = new GameEngine(config());
  aimPhase(live);

  live.recordMove(1);
  for (let i = 0; i < 30; i += 1) live.update(DT);
  live.recordMove(0);
  live.record({ type: 'aimAt', angle: -1.2 });
  live.record({ type: 'setPower', power: 0.8 });
  live.recordShotState();
  live.record({ type: 'fire' });
  let guard = 0;
  while (live.phase !== 'aim' && live.phase !== 'gameover' && guard < 60 * 60) {
    live.update(DT);
    guard += 1;
  }

  const replay = new GameEngine(config());
  let cursor = 0;
  guard = 0;
  while ((replay.phase !== 'aim' || replay.tick < live.tick) && replay.phase !== 'gameover' && guard < 60 * 60) {
    while (cursor < live.log.length && live.log[cursor].tick === replay.tick) {
      replay.applyAction(live.log[cursor].action);
      cursor += 1;
    }
    replay.update(DT);
    guard += 1;
  }
  while (cursor < live.log.length) {
    replay.applyAction(live.log[cursor].action);
    cursor += 1;
  }

  expect(cursor).toBe(live.log.length);
  expect(live.log.some((entry) => entry.action.type === 'aimAt')).toBe(true);
  expect(live.log.some((entry) => entry.action.type === 'setPower')).toBe(true);
  expect(replay.snapshot()).toEqual(live.snapshot());
});

test('an authoritative shot through the online transport replays identically', () => {
  const created = createOnlineMatch({
    playerId: 'p1',
    playerName: 'Alice',
    settings: { seed: 4242, wormsPerTeam: 1, turnSeconds: 30, wind: 'off', difficulty: 'rookie' },
  });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });

  const script: Array<{ action: { type: string; [k: string]: unknown }; tick: number }> = [
    { action: { type: 'move', dir: 1 }, tick: 0 },
    { action: { type: 'move', dir: 0 }, tick: 30 },
    { action: { type: 'aimAt', angle: -1.2 }, tick: 30 },
    { action: { type: 'setPower', power: 0.8 }, tick: 30 },
    { action: { type: 'fire' }, tick: 30 },
  ];
  script.forEach(({ action, tick }, index) => {
    const res = submitOnlineAction(created.code, {
      playerId: 'p1',
      action,
      clientActionId: `shot-${index}`,
      tick,
    });
    expect('error' in res).toBe(false);
  });

  const match = getOnlineMatch(created.code);
  expect(match).not.toBeNull();
  const server = replayOnlineMatch(created.code);
  expect(server).not.toBeNull();
  const client = replayActions(match!, getActionLog(created.code), server!.tick);
  expect(client.snapshot()).toEqual(server!.snapshot);

  const log = getActionLog(created.code);
  expect(log.some((entry) => entry.action.type === 'aimAt')).toBe(true);
  expect(log.some((entry) => entry.action.type === 'setPower')).toBe(true);
});

test('aimAt and setPower are rejected outside the aim phase', () => {
  const created = createOnlineMatch({
    playerId: 'p1',
    playerName: 'Alice',
    settings: { seed: 4242, wormsPerTeam: 1, turnSeconds: 30, wind: 'off', difficulty: 'rookie' },
  });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const fire = submitOnlineAction(created.code, {
    playerId: 'p1',
    action: { type: 'fire' },
    clientActionId: 'fire-1',
    tick: 0,
  });
  expect('error' in fire).toBe(false);

  const late = submitOnlineAction(created.code, {
    playerId: 'p1',
    action: { type: 'aimAt', angle: -1.2 },
    clientActionId: 'aimAt-late',
    tick: 1,
  });
  expect(late).toMatchObject({ status: 409 });
});
