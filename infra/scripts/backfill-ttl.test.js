'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { baseMs, isLegacyMeta, isLegacyParent, ONLINE_TTL_SECONDS } = require('./backfill-ttl.js');

test('baseMs prefers createdAt then falls back to now', () => {
  const t = Date.parse('2026-01-10T00:00:00.000Z');
  assert.equal(baseMs({ createdAt: '2026-01-10T00:00:00.000Z', at: '2026-02-01T00:00:00.000Z' }), t);
  assert.equal(baseMs({ at: '2026-02-01T00:00:00.000Z' }), Date.parse('2026-02-01T00:00:00.000Z'));
  const before = Date.now();
  const fallback = baseMs({ createdAt: 'not-a-date' });
  assert.ok(fallback >= before && fallback <= Date.now());
});

test('legacy check skips v1 but backfills orphans', () => {
  assert.equal(isLegacyMeta({ actionLogVersion: 2 }), false);
  assert.equal(isLegacyMeta({ actionLogVersion: 1 }), true);
  assert.equal(isLegacyMeta({}), true);
  assert.equal(isLegacyParent({ actionLogVersion: 2 }), false);
  assert.equal(isLegacyParent({ actionLogVersion: 1 }), true);
  assert.equal(isLegacyParent(undefined), false);
});

test('TTL window is 30 days in epoch seconds', () => {
  assert.equal(ONLINE_TTL_SECONDS, 30 * 24 * 60 * 60);
  const item = { createdAt: '2026-01-10T00:00:00.000Z' };
  const expiresAt = Math.floor(baseMs(item) / 1000) + ONLINE_TTL_SECONDS;
  assert.equal(expiresAt - Math.floor(Date.parse(item.createdAt) / 1000), ONLINE_TTL_SECONDS);
});
