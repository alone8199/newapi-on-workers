// 绑定与配置访问：集中暴露 Worker 环境变量与绑定
import { D1Store } from './storage/d1';
import { KVStore } from './storage/kv';

export interface Env {
  NEWAPI_KV: KVNamespace;
  NEWAPI_DB: D1Database;
  RELAY_DO: DurableObjectNamespace;
  QUOTA_DO: DurableObjectNamespace;
  TASK_QUEUE: Queue<any>;
  ASSETS: { fetch: (request: Request | string) => Promise<Response> };
  ENVIRONMENT?: string;
  DEFAULT_QUOTA?: string;
  MASTER_KEY?: string;   // 用于加密渠道 key
  AUTH_SECRET?: string;  // 用于 HMAC 签名 access token（生产必须配置）
  [key: string]: unknown;
}

export function kv(env: Env): KVStore {
  return new KVStore(env.NEWAPI_KV);
}
export function db(env: Env): D1Store {
  return new D1Store(env.NEWAPI_DB);
}
