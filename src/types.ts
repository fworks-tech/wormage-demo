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
}

export interface SessionResult {
  winnerTeam: number | null;
  playerTeam: number;
  playerWon: boolean;
  score: number;
  durationSeconds: number;
  endReason: EndReason;
  kills: number;
  teamScores?: [number, number];
  teamKills?: [number, number];
  config: SessionConfig;
  recordedAt: string;
}

export type Screen = 'menu' | 'game' | 'result';
