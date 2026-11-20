import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../../src/content/weapons';
import { WeaponSchema, MapThemeSchema } from '../../src/content/schema';

describe('content validation', () => {
  it('all weapons pass schema', () => {
    for (const w of Object.values(WEAPONS)) expect(() => WeaponSchema.parse(w)).not.toThrow();
  });
  it('map themes are valid', () => {
    for (const t of ['island', 'mesa', 'canyon', 'desert', 'arctic']) expect(() => MapThemeSchema.parse(t)).not.toThrow();
  });
  it('tampering fails', () => {
    expect(() => WeaponSchema.parse({ ...Object.values(WEAPONS)[0], damage: 9999 })).toThrow();
  });
});
