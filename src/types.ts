import type { EndReason } from './game/types';

export interface SessionConfig {
  turnSeconds: number;
  wind: 'off' | 'light' | 'strong';
  difficulty: 'rookie' | 'veteran' | 'elite';
  seed: number;
  map?: 'island' | 'mesa' | 'canyon' | 'desert' | 'arctic';
  mode?: 'deathmatch' | 'assassinate' | 'sudden-death' | 'fort';
  loadout?: 'default' | 'heavy' | 'scout';
  hotseat?: boolean;
  teamCount?: number;
  teamNames?: string[];
}

export interface SessionResult {
  winnerTeam: number | null;
  playerTeam: number;
  playerWon: boolean;
  score: number;
  durationSeconds: number;
  endReason: EndReason;
  kills: number;
  teamScores?: number[];
  teamKills?: number[];
  config: SessionConfig;
  recordedAt: string;
  /** Stage id when this match was played as a stage, if any. */
  stageId?: string;
}

export type Screen = 'menu' | 'game' | 'result' | 'online-game';
