import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Data-source API keys are `<sourceId>.<hmac>` where hmac = HMAC-SHA256(secret, sourceId).
 * Provisioning a new source needs only the secret; verification needs no DB lookup
 * and the key binds the connection to exactly one source id (no spoofing other cars).
 */
export function apiKeyFor(sourceId, secret) {
  return `${sourceId}.${createHmac('sha256', secret).update(sourceId).digest('hex').slice(0, 32)}`;
}

export function verifyApiKey(key, secret) {
  if (typeof key !== 'string' || key.length > 80) return null;
  const dot = key.lastIndexOf('.');
  if (dot <= 0) return null;
  const sourceId = key.slice(0, dot);
  if (!/^[A-Za-z0-9-]{1,24}$/.test(sourceId)) return null;
  const expected = Buffer.from(apiKeyFor(sourceId, secret));
  const given = Buffer.from(key);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return sourceId;
}
