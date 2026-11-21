import { useEffect, useState } from 'react';
import { useCreateOnlineMatch, useJoinOnlineMatch, useOnlineMatch } from '../api/queries';
import type { OnlineMatch } from '../api/types';
import type { PlayerIdentity as Player } from '../state/storage';

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
  const [now, setNow] = useState(() => Date.now());
  const create = useCreateOnlineMatch();
  const join = useJoinOnlineMatch();
  const polled = useOnlineMatch(match?.code ?? null, !!match?.code);
  useEffect(() => {
    if (polled.data) setMatch(polled.data);
  }, [polled.data]);
  useEffect(() => {
    if (!match?.code || match.winnerTeam != null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [match?.code, match?.winnerTeam]);

  const handleCreate = async () => {
    setError(null);
    try {
      const res = await create.mutateAsync({
        playerId: player.id,
        playerName: player.name,
        teamName: 'Ironclad',
      });
      setMatch(res.match);
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
      const res = await join.mutateAsync({ code, input: { playerId: player.id, playerName: player.name, teamName: 'Ironclad' } });
      setMatch(res.match);
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
            {match.status === 'ready' && match.winnerTeam == null && (
              <span data-testid="online-timeleft"> · {Math.max(0, Math.ceil((new Date(match.turnStartedAt).getTime() + match.turnSeconds * 1000 - now) / 1000))}s (team {match.activeTeam})</span>
            )}
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0' }}>
            {match.players.map((p) => (
              <li key={p.playerId} data-testid="online-player">{p.playerName} ({p.teamName})</li>
            ))}
          </ul>
          {view === 'create' && (
            <button type="button" className="ghost-btn" onClick={copyLink} data-testid="btn-copy-link">
              Copy link
            </button>
          )}
          <div className="overlay-actions">
            <button type="button" className="ghost-btn" onClick={() => { setView('home'); setMatch(null); }} data-testid="btn-back-online">
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
