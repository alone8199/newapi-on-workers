// 绑定与配置访问：集中暴露 Worker 环境变量与绑定
import { D1Store } from './storage/d1';
import { KVStore } from './storage/kv';
import { SessionStore } from './storage/session';

export interface Env {
  NEWAPI_KV: KVNamespace;
  NEWAPI_DB: D1Database;
  RELAY_DO: DurableObjectNamespace;
  QUOTA_DO: DurableObjectNamespace;
  TASK_QUEUE: Queue<any>;
  ASSETS: { fetch: (request: Request | string) => Promise<Response> };
  ENVIRONMENT?: string;
  DEFAULT_QUOTA?: string;
  MASTER_KEY?: string; // 用于加密渠道 key
  [key: string]: unknown;
}

export function kv(env: Env): KVStore {
  return new KVStore(env.NEWAPI_KV);
}
export function db(env: Env): D1Store {
  return new D1Store(env.NEWAPI_DB);
}
export function sessions(env: Env): SessionStore {
  return new SessionStore(kv(env), db(env));
}

/** 是否为生产环境（决定是否 Secure cookie） */
export function isProd(env: Env): boolean {
  return (env.ENVIRONMENT ?? 'production') === 'production';
}
