import { WeaponSchema } from './schema';
import type { WeaponDef } from '../game/types';

const raw = {
  bazooka: {
    id: 'bazooka', kind: 'projectile', name: 'Bazooka', ammo: null, damage: 42, radius: 48, terrainRadius: 42,
    speedMin: 260, speedMax: 830, gravityScale: 1, windScale: 1, fuse: null, bounces: false, life: null,
    color: 0xffd166, blurb: 'Reliable arc, unlimited rockets. Mind the wind.',
  },
  grenade: {
    id: 'grenade', kind: 'projectile', name: 'Grenade', ammo: 3, damage: 52, radius: 54, terrainRadius: 46,
    speedMin: 240, speedMax: 760, gravityScale: 1, windScale: 0.8, fuse: 3, bounces: true, life: null,
    color: 0x9ee37d, blurb: 'Bounces off dirt, detonates after three seconds.',
  },
  shotgun: {
    id: 'shotgun', kind: 'projectile', name: 'Shotgun', ammo: 4, damage: 24, radius: 12, terrainRadius: 9,
    speedMin: 1500, speedMax: 1500, gravityScale: 0.08, windScale: 0, fuse: null, bounces: false, life: 0.34,
    color: 0xf2b8a2, blurb: 'Flat and fast. No arc, no excuses.',
  },
  dynamite: {
    id: 'dynamite', kind: 'drop', name: 'Dynamite', ammo: 2, damage: 78, radius: 78, terrainRadius: 66,
    speedMin: 0, speedMax: 0, gravityScale: 1, windScale: 0, fuse: 2.2, bounces: false, life: null,
    color: 0xff6b5b, blurb: 'Drops at your feet. Run. Two second fuse.',
  },
  medkit: {
    id: 'medkit', kind: 'utility', name: 'Medkit', ammo: 2, damage: 0, radius: 0, terrainRadius: 0,
    speedMin: 0, speedMax: 0, gravityScale: 1, windScale: 0, fuse: null, bounces: false, life: null,
    color: 0x7bd389, blurb: 'Heal 30 HP. Ends the turn.', heal: 30,
  },
  shield: {
    id: 'shield', kind: 'utility', name: 'Shield', ammo: 1, damage: 0, radius: 0, terrainRadius: 0,
    speedMin: 0, speedMax: 0, gravityScale: 1, windScale: 0, fuse: null, bounces: false, life: null,
    color: 0x7aa2f7, blurb: 'Absorb 50 damage. Ends the turn.', shield: 50,
  },
};

export const WEAPONS: Record<string, WeaponDef> = {};
for (const [key, value] of Object.entries(raw)) {
  WEAPONS[key] = WeaponSchema.parse(value) as WeaponDef;
}

export const WEAPON_ORDER: string[] = ['bazooka', 'grenade', 'shotgun', 'dynamite', 'medkit', 'shield'];
