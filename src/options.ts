// 系统 Options 读取：KV 为缓存、D1 为权威。
// getAllOptions 只读 KV 快照，冷启动/缓存过期时为空 → 必须回退 D1 并回填，
// 否则首次请求会把「未配置」误判成「关闭」（如 PasswordLoginEnabled 原版默认 true）。
import { Env, db, kv } from './config';

/** 加载全量 Options（KV 缓存未命中时回退 D1 并回填缓存） */
export async function loadOptions(env: Env): Promise<Record<string, string>> {
  const cached = await kv(env).getAllOptions();
  if (cached && Object.keys(cached).length) return cached;
  const rows = await db(env).all<{ key: string; value: string }>(`SELECT key, value FROM options`);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  if (Object.keys(map).length) await kv(env).setAllOptions(map);
  return map;
}

/** 读取单个 Option，未配置时返回 defaultValue（对齐原版各开关默认值） */
export async function getOption(env: Env, key: string, defaultValue = ''): Promise<string> {
  const all = await loadOptions(env);
  return all[key] ?? defaultValue;
}

/** 布尔 Option：原版多为 'true'/'false' 字符串，未配置时用 defaultValue */
export async function getBoolOption(env: Env, key: string, defaultValue: boolean): Promise<boolean> {
  const v = await getOption(env, key, defaultValue ? 'true' : 'false');
  return v === 'true' || v === '1';
}
