import Redis from 'ioredis';
import type { DefenseStore, ListEntry, ListKind, StoreBackend, WindowCount } from './types';

class Bag {
  lists: Record<ListKind, ListEntry[]> = { allow: [], deny: [] };
  meta = new Map<string, string>();

  list(kind: ListKind): ListEntry[] {
    return [...this.lists[kind]];
  }

  put(entry: ListEntry): void {
    const rows = this.lists[entry.kind].filter((row) => row.id !== entry.id);
    rows.push(entry);
    this.lists[entry.kind] = rows;
  }

  delete(kind: ListKind, id: string): boolean {
    const before = this.lists[kind].length;
    this.lists[kind] = this.lists[kind].filter((row) => row.id !== id);
    return this.lists[kind].length !== before;
  }
}

interface MemoryBucket {
  hits: Map<string, number[]>;
  uniques: Map<string, number>;
}

export class MemoryStore implements DefenseStore {
  private buckets = new Map<string, MemoryBucket>();
  private maxKeys: number;
  private bag = new Bag();

  constructor(maxKeys = 5000) {
    this.maxKeys = maxKeys;
  }

  backend(): StoreBackend {
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

  async seenOnce(bucket: string, key: string, ttlMs: number): Promise<{ first: boolean; backend: StoreBackend }> {
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

  async list(kind: ListKind): Promise<ListEntry[]> {
    return this.bag.list(kind);
  }

  async putList(entry: ListEntry): Promise<void> {
    this.bag.put(entry);
  }

  async deleteList(kind: ListKind, id: string): Promise<boolean> {
    return this.bag.delete(kind, id);
  }

  async getMeta(key: string): Promise<string | null> {
    return this.bag.meta.get(key) ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.bag.meta.set(key, value);
  }

  bagView(): Bag {
    return this.bag;
  }

  replaceBag(bag: Bag): void {
    this.bag = bag;
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

  backend(): StoreBackend {
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

  async seenOnce(bucket: string, key: string, ttlMs: number): Promise<{ first: boolean; backend: StoreBackend }> {
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

  private async readBag(): Promise<Bag> {
    if (!this.usingRedis) return this.fallbackBag();
    try {
      const raw = await this.redis.get(this.key(['bag']));
      if (!raw) return new Bag();
      const parsed = JSON.parse(raw) as { lists: Record<ListKind, ListEntry[]>; meta: Record<string, string> };
      const bag = new Bag();
      bag.lists = parsed.lists || { allow: [], deny: [] };
      bag.meta = new Map(Object.entries(parsed.meta || {}));
      return bag;
    } catch {
      this.usingRedis = false;
      return this.fallbackBag();
    }
  }

  private fallbackBag(): Bag {
    return (this.fallback as MemoryStore).bagView();
  }

  private async writeBag(bag: Bag): Promise<void> {
    if (!this.usingRedis) {
      (this.fallback as MemoryStore).replaceBag(bag);
      return;
    }
    try {
      await this.redis.set(
        this.key(['bag']),
        JSON.stringify({ lists: bag.lists, meta: Object.fromEntries(bag.meta) }),
      );
    } catch {
      this.usingRedis = false;
      (this.fallback as MemoryStore).replaceBag(bag);
    }
  }

  async list(kind: ListKind): Promise<ListEntry[]> {
    return (await this.readBag()).list(kind);
  }

  async putList(entry: ListEntry): Promise<void> {
    const bag = await this.readBag();
    bag.put(entry);
    await this.writeBag(bag);
  }

  async deleteList(kind: ListKind, id: string): Promise<boolean> {
    const bag = await this.readBag();
    const removed = bag.delete(kind, id);
    await this.writeBag(bag);
    return removed;
  }

  async getMeta(key: string): Promise<string | null> {
    return (await this.readBag()).meta.get(key) ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    const bag = await this.readBag();
    bag.meta.set(key, value);
    await this.writeBag(bag);
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
  backend?: 'memory' | 'redis' | 'postgres' | 'sqlite';
  postgresUrl?: string;
  sqlitePath?: string;
}): Promise<DefenseStore> {
  const backend = opts.backend || (opts.redisUrl ? 'redis' : 'memory');
  if (backend === 'sqlite') {
    const { openSqlite } = await import('./sqlStore');
    if (!opts.sqlitePath) throw new Error('FCGBDS_SQLITE_PATH is required when FCGBDS_STORE=sqlite');
    return openSqlite(opts.sqlitePath);
  }
  if (backend === 'postgres') {
    const { openPostgres } = await import('./sqlStore');
    if (!opts.postgresUrl) throw new Error('FCGBDS_POSTGRES_URL is required when FCGBDS_STORE=postgres');
    return openPostgres(opts.postgresUrl);
  }
  if (backend === 'redis') {
    if (!opts.redisUrl) throw new Error('REDIS_URL is required when FCGBDS_STORE=redis');
    const store = new RedisStore(opts.redisUrl, opts.prefix, opts.maxKeys);
    await store.connect();
    return store;
  }
  return new MemoryStore(opts.maxKeys);
}
