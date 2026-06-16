/**
 * Redis-backed bot defense state manager.
 *
 * Replaces the in-memory Maps (ipHits, deviceHits, payloadHits, tokenAnomalyHits)
 * with Redis INCR + TTL counters. Redis handles expiration automatically, so no
 * manual cleanup routines are needed. Multiple API instances share the same state,
 * enabling horizontal scaling.
 *
 * Key schema:
 *   bot-defense:ip:<key>            — IP hit counter
 *   bot-defense:device:<key>        — device fingerprint hit counter
 *   bot-defense:payload:<key>       — payload signature hit counter
 *   bot-defense:token-anomaly:<key> — token anomaly hit counter
 */

const { getRedis } = require('../redis');
const privacyLogger = require('../utils/privacyLogger').default;

const KEY_PREFIX = 'bot-defense';
const parsedBotDefenseMapMaxEntries = Number.parseInt(process.env.BOT_DEFENSE_MAP_MAX_ENTRIES || '2000', 10);
const BOT_DEFENSE_MAP_MAX_ENTRIES = Number.isFinite(parsedBotDefenseMapMaxEntries) && parsedBotDefenseMapMaxEntries >= 500
  ? parsedBotDefenseMapMaxEntries
  : 2000;
const parsedBotDefenseMaxHitsPerKey = Number.parseInt(process.env.BOT_DEFENSE_MAX_HITS_PER_KEY || '120', 10);
const BOT_DEFENSE_MAX_HITS_PER_KEY = Number.isFinite(parsedBotDefenseMaxHitsPerKey) && parsedBotDefenseMaxHitsPerKey >= 20
  ? parsedBotDefenseMaxHitsPerKey
  : 120;

export type BotDefenseHitType = 'ip' | 'device' | 'payload' | 'token-anomaly';

type LocalFallbackState = Record<BotDefenseHitType, Map<string, number[]>>;

const localFallbackState: LocalFallbackState = {
  ip: new Map<string, number[]>(),
  device: new Map<string, number[]>(),
  payload: new Map<string, number[]>(),
  'token-anomaly': new Map<string, number[]>(),
};

function buildKey(type: BotDefenseHitType, key: string): string {
  return `${KEY_PREFIX}:${type}:${key}`;
}

function getFallbackMap(type: BotDefenseHitType): Map<string, number[]> {
  return localFallbackState[type];
}

function capHitsPerKey(hits: number[]): number[] {
  if (hits.length <= BOT_DEFENSE_MAX_HITS_PER_KEY) return hits;
  return hits.slice(-BOT_DEFENSE_MAX_HITS_PER_KEY);
}

function pruneLocalHitsForKey(hitMap: Map<string, number[]>, key: string, cutoff: number): number[] {
  const hits = hitMap.get(key) || [];
  if (hits.length === 0) return hits;

  const filtered = capHitsPerKey(hits.filter((ts) => ts >= cutoff));
  if (filtered.length === 0) {
    hitMap.delete(key);
    return [];
  }

  hitMap.set(key, filtered);
  return filtered;
}

function capFallbackMap(hitMap: Map<string, number[]>) {
  if (hitMap.size <= BOT_DEFENSE_MAP_MAX_ENTRIES) return;

  const targetEvictCount = Math.ceil(hitMap.size * 0.75);
  const iterator = hitMap.keys();
  let evicted = 0;
  let next = iterator.next();

  while (!next.done && evicted < targetEvictCount) {
    hitMap.delete(next.value);
    evicted += 1;
    next = iterator.next();
  }
}

function recordLocalHit(type: BotDefenseHitType, key: string, windowMs: number): number {
  const hitMap = getFallbackMap(type);
  const cutoff = Date.now() - windowMs;
  const hits = pruneLocalHitsForKey(hitMap, key, cutoff);
  hits.push(Date.now());
  hitMap.set(key, hits);
  capFallbackMap(hitMap);
  return hits.length;
}

function getLocalHitCount(type: BotDefenseHitType, key: string): number {
  const hitMap = getFallbackMap(type);
  const hits = hitMap.get(key);
  return hits ? hits.length : 0;
}

function clearLocalKey(type: BotDefenseHitType, key: string): void {
  getFallbackMap(type).delete(key);
}

