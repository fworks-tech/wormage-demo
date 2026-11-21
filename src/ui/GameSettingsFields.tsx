import { DIFFICULTY, TURN_SECONDS, TEAM_PALETTE, randomTeamName } from '../game/config';
import type { Difficulty, GameSettings, LoadoutId, MapId, ModeId, WindSetting } from '../game/types';

interface GameSettingsFieldsProps {
  settings: GameSettings;
  onChange: (settings: GameSettings) => void;
}

/** The match rules shared by the project Options panel and the /demo Settings dialog. */
export function GameSettingsFields({ settings, onChange }: GameSettingsFieldsProps) {
  const update = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <>
      <div className="option-row">
        <label htmlFor="players">
          <span>Players</span>
          <small>vs CPU or two humans sharing one device.</small>
        </label>
        <select
          id="players"
          value={settings.hotseat ? 'hotseat' : 'cpu'}
          onChange={(e) => update('hotseat', e.target.value === 'hotseat')}
          data-testid="select-players"
        >
          <option value="cpu">vs CPU</option>
          <option value="hotseat">2P local</option>
        </select>
      </div>

      <div className="option-row">
        <label htmlFor="team-count">
          <span>Teams</span>
          <small>Number of factions in the match (2-4).</small>
        </label>
        <select
          id="team-count"
          value={settings.teamCount ?? 2}
          onChange={(e) => {
            const n = Number(e.target.value);
            const names = (settings.teamNames ?? []).slice(0, n);
            while (names.length < n) names.push(TEAM_PALETTE[names.length]?.name ?? randomTeamName());
            update('teamCount', n);
            update('teamNames', names);
          }}
          data-testid="select-team-count"
        >
          {[2, 3, 4].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>

      <div className="option-row">
        <label>
          <span>Team names</span>
          <small>Customise each faction. Dice rolls a random name.</small>
        </label>
        <div className="team-names" data-testid="team-names">
          {Array.from({ length: settings.teamCount ?? 2 }, (_, i) => {
            const name = (settings.teamNames ?? [])[i] ?? TEAM_PALETTE[i]?.name ?? '';
            return (
              <div key={i} className="team-name-row">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    const names = [...(settings.teamNames ?? [])];
                    while (names.length <= i) names.push(TEAM_PALETTE[names.length]?.name ?? '');
                    names[i] = e.target.value;
                    update('teamNames', names);
                  }}
                  data-testid={`input-team-name-${i}`}
                />
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    const names = [...(settings.teamNames ?? [])];
                    while (names.length <= i) names.push(TEAM_PALETTE[names.length]?.name ?? '');
                    names[i] = randomTeamName();
                    update('teamNames', names);
                  }}
                  data-testid={`btn-roll-team-name-${i}`}
                  aria-label="Roll random name"
                >
                  🎲
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="option-row">
        <label htmlFor="turn-seconds">
          <span>Turn timer</span>
          <small>Seconds per turn. Longer turns reward repositioning.</small>
        </label>
        <div className="range-field">
          <input
            id="turn-seconds"
            type="range"
            min={TURN_SECONDS.min}
            max={TURN_SECONDS.max}
            step={TURN_SECONDS.step}
            value={settings.turnSeconds}
            onChange={(e) => update('turnSeconds', Number(e.target.value))}
            data-testid="input-turn-seconds"
          />
          <output className="mono">{settings.turnSeconds}s</output>
        </div>
      </div>

      <div className="option-row">
        <label htmlFor="wind">
          <span>Wind</span>
          <small>Gusts bend every arcing shot. Off for pure geometry.</small>
        </label>
        <select
          id="wind"
          value={settings.wind}
          onChange={(e) => update('wind', e.target.value as WindSetting)}
          data-testid="select-wind"
        >
          <option value="off">Off</option>
          <option value="light">Light</option>
          <option value="strong">Strong</option>
        </select>
      </div>

      <div className="option-row">
        <label htmlFor="difficulty">
          <span>Enemy skill</span>
          <small>{DIFFICULTY[settings.difficulty].blurb}</small>
        </label>
        <select
          id="difficulty"
          value={settings.difficulty}
          onChange={(e) => update('difficulty', e.target.value as Difficulty)}
          data-testid="select-difficulty"
        >
          {(Object.keys(DIFFICULTY) as Difficulty[]).map((key) => (
            <option key={key} value={key}>
              {DIFFICULTY[key].label}
            </option>
          ))}
        </select>
      </div>

      <div className="option-row">
        <label htmlFor="map">
          <span>Map</span>
          <small>Terrain silhouette.</small>
        </label>
        <select
          id="map"
          value={settings.map ?? 'island'}
          onChange={(e) => update('map', e.target.value as MapId)}
          data-testid="select-map"
        >
          {(['island','mesa','canyon','desert','arctic'] as MapId[]).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      <div className="option-row">
        <label htmlFor="mode">
          <span>Mode</span>
          <small>Win condition.</small>
        </label>
        <select
          id="mode"
          value={settings.mode ?? 'deathmatch'}
          onChange={(e) => update('mode', e.target.value as ModeId)}
          data-testid="select-mode"
        >
          {(['deathmatch','assassinate','sudden-death','fort'] as ModeId[]).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      <div className="option-row">
        <label htmlFor="loadout">
          <span>Loadout</span>
          <small>Starting ammo.</small>
        </label>
        <select
          id="loadout"
          value={settings.loadout ?? 'default'}
          onChange={(e) => update('loadout', e.target.value as LoadoutId)}
          data-testid="select-loadout"
        >
          {(['default','heavy','scout'] as LoadoutId[]).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      <div className="option-row">
        <label htmlFor="sound">
          <span>Sound</span>
          <small>Synthesized effects. No audio files, no downloads.</small>
        </label>
        <label className="switch">
          <input
            id="sound"
            type="checkbox"
            checked={settings.sound}
            onChange={(e) => update('sound', e.target.checked)}
            data-testid="toggle-sound"
          />
          <span>{settings.sound ? 'On' : 'Off'}</span>
        </label>
      </div>
    </>
  );
}
