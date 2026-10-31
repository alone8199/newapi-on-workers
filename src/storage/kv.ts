// KV 封装：统一 key 规范与 TTL（见 ARCHITECTURE.md §4）
// KV 仅做缓存/配置；写入后主动失效对应 key

export type KVNamespaceLike = KVNamespace;

export const TTL = {
  OPTION: 3600,
  OPTIONS_ALL: 3600,
  PRICING_ALL: 86400,
  SESSION: 2592000, // 30d
  TOKEN_USER: 600,
  CHANNEL_CACHE: 300,
  MODEL_LIST: 300,
  RATE_FAIL: 60,
} as const;

export class KVStore {
  constructor(private kv: KVNamespace) {}

  // ── 系统 Options ──
  async getOption(key: string): Promise<string | null> {
    return this.kv.get(`option:${key}`);
  }
  async setOption(key: string, value: string): Promise<void> {
    await this.kv.put(`option:${key}`, value, { expirationTtl: TTL.OPTION });
  }
  async deleteOption(key: string): Promise<void> {
    await this.kv.delete(`option:${key}`);
  }

  // ── 全量配置快照 ──
  async getAllOptions(): Promise<Record<string, string>> {
    const raw = await this.kv.get('options:all', 'json');
    return (raw as Record<string, string>) ?? {};
  }
  async setAllOptions(map: Record<string, string>): Promise<void> {
    await this.kv.put('options:all', JSON.stringify(map), {
      expirationTtl: TTL.OPTIONS_ALL,
    });
  }

  // ── 模型倍率 ──
  async setPricing(map: Record<string, number>): Promise<void> {
    await this.kv.put('pricing:all', JSON.stringify(map), {
      expirationTtl: TTL.PRICING_ALL,
    });
  }
  async getPricing(): Promise<Record<string, number>> {
    const raw = await this.kv.get('pricing:all', 'json');
    return (raw as Record<string, number>) ?? {};
  }

  // ── Session（带 TTL） ──
  async putSession(id: string, value: unknown): Promise<void> {
    await this.kv.put(`session:${id}`, JSON.stringify(value), {
      expirationTtl: TTL.SESSION,
    });
  }
  async getSession<T = Record<string, unknown>>(id: string): Promise<T | null> {
    const raw = await this.kv.get(`session:${id}`, 'json');
    return (raw as T) ?? null;
  }
  async deleteSession(id: string): Promise<void> {
    await this.kv.delete(`session:${id}`);
  }

  // ── token → user 映射缓存 ──
  async putTokenUser(hash: string, userId: number): Promise<void> {
    await this.kv.put(`token:user:${hash}`, String(userId), {
      expirationTtl: TTL.TOKEN_USER,
    });
  }
  async getTokenUser(hash: string): Promise<number | null> {
    const v = await this.kv.get(`token:user:${hash}`);
    return v ? Number(v) : null;
  }
  async deleteTokenUser(hash: string): Promise<void> {
    await this.kv.delete(`token:user:${hash}`);
  }

  // ── 渠道缓存 ──
  async putChannel(id: number, value: unknown): Promise<void> {
    await this.kv.put(`channel:cache:${id}`, JSON.stringify(value), {
      expirationTtl: TTL.CHANNEL_CACHE,
    });
  }
  async getChannel<T = Record<string, unknown>>(id: number): Promise<T | null> {
    const raw = await this.kv.get(`channel:cache:${id}`, 'json');
    return (raw as T) ?? null;
  }
  async deleteChannel(id: number): Promise<void> {
    await this.kv.delete(`channel:cache:${id}`);
  }

  // ── 通用 JSON 缓存（任意 key，带 TTL） ──
  async cacheGet<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key, 'json');
    return (raw as T) ?? null;
  }
  async cacheSet(key: string, value: unknown, ttl: number): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  }
  async cacheDel(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  // ── 模型列表缓存 ──
  async putModelList(group: string, value: unknown): Promise<void> {
    await this.kv.put(`model:list:${group}`, JSON.stringify(value), {
      expirationTtl: TTL.MODEL_LIST,
    });
  }
  async getModelList<T = unknown[]>(group: string): Promise<T | null> {
    const raw = await this.kv.get(`model:list:${group}`, 'json');
    return (raw as T) ?? null;
  }
  async deleteModelList(group: string): Promise<void> {
    await this.kv.delete(`model:list:${group}`);
  }

  // ── 渠道失败计数（短 TTL） ──
  async incrFail(channelId: number): Promise<number> {
    const key = `rate:fail:${channelId}`;
    const cur = Number((await this.kv.get(key)) ?? '0');
    const next = cur + 1;
    await this.kv.put(key, String(next), { expirationTtl: TTL.RATE_FAIL });
    return next;
  }
  async resetFail(channelId: number): Promise<void> {
    await this.kv.delete(`rate:fail:${channelId}`);
  }
}
