import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { LeaderboardRow, MatchRecord, NewMatchInput, OnlineMatch, Paginated, CreateOnlineMatchInput, JoinOnlineMatchInput } from './types';

export const queryKeys = {
  leaderboard: (configKey: string, page: number, pageSize: number) =>
    ['leaderboard', configKey, page, pageSize] as const,
  matches: (playerId: string, page: number, pageSize: number) => ['matches', playerId, page, pageSize] as const,
};

export function useLeaderboard(configKey: string, page: number, pageSize = 8) {
  return useQuery({
    queryKey: queryKeys.leaderboard(configKey, page, pageSize),
    queryFn: async () => {
      const { data } = await api.get<Paginated<LeaderboardRow>>('/api/leaderboard', {
        params: { page, pageSize, configKey },
      });
      return data;
    },
    placeholderData: keepPreviousData,
    staleTime: 20_000,
    retry: 1,
  });
}

export function useMatchHistory(playerId: string, page: number, pageSize = 8) {
  return useQuery({
    queryKey: queryKeys.matches(playerId, page, pageSize),
    queryFn: async () => {
      const { data } = await api.get<Paginated<MatchRecord>>('/api/matches', {
        params: { playerId, page, pageSize },
      });
      return data;
    },
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    retry: 1,
  });
}

export function useRegisterMatch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewMatchInput) => {
      const { data } = await api.post<MatchRecord>('/api/matches', input);
      return data;
    },
    retry: 1,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['leaderboard'] });
      void client.invalidateQueries({ queryKey: ['matches'] });
    },
  });
}

export function useOnlineMatch(code: string | null, enabled = true) {
  return useQuery({
    queryKey: ['online-match', code],
    queryFn: async () => {
      if (!code) throw new Error('no code');
      const { data } = await api.get<{ code: string; match: import('./types').OnlineMatch }>(`/api/matches/online/${encodeURIComponent(code)}`);
      return data.match;
    },
    enabled: enabled && !!code,
    refetchInterval: (q) => {
      const m = q.state.data;
      if (!m || m.winnerTeam != null) return false;
      if (m.status !== 'ready') return 2000;
      return 1000;
    },
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: 1,
  });
}

export function useSubmitOnlineAction() {
  return useMutation({
    mutationFn: async ({ code, playerId, action, clientActionId, tick }: { code: string; playerId: string; action: { type: string; [k: string]: unknown }; clientActionId: string; tick?: number }) => {
      const { data } = await api.post<{ code: string; match: import('./types').OnlineMatch; duplicate?: true }>(`/api/matches/online/${encodeURIComponent(code)}/action`, { playerId, action, clientActionId, tick });
      return data;
    },
    retry: 0,
  });
}

export function useForfeitOnlineMatch() {
  return useMutation({
    mutationFn: async ({ code, playerId }: { code: string; playerId: string }) => {
      const { data } = await api.post<{ code: string; match: import('./types').OnlineMatch }>(`/api/matches/online/${encodeURIComponent(code)}/forfeit`, { playerId });
      return data;
    },
    retry: 0,
  });
}

export function useCreateOnlineMatch() {
  return useMutation({
    mutationFn: async (input: CreateOnlineMatchInput) => {
      const { data } = await api.post<{ code: string; link: string; match: OnlineMatch }>('/api/matches/online', input);
      return data;
    },
    retry: 0,
  });
}

export function useJoinOnlineMatch() {
  return useMutation({
    mutationFn: async ({ code, input }: { code: string; input: JoinOnlineMatchInput }) => {
      const { data } = await api.post<{ code: string; match: OnlineMatch }>(`/api/matches/online/${encodeURIComponent(code)}/join`, input);
      return data;
    },
    retry: 0,
  });
}

export async function refreshBoards(client: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['leaderboard'] }),
    client.invalidateQueries({ queryKey: ['matches'] }),
  ]);
}
