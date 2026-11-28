import type { GameSnapshot } from '../game/types';

/** Pick the two teams shown in the HUD side panels. Pure so it is unit-testable. */
export function pickHudTeams(snapshot: GameSnapshot) {
  const activeTeamSnap = snapshot.teams[snapshot.activeTeam];
  const activeIsHuman = !activeTeamSnap?.isAi;
  // Show the active human's ammo on their turn (hotseat); otherwise the player's team.
  const myTeam = activeIsHuman ? activeTeamSnap : snapshot.teams[0];
  // Show the nearest alive opposing team so 3+ team matches and eliminated enemies are handled.
  const opposingAlive = snapshot.teams.filter((t, i) => i !== snapshot.activeTeam && t.worms.some((w) => w.alive));
  const enemy = opposingAlive[0] ?? snapshot.teams[1];
  return { myTeam, enemy };
}
