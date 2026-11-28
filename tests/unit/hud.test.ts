import { describe, expect, test } from 'vitest';
import type { GameSnapshot } from '../../src/game/types';
import { pickHudTeams } from '../../src/ui/hudTeams';

const worm = (id: string, hp: number, alive = true) => ({
  id, name: id, hp, maxHp: 100, alive, active: false, x: 0, y: 0,
});

const team = (id: number, name: string, isAi: boolean, wormHp: number[]) => ({
  id, name, accent: '#fff', isAi, hp: wormHp.reduce((a, b) => a + b, 0), maxHp: wormHp.length * 100,
  ammo: {}, worms: wormHp.map((hp, i) => worm(`${id}-w${i}`, hp)),
});

const snapshot = (activeTeam: number) => ({
  activeTeam,
  teams: [team(0, 'Ironclad', false, [80, 65]), team(1, 'Rustbelt', true, [150, 100])],
}) as unknown as GameSnapshot;

describe('HUD team panels', () => {
  test('the panels never mirror the same team while both live', () => {
    for (const activeTeam of [0, 1]) {
      const { myTeam, enemy } = pickHudTeams(snapshot(activeTeam));
      expect(enemy?.id).not.toBe(myTeam?.id);
    }
  });

  test("on the player's turn the right panel is the AI opponent", () => {
    const { myTeam, enemy } = pickHudTeams(snapshot(0));
    expect(myTeam?.name).toBe('Ironclad');
    expect(enemy?.name).toBe('Rustbelt');
  });

  test('on the AI turn the right panel stays the AI opponent (reported in #344)', () => {
    const { myTeam, enemy } = pickHudTeams(snapshot(1));
    expect(myTeam?.name).toBe('Ironclad');
    expect(enemy?.name).toBe('Rustbelt');
  });
});
