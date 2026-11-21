import { useEffect, useState } from 'react';
import { useCreateOnlineMatch, useJoinOnlineMatch, useOnlineMatch } from '../api/queries';
import type { OnlineMatch } from '../api/types';
import type { PlayerIdentity as Player } from '../state/storage';
import { loadOnlineSession, saveOnlineSession, clearOnlineSession } from '../state/storage';

interface Props {
  player: Player;
  onClose: () => void;
}

type View = 'home' | 'create' | 'join';

export function OnlineMatchDialog({ player, onClose }: Props) {
  const [view, setView] = useState<View>('home');
  const [codeInput, setCodeInput] = useState('');
  const [match, setMatch] = useState<OnlineMatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeMsg, setResumeMsg] = useState<string | null>(null);

  const create = useCreateOnlineMatch();
  const join = useJoinOnlineMatch();
  const polled = useOnlineMatch(match?.code ?? null, !!match?.code);

  // Resume from stored session on mount.
  useEffect(() => {
    const session = loadOnlineSession();
    if (!session) return;
    (async () => {
      try {
        const res = await (async () => {
          const { data } = await (await import('../api/client')).api.get<{ code: string; match: OnlineMatch }>(`/api/matches/online/${encodeURIComponent(session.code)}`);
          return data;
        })();
        setMatch(res.match);
      } catch {
        clearOnlineSession();
        setResumeMsg('Previous match is no longer available.');
      }
    })();
  }, []);
  useEffect(() => {
    if (polled.data) setMatch(polled.data);
  }, [polled.data]);
  // Countdown timer removed from lobby; gameplay timer ships with #211 (online game screen).

  const handleCreate = async () => {
    setError(null);
    try {
      const res = await create.mutateAsync({
        playerId: player.id,
        playerName: player.name,
      });
      setMatch(res.match);
      saveOnlineSession({ code: res.match.code, playerId: player.id, playerName: player.name, teamName: res.match.players.find((pl) => pl.playerId === player.id)?.teamName ?? 'Team 1' });
      setView('create');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create match');
    }
  };

  const handleJoin = async () => {
    setError(null);
    const code = codeInput.trim().toUpperCase();
    if (!code) return;
    try {
      const res = await join.mutateAsync({ code, input: { playerId: player.id, playerName: player.name } });
      setMatch(res.match);
      saveOnlineSession({ code: res.match.code, playerId: player.id, playerName: player.name, teamName: res.match.players.find((pl) => pl.playerId === player.id)?.teamName ?? 'Team 1' });
      setView('join');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join match');
    }
  };

  const copyLink = () => {
    if (!match) return;
    const link = `${window.location.origin}/online/${match.code}`;
    void navigator.clipboard?.writeText(link);
  };

  return (
    <div className="overlay-card">
      <p className="eyebrow">Online match</p>
      <h2>{view === 'home' ? 'Challenge a friend' : view === 'create' ? 'Match created' : 'Joined match'}</h2>

      {view === 'home' && (
        <>
          {resumeMsg && <p className="muted" style={{ color: '#f66' }}>{resumeMsg}</p>}
          <p className="muted">Create a match and share the code, or join one with a code.</p>
          <div className="overlay-actions overlay-actions-stacked">
            <button type="button" className="primary-btn" onClick={handleCreate} disabled={create.isPending} data-testid="btn-create-online">
              {create.isPending ? 'Creating…' : 'Create match'}
            </button>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                placeholder="CODE"
                maxLength={6}
                data-testid="input-join-code"
                style={{ flex: 1, textTransform: 'uppercase', letterSpacing: '0.2em', textAlign: 'center' }}
              />
              <button type="button" className="ghost-btn" onClick={handleJoin} disabled={join.isPending || !codeInput.trim()} data-testid="btn-join-online">
                {join.isPending ? 'Joining…' : 'Join'}
              </button>
            </div>
            {error && <p className="muted" style={{ color: '#f66' }}>{error}</p>}
          </div>
        </>
      )}

      {view !== 'home' && match && (
        <>
          <p className="muted">
            Code: <strong data-testid="online-code">{match.code}</strong> · {match.players.length}/{match.maxPlayers} players · {match.status}
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0' }}>
            {match.players.map((p, i) => (
              <li key={p.playerId} data-testid="online-player">{p.playerName} — Team {i + 1}</li>
            ))}
          </ul>
          {match.status === 'ready' && match.winnerTeam == null && (
            <p className="muted" data-testid="online-ready-msg">Both players connected. Gameplay coming in the next update.</p>
          )}
          {view === 'create' && (
            <button type="button" className="ghost-btn" onClick={copyLink} data-testid="btn-copy-link">
              Copy link
            </button>
          )}
          <div className="overlay-actions">
            <button type="button" className="ghost-btn" onClick={() => { if (match?.winnerTeam != null) clearOnlineSession(); setView('home'); setMatch(null); }} data-testid="btn-back-online">
              Back
            </button>
            <button type="button" className="ghost-btn" onClick={onClose} data-testid="btn-close-online">
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}
