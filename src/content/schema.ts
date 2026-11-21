import { z } from 'zod';

export const WeaponKindSchema = z.enum(['projectile', 'drop', 'hitscan', 'utility']);

export const WeaponSchema = z.object({
  id: z.string().min(1),
  kind: WeaponKindSchema,
  name: z.string().min(1),
  ammo: z.number().int().min(0).nullable(),
  damage: z.number().min(0).max(500),
  radius: z.number().min(0).max(500),
  terrainRadius: z.number().min(0).max(500),
  speedMin: z.number().min(0),
  speedMax: z.number().min(0),
  gravityScale: z.number().min(0).max(5),
  windScale: z.number().min(0).max(5),
  fuse: z.number().min(0).nullable(),
  bounces: z.boolean(),
  life: z.number().min(0).nullable(),
  color: z.number().int(),
  blurb: z.string(),
  heal: z.number().min(0).optional(),
  shield: z.number().min(0).optional(),
});

export const MapThemeSchema = z.enum(['island', 'mesa', 'canyon', 'desert', 'arctic']);

export const MapParamsSchema = z.object({
  roughness: z.number().min(0).max(2).default(1),
  waterLevel: z.number().min(0.3).max(0.95).default(0.92),
  shelfCount: z.number().int().min(0).max(6).default(2),
  caveDensity: z.number().min(0).max(1).default(0.3),
  symmetry: z.boolean().default(false),
});

export const MapSchema = z.object({
  id: z.string().min(1),
  theme: MapThemeSchema,
  params: MapParamsSchema.default({ roughness: 1, waterLevel: 0.92, shelfCount: 2, caveDensity: 0.3, symmetry: false }),
  chunks: z.number().int().min(1).max(9).default(1),
});

export const ModeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  suddenDeathTurn: z.number().int().min(0).nullable().default(null),
  suddenDeathDamage: z.number().min(0).default(0),
  suddenDeathShrink: z.number().min(0).max(1).default(0),
});

export const LoadoutSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ammo: z.record(z.string(), z.number().int().min(0).nullable()),
});

export const LootKindSchema = z.enum(['ammo', 'mine', 'secret']);

export const LootTableSchema = z.object({
  id: z.string().min(1),
  kind: LootKindSchema,
  radius: z.number().min(4).max(64).default(24),
  fuse: z.number().min(0).default(1.5),
  blastRadius: z.number().min(0).max(200).default(60),
  grant: z.number().min(0).default(1),
});

export const MobSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  hp: z.number().min(1).max(500),
  damage: z.number().min(0).max(200),
  speed: z.number().min(0).max(500),
  radius: z.number().min(4).max(64).default(20),
  loot: z.string().optional(),
});

export const StageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  map: z.string().min(1),
  mode: z.string().min(1),
  difficulty: z.enum(['rookie', 'veteran', 'elite']),
  wormsPerTeam: z.number().int().min(1).max(8),
  unlockAfter: z.string().nullable().default(null),
});

export type WeaponDefData = z.infer<typeof WeaponSchema>;
export type MapData = z.infer<typeof MapSchema>;
export type ModeData = z.infer<typeof ModeSchema>;
export type LoadoutData = z.infer<typeof LoadoutSchema>;
export type LootTableData = z.infer<typeof LootTableSchema>;
export type MobData = z.infer<typeof MobSchema>;
export type StageData = z.infer<typeof StageSchema>;
