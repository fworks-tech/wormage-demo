import { afterEach, expect, test, vi } from 'vitest';
import {
  createDefaultProfile,
  LocalStorageProfileRepository,
  withMissionComplete,
  type Profile,
} from '../../src/state/profile';

const PROFILE_KEY = 'wormage.profile.v1';

const validProfile: Profile = {
  version: 1,
  id: 'player-test',
  name: 'Test Commander',
  xp: 1250,
  level: 4,
  unlocks: ['heavy', 'scout'],
  missionProgress: { '1-3': true, '2-3': true },
};

const stubStorage = (raw: string | null = null) => {
  const data = new Map<string, string>();
  if (raw !== null) data.set(PROFILE_KEY, raw);
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
  vi.stubGlobal('localStorage', storage);
  return { data, storage };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test('empty storage creates and persists a complete default profile', () => {
  const { data } = stubStorage();
  const repository = new LocalStorageProfileRepository();

  const profile = repository.load();

  expect(profile).toEqual({
    version: 1,
    id: expect.stringMatching(/^player-/),
    name: 'Field Commander',
    xp: 0,
    level: 1,
    unlocks: [],
    missionProgress: {},
  });
  expect(JSON.parse(data.get(PROFILE_KEY)!)).toEqual(profile);
  expect(repository.load()).toEqual(profile);
});

test('save and load round-trip every profile field', () => {
  stubStorage();
  const repository = new LocalStorageProfileRepository();

  repository.save(validProfile);

  expect(new LocalStorageProfileRepository().load()).toEqual(validProfile);
});

test('completing a mission records progress without mutating the previous profile', () => {
  stubStorage(JSON.stringify(validProfile));

  const next = withMissionComplete(validProfile, '3-3');

  expect(next.missionProgress).toEqual({ '1-3': true, '2-3': true, '3-3': true });
  expect(validProfile.missionProgress).toEqual({ '1-3': true, '2-3': true });
});

test('mission progress written after a win survives a fresh repository load', () => {
  const { data } = stubStorage(JSON.stringify(validProfile));
  const repository = new LocalStorageProfileRepository();

  const next = withMissionComplete(repository.load(), '3-3');
  repository.save(next);

  expect(JSON.parse(data.get(PROFILE_KEY)!)).toEqual(next);
  expect(new LocalStorageProfileRepository().load()).toEqual(next);
});

test('reset removes only the profile payload', () => {
  const { data } = stubStorage(JSON.stringify(validProfile));
  data.set('wormage.settings.v1', '{"turnTimer":45}');
  data.set('wormage.bindings.v1', '{"fire":"KeyF"}');

  new LocalStorageProfileRepository().reset();

  expect(data.has(PROFILE_KEY)).toBe(false);
  expect(data.get('wormage.settings.v1')).toBe('{"turnTimer":45}');
  expect(data.get('wormage.bindings.v1')).toBe('{"fire":"KeyF"}');
});

test.each([
  ['corrupt JSON', '{'],
  ['null', 'null'],
  ['an array', '[]'],
  ['a partial profile', JSON.stringify({ version: 1, id: 'player-partial' })],
  ['a missing version', JSON.stringify({ ...validProfile, version: undefined })],
  ['an old version', JSON.stringify({ ...validProfile, version: 0 })],
  ['a future version', JSON.stringify({ ...validProfile, version: 2 })],
  ['a string version', JSON.stringify({ ...validProfile, version: '1' })],
  [
    'invalid fields',
    JSON.stringify({ ...validProfile, xp: -1, level: 0, unlocks: 'heavy', missionProgress: [] }),
  ],
])('%s falls back to a fresh default profile', (_label, raw) => {
  const { data } = stubStorage(raw);

  const profile = new LocalStorageProfileRepository().load();

  expect(profile).toMatchObject({ version: 1, xp: 0, level: 1, unlocks: [], missionProgress: {} });
  expect(JSON.parse(data.get(PROFILE_KEY)!)).toEqual(profile);
});

test('a corrupt legacy player identity cannot produce an invalid default profile', () => {
  const { data } = stubStorage();
  data.set('wormage.player.v1', JSON.stringify({ id: 42, name: null }));

  const profile = new LocalStorageProfileRepository().load();

  expect(profile.id).toMatch(/^player-/);
  expect(profile.name).toBe('Field Commander');
});

test('invalid runtime data is not written over a valid profile', () => {
  stubStorage(JSON.stringify(validProfile));
  const repository = new LocalStorageProfileRepository();

  repository.save({ ...validProfile, xp: -1 });

  expect(repository.load()).toEqual(validProfile);
});

test('storage failures never escape into the game', () => {
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => {
      throw new Error('storage denied');
    }),
    setItem: vi.fn(() => {
      throw new Error('storage denied');
    }),
    removeItem: vi.fn(() => {
      throw new Error('storage denied');
    }),
  });
  const repository = new LocalStorageProfileRepository();

  expect(() => repository.load()).not.toThrow();
  expect(() => repository.save(validProfile)).not.toThrow();
  expect(() => repository.reset()).not.toThrow();
});

test('default profiles do not share nested arrays or records', () => {
  stubStorage();
  const first = createDefaultProfile();
  const second = createDefaultProfile();

  first.unlocks.push('heavy');
  first.missionProgress['1-3'] = true;

  expect(second.unlocks).toEqual([]);
  expect(second.missionProgress).toEqual({});
});
