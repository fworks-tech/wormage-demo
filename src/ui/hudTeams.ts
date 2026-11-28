import type { GameSnapshot } from '../game/types';

/** Pick the two teams shown in the HUD side panels. Pure so it is unit-testable. */
export function pickHudTeams(snapshot: GameSnapshot) {
  const activeTeamSnap = snapshot.teams[snapshot.activeTeam];
  const activeIsHuman = !activeTeamSnap?.isAi;
  // Show the active human's ammo on their turn (hotseat); otherwise the player's team.
  const myTeam = activeIsHuman ? activeTeamSnap : snapshot.teams[0];
  // Oppose the displayed team, never the active team: during the opponent's
  // turn the active team IS the enemy, and filtering by it mirrors myTeam (#344).
  const myTeamId = myTeam?.id;
  // Show the nearest alive opposing team so 3+ team matches and eliminated enemies are handled.
  const opposingAlive = snapshot.teams.filter((t) => t.id !== myTeamId && t.worms.some((w) => w.alive));
  const enemy = opposingAlive[0] ?? snapshot.teams.find((t) => t.id !== myTeamId) ?? snapshot.teams[1];
  return { myTeam, enemy };
}
