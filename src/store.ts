import Redis from 'ioredis';
import type { DefenseStore, WindowCount } from './types';

interface MemoryBucket {
  hits: Map<string, number[]>;
  uniques: Map<string, number>;
}

export class MemoryStore implements DefenseStore {
  private buckets = new Map<string, MemoryBucket>();
  private maxKeys: number;

  constructor(maxKeys = 5000) {
    this.maxKeys = maxKeys;
  }

  backend(): 'redis' | 'memory' {
    return 'memory';
  }

  private bucket(name: string): MemoryBucket {
    let b = this.buckets.get(name);
    if (!b) {
      b = { hits: new Map(), uniques: new Map() };
      this.buckets.set(name, b);
    }
    return b;
  }

  private cap(map: Map<string, unknown>): void {
    if (map.size <= this.maxKeys) return;
    const drop = Math.ceil(map.size * 0.25);
    const keys = map.keys();
    for (let i = 0; i < drop; i += 1) {
      const next = keys.next();
      if (next.done) break;
      map.delete(next.value);
    }
  }

  async incrementWindow(bucket: string, key: string, windowMs: number, now: number): Promise<WindowCount> {
    const b = this.bucket(bucket);
    const cutoff = now - windowMs;
    const prev = (b.hits.get(key) || []).filter((ts) => ts >= cutoff);
    prev.push(now);
    b.hits.set(key, prev.slice(-200));
    this.cap(b.hits);
    return { count: prev.length, backend: 'memory' };
  }

  async seenOnce(bucket: string, key: string, ttlMs: number): Promise<{ first: boolean; backend: 'redis' | 'memory' }> {
    const b = this.bucket(bucket);
    const now = Date.now();
    const expires = b.uniques.get(key);
    if (expires && expires > now) {
      return { first: false, backend: 'memory' };
    }
    b.uniques.set(key, now + ttlMs);
    this.cap(b.uniques);
    return { first: true, backend: 'memory' };
  }

  async close(): Promise<void> {
    this.buckets.clear();
  }
}

export class RedisStore implements DefenseStore {
  private redis: Redis;
  private prefix: string;
  private fallback: MemoryStore;
  private usingRedis = true;

  constructor(url: string, prefix: string, maxKeys: number) {
    this.prefix = prefix;
    this.fallback = new MemoryStore(maxKeys);
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', () => {
      this.usingRedis = false;
    });
  }

  backend(): 'redis' | 'memory' {
    return this.usingRedis ? 'redis' : 'memory';
  }

  async connect(): Promise<void> {
    try {
      await this.redis.connect();
      this.usingRedis = true;
    } catch {
      this.usingRedis = false;
    }
  }

  private key(parts: string[]): string {
    return [this.prefix, ...parts].join(':');
  }

  async incrementWindow(bucket: string, key: string, windowMs: number, now: number): Promise<WindowCount> {
    if (!this.usingRedis) {
      return this.fallback.incrementWindow(bucket, key, windowMs, now);
    }
    try {
      const redisKey = this.key(['win', bucket, key]);
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.pexpire(redisKey, windowMs);
      }
      return { count, backend: 'redis' };
    } catch {
      this.usingRedis = false;
      return this.fallback.incrementWindow(bucket, key, windowMs, now);
    }
  }

  async seenOnce(bucket: string, key: string, ttlMs: number): Promise<{ first: boolean; backend: 'redis' | 'memory' }> {
    if (!this.usingRedis) {
      return this.fallback.seenOnce(bucket, key, ttlMs);
    }
    try {
      const redisKey = this.key(['once', bucket, key]);
      const result = await this.redis.set(redisKey, '1', 'PX', ttlMs, 'NX');
      return { first: result === 'OK', backend: 'redis' };
    } catch {
      this.usingRedis = false;
      return this.fallback.seenOnce(bucket, key, ttlMs);
    }
  }

  async close(): Promise<void> {
    try {
      this.redis.disconnect();
    } catch {
      /* ignore */
    }
    await this.fallback.close();
  }
}

export async function createStore(opts: {
  redisUrl?: string;
  prefix: string;
  maxKeys: number;
}): Promise<DefenseStore> {
  if (!opts.redisUrl) {
    return new MemoryStore(opts.maxKeys);
  }
  const store = new RedisStore(opts.redisUrl, opts.prefix, opts.maxKeys);
  await store.connect();
  return store;
}
