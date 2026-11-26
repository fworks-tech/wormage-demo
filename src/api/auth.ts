export interface AuthSession {
  token: string;
  playerId: string;
  expiresAt: string;
}

const AUTH_KEY = 'wormage.auth.v1';
const AUTH_TTL_SECONDS = 180 * 24 * 60 * 60;
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_ISSUER = 'wormage';
const AUTH_AUDIENCE = 'wormage-client';
// Mock-only key. Production tokens are signed with the Secrets Manager value.
const MOCK_SECRET = 'wormage-local-mock-secret-0123456789abcdef';
const encoder = new TextEncoder();

type HeaderBag = { get(name: string): string | null | undefined } | Record<string, unknown>;
type AuthMode = 'observe' | 'enforce';

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
}

function encodeJson(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

async function mockKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(MOCK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function headerValue(headers: HeaderBag | undefined, name: string): string | null {
  if (!headers) return null;
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name) ?? null;
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? record[key] : null;
  return typeof value === 'string' ? value : null;
}

export async function createMockSession(playerId?: string, now = Date.now()): Promise<AuthSession> {
  const id = playerId ?? `player-${base64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  const iat = Math.floor(now / 1000);
  const exp = iat + AUTH_TTL_SECONDS;
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({ sub: id, iat, exp, iss: AUTH_ISSUER, aud: AUTH_AUDIENCE });
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await mockKey(), encoder.encode(`${header}.${payload}`))));
  return { token: `${header}.${payload}.${signature}`, playerId: id, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyMockToken(token: string, now = Date.now()): Promise<string | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(new TextDecoder().decode(decodeBase64url(headerPart))) as { alg?: string; typ?: string };
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(payloadPart))) as {
      sub?: string; iat?: number; exp?: number; iss?: string; aud?: string;
    };
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    if (payload.iss !== AUTH_ISSUER || payload.aud !== AUTH_AUDIENCE || typeof payload.sub !== 'string' || !/^player-[A-Za-z0-9_-]{1,100}$/.test(payload.sub)) return null;
    const exp = payload.exp;
    if (typeof payload.iat !== 'number' || !Number.isInteger(payload.iat) || typeof exp !== 'number' || !Number.isInteger(exp) || exp <= Math.floor(now / 1000) || payload.iat > Math.floor(now / 1000) + 60) return null;
    const valid = await crypto.subtle.verify('HMAC', await mockKey(), decodeBase64url(signaturePart), encoder.encode(`${headerPart}.${payloadPart}`));
    return valid ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function createMockSessionFromHeaders(headers: HeaderBag | undefined): Promise<AuthSession | null> {
  const authorization = headerValue(headers, 'authorization');
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return createMockSession();
  const playerId = await verifyMockToken(token);
  return playerId ? createMockSession(playerId) : null;
}

export async function mockAuth(
  headers: HeaderBag | undefined,
  claimedPlayerId?: string,
  mode: AuthMode = import.meta.env.VITE_AUTH_MODE === 'enforce' ? 'enforce' : 'observe',
): Promise<{ playerId?: string; status?: number }> {
  const authorization = headerValue(headers, 'authorization');
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const playerId = token ? await verifyMockToken(token) : null;
  if (!playerId) return mode === 'enforce' ? { status: 401 } : { playerId: claimedPlayerId };
  if (claimedPlayerId && claimedPlayerId !== playerId) return { status: 403 };
  return { playerId };
}

export function loadAuthSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if (typeof parsed.token !== 'string' || !parsed.token || typeof parsed.playerId !== 'string' || !/^player-[A-Za-z0-9_-]{1,100}$/.test(parsed.playerId)) return null;
    if (typeof parsed.expiresAt !== 'string' || !Number.isFinite(Date.parse(parsed.expiresAt))) return null;
    return { token: parsed.token, playerId: parsed.playerId, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function saveAuthSession(session: AuthSession): boolean {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearAuthSession(): void {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    // ignore
  }
}

export function authSessionNeedsRefresh(session: AuthSession, now = Date.now()): boolean {
  return Date.parse(session.expiresAt) - now <= REFRESH_WINDOW_MS;
}