function getLocalStats(): { ipHits: number; deviceHits: number; payloadHits: number; tokenAnomalyHits: number; } {
  return {
    ipHits: getFallbackMap('ip').size,
    deviceHits: getFallbackMap('device').size,
    payloadHits: getFallbackMap('payload').size,
    tokenAnomalyHits: getFallbackMap('token-anomaly').size,
  };
}

/**
 * Increment the hit counter for a given key and set/refresh its TTL.
 * Returns the new hit count after incrementing.
 *
 * On Redis failure, logs a warning and uses the bounded in-process fallback
 * counter instead so owner defense still enforces thresholds.
 */
export async function recordHit(type: BotDefenseHitType, key: string, windowMs: number): Promise<number> {
  const redisKey = buildKey(type, key);
  const ttlSeconds = Math.ceil(windowMs / 1000);

  try {
    const redis = getRedis();
    const count: number = await redis.incr(redisKey);
    if (count === 1) {
      try {
        await redis.expire(redisKey, ttlSeconds);
      } catch (expireErr: any) {
        privacyLogger.warn('[BotDefenseRedis] expire error after recordHit', {
          type,
          error: expireErr?.message || String(expireErr),
        });
      }
    }
    return count;
  } catch (err: any) {
    privacyLogger.warn('[BotDefenseRedis] recordHit error — using local fallback', {
      type,
      error: err?.message || String(err),
    });
    return recordLocalHit(type, key, windowMs);
  }
}

/**
 * Get the current hit count for a key without incrementing it.
 * Returns 0 if the key does not exist or on Redis failure.
 */
export async function getHitCount(type: BotDefenseHitType, key: string): Promise<number> {
  const redisKey = buildKey(type, key);
  try {
    const redis = getRedis();
    const val: string | null = await redis.get(redisKey);
    return val ? parseInt(val, 10) : 0;
  } catch (err: any) {
    privacyLogger.warn('[BotDefenseRedis] getHitCount error — using local fallback', {
      type,
      error: err?.message || String(err),
    });
    return getLocalHitCount(type, key);
  }
}

/**
 * Manually clear a hit counter (e.g. after a confirmed false-positive).
 */
export async function clearKey(type: BotDefenseHitType, key: string): Promise<void> {
  const redisKey = buildKey(type, key);
  try {
    const redis = getRedis();
    await redis.del(redisKey);
  } catch (err: any) {
    privacyLogger.warn('[BotDefenseRedis] clearKey error — clearing local fallback', {
      type,
      error: err?.message || String(err),
    });
    clearLocalKey(type, key);
  }
}

/**
 * Return approximate key counts for each hit type for monitoring/stats.
 * Uses Redis DBSIZE as a rough proxy — exact per-prefix counts would require
 * SCAN which is expensive. Falls back to the in-process counters on Redis failure.
 */
export async function getStats(): Promise<{
  ipHits: number;
  deviceHits: number;
  payloadHits: number;
  tokenAnomalyHits: number;
}> {
  try {
    const redis = getRedis();

    // Use SCAN to count keys per prefix. We cap at 10 000 iterations to avoid
    // blocking the event loop on very large keyspaces.
    const counts: Record<BotDefenseHitType, number> = {
      'ip': 0,
      'device': 0,
      'payload': 0,
      'token-anomaly': 0,
    };

    const types: BotDefenseHitType[] = ['ip', 'device', 'payload', 'token-anomaly'];

    await Promise.all(
      types.map(async (type) => {
        try {
          const pattern = `${KEY_PREFIX}:${type}:*`;
          let cursor = '0';
          let iterations = 0;
          const MAX_ITERATIONS = 100;

          do {
            const [nextCursor, keys]: [string, string[]] = await redis.scan(
              cursor,
              'MATCH',
              pattern,
              'COUNT',
              100,
            );
            cursor = nextCursor;
            counts[type] += keys.length;
            iterations += 1;
          } while (cursor !== '0' && iterations < MAX_ITERATIONS);
        } catch {
          counts[type] = getFallbackMap(type).size;
        }
      }),
    );

    return {
      ipHits: counts['ip'],
      deviceHits: counts['device'],
      payloadHits: counts['payload'],
      tokenAnomalyHits: counts['token-anomaly'],
    };
  } catch (err: any) {
    privacyLogger.warn('[BotDefenseRedis] getStats error — using local fallback', {
      error: err?.message || String(err),
    });
    return getLocalStats();
  }
}
