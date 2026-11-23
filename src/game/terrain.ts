import { WATER_Y, WORLD_H, WORLD_W } from './config';

const CELL = 4;
export const COLS = Math.ceil(WORLD_W / CELL);
export const ROWS = Math.ceil(WORLD_H / CELL);

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothNoise(rng: () => number, points: number): (t: number) => number {
  const values = Array.from({ length: points + 1 }, () => rng());
  return (t: number) => {
    const clamped = Math.min(0.9999, Math.max(0, t)) * points;
    const i = Math.floor(clamped);
    const f = clamped - i;
    const eased = f * f * (3 - 2 * f);
    return values[i] * (1 - eased) + values[i + 1] * eased;
  };
}

export interface TerrainShelf {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

/** Two floating shelves give the arena vertical play. */
const SHELVES: ReadonlyArray<Readonly<TerrainShelf>> = [
  { x: WORLD_W * 0.33, y: 330, rx: 118, ry: 20 },
  { x: WORLD_W * 0.67, y: 286, rx: 96, ry: 17 },
];

/** Noise octaves island generation consumes before any cosmetic pass. */
const NOISE_POINTS = [7, 16, 42] as const;

/**
 * RNG positioned where island generation stopped. The painter continues the
 * pre-split stream, so pebbles keep their exact positions for a given seed.
 */
export function cosmeticRng(seed: number): () => number {
  const rng = mulberry32(seed);
  for (const points of NOISE_POINTS) {
    for (let i = 0; i <= points; i += 1) rng();
  }
  return rng;
}

/**
 * Destructible terrain as a coarse occupancy mask. Generation, collision and
 * craters live here; `TerrainPainter` draws the matching canvas.
 */
export class Terrain {
  readonly mask = new Uint8Array(COLS * ROWS);
  readonly shelves: ReadonlyArray<Readonly<TerrainShelf>> = SHELVES;
  readonly seed: number;
  /** Fired after the mask changes. One listener: the renderer repaints its canvas. */
  onCarve: ((x: number, y: number, radius: number) => void) | null = null;
  private readonly surfaceAt: (x: number) => number;

  constructor(seed: number, theme: string = 'island') {
    this.seed = seed >>> 0;
    const rng = mulberry32(this.seed);
    const [big, medium, small] = NOISE_POINTS.map((points) => smoothNoise(rng, points));

    // Theme tweaks the surface amplitude and base height.
    const themeBoost: Record<string, number> = { mesa: 0.4, canyon: 1.3, desert: 0.7, arctic: 0.5, island: 1 };
    const boost = themeBoost[theme] ?? 1;
    const baseHeight = theme === 'mesa' ? 480 : theme === 'canyon' ? 420 : 452;

    this.surfaceAt = (x: number): number => {
      const t = x / WORLD_W;
      const rise = Math.sin(t * Math.PI) * 42;
      const canyonNotch = theme === 'canyon' ? Math.sin(t * Math.PI * 3) * 60 : 0;
      const raw =
        baseHeight +
        big(t) * 110 * boost +
        medium(t) * 46 * boost +
        small(t) * 14 -
        rise +
        Math.abs(x - WORLD_W / 2) * 0.03 +
        canyonNotch;
      // Clamping here (not only in the mask) keeps the drawn surface on the
      // collision surface: at the map edges the raw height passes the water
      // line, and the painter used to draw the island below the sand the worm
      // stands on.
      return Math.max(140, Math.min(WATER_Y - 26, raw));
    };

    // Nothing below the water line is solid: the painter erases that area, so
    // a solid seabed let worms stand on ground that was never drawn (and never
    // drown) after a blast opened a path to it.
    const waterRow = Math.floor(WATER_Y / CELL);
    for (let cx = 0; cx < COLS; cx += 1) {
      const x = cx * CELL + CELL / 2;
      const startRow = Math.floor(this.surfaceAt(x) / CELL);
      for (let cy = startRow; cy < waterRow; cy += 1) this.mask[cy * COLS + cx] = 1;
    }

    for (const s of this.shelves) {
      for (let cy = 0; cy < ROWS; cy += 1) {
        const y = cy * CELL + CELL / 2;
        for (let cx = 0; cx < COLS; cx += 1) {
          const x = cx * CELL + CELL / 2;
          const dx = (x - s.x) / s.rx;
          const dy = (y - s.y) / s.ry;
          if (dx * dx + dy * dy <= 1) this.mask[cy * COLS + cx] = 1;
        }
      }
    }

    // Subsolo: carve caves below the surface.
    const caveRng = mulberry32(this.seed ^ 0x9e3779b9);
    const caveCount = Math.floor(6 + caveRng() * 8);
    for (let i = 0; i < caveCount; i += 1) {
      const cx = Math.floor(caveRng() * COLS);
      const cy = Math.floor((0.75 + caveRng() * 0.2) * ROWS);
      const r = 3 + Math.floor(caveRng() * 4);
      const r2 = r * r;
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (dx * dx + dy * dy > r2) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
          this.mask[y * COLS + x] = 0;
        }
      }
    }
  }

  surfaceY(x: number): number {
    return this.surfaceAt(x);
  }

  isSolid(px: number, py: number): boolean {
    if (px < 0 || py < 0 || px >= WORLD_W || py >= WORLD_H) return false;
    const cx = (px / CELL) | 0;
    const cy = (py / CELL) | 0;
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return false;
    return this.mask[cy * COLS + cx] === 1;
  }

  /** First solid y at x, scanning down from fromY for maxDown px. */
  groundY(x: number, fromY: number, maxDown = 260): number | null {
    if (x < 0 || x >= WORLD_W) return null;
    const start = Math.max(0, Math.floor(fromY / CELL));
    const end = Math.min(ROWS - 1, Math.ceil((fromY + maxDown) / CELL));
    const cx = Math.min(COLS - 1, Math.max(0, (x / CELL) | 0));
    for (let cy = start; cy <= end; cy += 1) {
      if (this.mask[cy * COLS + cx] === 1) return cy * CELL;
    }
    return null;
  }

  randomGroundX(rng: () => number, minX: number, maxX: number): { x: number; y: number } {
    for (let i = 0; i < 60; i += 1) {
      const x = minX + rng() * (maxX - minX);
      const y = this.groundY(x, 120, WATER_Y - 120);
      if (y !== null && y < WATER_Y - 40) return { x, y };
    }
    return { x: (minX + maxX) / 2, y: 480 };
  }

  carve(x: number, y: number, radius: number): void {
    const r2 = radius * radius;
    for (let cy = 0; cy < ROWS; cy += 1) {
      const wy = cy * CELL + CELL / 2;
      const dy = wy - y;
      if (Math.abs(dy) > radius) continue;
      for (let cx = 0; cx < COLS; cx += 1) {
        const wx = cx * CELL + CELL / 2;
        const dx = wx - x;
        if (dx * dx + dy * dy <= r2) this.mask[cy * COLS + cx] = 0;
      }
    }
    this.onCarve?.(x, y, radius);
  }
}
