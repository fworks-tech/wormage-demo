import type { Difficulty, EndReason, GameSnapshot, WindSetting } from '../game/types';

export interface MatchRecord {
  id: string;
  clientMatchId: string;
  matchId: string;
  playerId: string;
  playerName: string;
  teamName: string;
  score: number;
  durationSeconds: number;
  endReason: EndReason;
  configKey: string;
  turnSeconds: number;
  wind: WindSetting;
  difficulty: Difficulty;
  map?: string;
  mode?: string;
  loadout?: string;
  kills: number;
  createdAt: string;
}

export interface NewMatchInput {
  clientMatchId: string;
  playerId: string;
  playerName: string;
  teamName: string;
  score: number;
  durationSeconds: number;
  endReason: EndReason;
  turnSeconds: number;
  wind: WindSetting;
  difficulty: Difficulty;
  map?: string;
  mode?: string;
  loadout?: string;
  kills: number;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  playerName: string;
  teamName: string;
  score: number;
  kills: number;
  durationSeconds: number;
  configKey: string;
  createdAt: string;
}

export type MockScenario = 'normal' | 'slow' | 'empty' | 'error';

export interface OnlinePlayer {
  playerId: string;
  playerName: string;
  teamName: string;
}

export interface OnlineMatchSettings {
  turnSeconds?: number;
  wind?: 'off' | 'light' | 'strong';
  difficulty?: 'rookie' | 'veteran' | 'elite';
  map?: string;
  mode?: string;
  loadout?: string;
  wormsPerTeam?: number;
  teamCount?: number;
  teamNames?: string[];
  seed?: number;
}

export interface OnlineMatch {
  code: string;
  status: 'waiting' | 'ready' | 'finished';
  createdAt: string;
  maxPlayers: number;
  settings: OnlineMatchSettings;
  players: OnlinePlayer[];
  activeTeam: number;
  turn: number;
  turnStartedAt: string;
  turnSeconds: number;
  winnerTeam: number | null;
  endReason: string | null;
  phase?: string;
  hasFired?: boolean;
  weapon?: string;
  actions?: OnlineActionLogEntry[];
  engineVersion?: number | null;
  /** Last canonical engine state persisted by the server. */
  snapshot?: GameSnapshot | null;
  snapshotTick?: number | null;
}

export interface OnlineActionLogEntry {
  seq?: number;
  tick?: number;
  engineTick?: number;
  turn?: number;
  action: { type: string; [k: string]: unknown };
  playerId: string;
  clientActionId?: string | null;
  at?: string;
}

export interface CreateOnlineMatchInput {
  playerId: string;
  playerName: string;
  teamName?: string;
  settings?: OnlineMatchSettings;
}

export interface JoinOnlineMatchInput {
  playerId: string;
  playerName: string;
  teamName?: string;
}

/** One frame of the current browser tab, captured through getDisplayMedia. */
export interface GameScreenshot {
  dataUrl: string;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
}
