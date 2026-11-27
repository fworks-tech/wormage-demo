import { z } from 'zod';
import { loadPlayer } from './storage';
import { loadProgress, resetProgress } from './stages';

const PROFILE_KEY = 'wormage.profile.v1';
const PROFILE_VERSION = 1;

const ProfileSchema = z.object({
  version: z.literal(PROFILE_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  xp: z.number().int().nonnegative(),
  level: z.number().int().positive(),
  unlocks: z.array(z.string().min(1)),
  missionProgress: z.record(z.string().min(1), z.boolean()),
});

export type Profile = z.infer<typeof ProfileSchema>;

export interface ProfileRepository {
  load(): Profile;
  save(profile: Profile): void;
  reset(): void;
}

export function createDefaultProfile(): Profile {
  const player = loadPlayer();
  return {
    version: PROFILE_VERSION,
    id: player.id,
    name: player.name,
    xp: 0,
    level: 1,
    unlocks: [],
    missionProgress: {},
  };
}

export function withMissionComplete(profile: Profile, missionId: string): Profile {
  return {
    ...profile,
    missionProgress: { ...profile.missionProgress, [missionId]: true },
  };
}

export class LocalStorageProfileRepository implements ProfileRepository {
  load(): Profile {
    let profile: Profile | undefined;
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) {
        const parsed = ProfileSchema.safeParse(JSON.parse(raw));
        // shortcut: mismatched versions reset to defaults; add a migration when v2 ships
        if (parsed.success) profile = parsed.data;
      }
    } catch {
      // corrupt or unavailable storage falls through to a fresh profile
    }

    let created = false;
    if (!profile) {
      profile = createDefaultProfile();
      created = true;
    }

    let migrated = false;
    const missionProgress = { ...profile.missionProgress };
    for (const [id, completed] of Object.entries(loadProgress() ?? {})) {
      if (completed === true && missionProgress[id] !== true) {
        missionProgress[id] = true;
        migrated = true;
      }
    }
    if (migrated) profile = { ...profile, missionProgress };
    if (created || migrated) this.save(profile);
    return profile;
  }

  save(profile: Profile): void {
    try {
      const parsed = ProfileSchema.safeParse(profile);
      if (parsed.success) localStorage.setItem(PROFILE_KEY, JSON.stringify(parsed.data));
    } catch {
      // storage can be unavailable in private modes; the session still works
    }
  }

  reset(): void {
    try {
      localStorage.removeItem(PROFILE_KEY);
    } catch {
      // ignore
    }
    resetProgress();
  }
}
