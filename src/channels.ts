// 渠道路由：加权选择 + 故障切换 + 多 Key 轮询 + 上游协议映射
import { Env, db, kv } from './config';
import { decryptSecret } from './utils';
import { TTL } from './storage/kv';
import type { ProtocolName } from './protocols/types';

// 渠道类型枚举（与 NewAPI 对齐的关键值）
export const ChannelType = {
  OPENAI: 1,
  AZURE: 2,
  CLAUDE: 3,
  GEMINI: 4,
  BEDROCK: 5,
  OLLAMA: 7,
  VLLM: 8,
  SGLANG: 9,
} as const;

export interface ChannelRow {
  id: number;
  type: number;
  name: string;
  key: string; // 加密后的多 Key JSON 字符串
  base_url: string;
  other: string;
  models: string;
  group_id: string;
  weight: number;
  retry_times: number;
  test_model: string;
  auto_ban: number;
}

/** 渠道类型 -> 上游原生协议（用于转换矩阵目标） */
export function channelToProtocol(type: number): ProtocolName {
  switch (type) {
    case ChannelType.CLAUDE:
      return 'claude';
    case ChannelType.GEMINI:
      return 'gemini';
    default:
      // OpenAI / Azure / Bedrock(Claude 走 claude) / Ollama / vLLM / SGLang 均 OpenAI 兼容
      return 'openai';
  }
}

/** 列出能服务某模型且状态正常的渠道（带分组过滤与 KV 缓存） */
export async function listChannelsForModel(
  env: Env,
  model: string,
  groupId: string
): Promise<ChannelRow[]> {
  const cacheKey = `ml:${model}:${groupId}`;
  const cached = await kv(env).cacheGet<ChannelRow[]>(cacheKey);
  if (cached) return cached;
  const rows = await db(env).all<ChannelRow>(
    `SELECT id, type, name, key, base_url, other, models, "group" AS group_id, weight, retry_times, test_model, auto_ban
     FROM channels WHERE status = 1 AND disabled_by_failure = 0 AND models LIKE ?`,
    [`%${model}%`]
  );
  const filtered = rows.filter(
    (c) => c.group_id === '' || c.group_id === groupId || c.group_id.split(',').includes(groupId)
  );
  await kv(env).cacheSet(cacheKey, filtered, TTL.MODEL_LIST);
  return filtered;
}

/** 加权随机选择渠道（weight=0 退化为等权） */
export function selectChannel(channels: ChannelRow[]): ChannelRow | null {
  if (!channels.length) return null;
  const total = channels.reduce((s, c) => s + Math.max(1, c.weight), 0);
  let r = Math.random() * total;
  for (const c of channels) {
    r -= Math.max(1, c.weight);
    if (r <= 0) return c;
  }
  return channels[channels.length - 1];
}

/** 解密并解析渠道多 Key，返回数组
 * 原版 Channel.Key 为换行分隔纯文本（model/channel.go: strings.Split(key,"\n")）；
 * 兼容 Worker 早期 JSON 数组格式，以及启用 MASTER_KEY 时的 AES-GCM 密文。 */
export async function getChannelKeys(channel: ChannelRow, env: Env): Promise<string[]> {
  let raw = channel.key || '';
  if (env.MASTER_KEY) {
    try { raw = await decryptSecret(raw, env.MASTER_KEY); } catch { /* 明文或旧格式 */ }
  }
  if (!raw) return [];
  // 优先按原版换行分隔解析
  if (raw.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
    } catch { /* 落到换行解析 */ }
  }
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 轮询选 Key（简单随机，可替换为 sticky 哈希） */
export function pickKey(keys: string[]): string {
  return keys[Math.floor(Math.random() * keys.length)];
}

/** 标记渠道失败（连续失败计数 + 自动禁用） */
export async function markChannelFailure(env: Env, channelId: number): Promise<void> {
  const fails = await kv(env).incrFail(channelId);
  // 连续失败 5 次则临时禁用（auto_ban 在渠道记录中，查询后判断；此处做保守禁用）
  if (fails >= 5) {
    await db(env).run(`UPDATE channels SET disabled_by_failure = 1 WHERE id = ? AND auto_ban = 1`, [channelId]);
    await kv(env).deleteChannel(channelId);
  }
}

/** 标记渠道失败（连续失败计数 + 自动禁用） */
export async function resetChannelFailure(env: Env, channelId: number): Promise<void> {
  await kv(env).resetFail(channelId);
}
