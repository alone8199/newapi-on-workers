// 计费：预扣 / 结算 / 退款（D1 条件更新保证原子性；高频路径可经 DO 聚合）
// 设计见 ARCHITECTURE.md §7
import { Env, db } from './config';

export interface QuotaResult {
  ok: boolean;
  remain?: number;
}

/**
 * 预扣：按估算额度扣减 token 余额（非无限额时）。
 * 使用条件更新保证并发安全：remain_quota >= amount 才扣。
 */
export async function preDeduct(
  env: Env,
  tokenId: number,
  userId: number,
  amount: number,
  unlimited: boolean
): Promise<QuotaResult> {
  if (unlimited || amount <= 0) return { ok: true, remain: Infinity };
  const store = db(env);
  const ok = await store.conditionalUpdate(
    `UPDATE tokens SET remain_quota = remain_quota - ? WHERE id = ? AND remain_quota >= ?`,
    [amount, tokenId, amount]
  );
  if (!ok) return { ok: false };
  // 同步累计用户 used_quota（不回滚可扣减的精确性要求较低）
  await store.run(
    `UPDATE users SET used_quota = used_quota + ? WHERE id = ?`,
    [amount, userId]
  );
  const row = await store.get<{ remain_quota: number }>(
    `SELECT remain_quota FROM tokens WHERE id = ?`,
    [tokenId]
  );
  return { ok: true, remain: row?.remain_quota };
}

/**
 * 结算：流结束或请求完成后，按真实用量多退少补。
 * 若 real < pre，退款 (pre - real)；若 real > pre，补扣（再条件更新）。
 */
export async function settle(
  env: Env,
  tokenId: number,
  userId: number,
  preAmount: number,
  realAmount: number,
  unlimited: boolean
): Promise<QuotaResult> {
  if (unlimited) return { ok: true, remain: Infinity };
  const diff = realAmount - preAmount;
  const store = db(env);
  if (diff === 0) {
    const r = await store.get<{ remain_quota: number }>(`SELECT remain_quota FROM tokens WHERE id = ?`, [tokenId]);
    return { ok: true, remain: r?.remain_quota };
  }
  if (diff < 0) {
    // 退款
    await store.run(`UPDATE tokens SET remain_quota = remain_quota + ? WHERE id = ?`, [-diff, tokenId]);
    await store.run(`UPDATE users SET used_quota = used_quota - ? WHERE id = ?`, [-diff, userId]);
  } else {
    // 补扣（条件更新防超额）
    const ok = await store.conditionalUpdate(
      `UPDATE tokens SET remain_quota = remain_quota - ? WHERE id = ? AND remain_quota >= ?`,
      [diff, tokenId, diff]
    );
    if (!ok) return { ok: false };
    await store.run(`UPDATE users SET used_quota = used_quota + ? WHERE id = ?`, [diff, userId]);
  }
  const r = await store.get<{ remain_quota: number }>(`SELECT remain_quota FROM tokens WHERE id = ?`, [tokenId]);
  return { ok: true, remain: r?.remain_quota };
}

/**
 * 中途断开退款：按已用部分结算（preAmount 为预扣，realAmount 为实际已用）。
 * 等价于 settle 但明确来自流 cancel/error。
 */
export async function refundOrSettle(
  env: Env,
  tokenId: number,
  userId: number,
  preAmount: number,
  realAmount: number,
  unlimited: boolean
): Promise<void> {
  await settle(env, tokenId, userId, preAmount, Math.min(preAmount, realAmount), unlimited);
}

/**
 * 计算请求计费额度：基于 usage × 模型单价 × 分组倍率。
 */
export function computeQuota(
  promptTokens: number,
  completionTokens: number,
  modelPrice: { prompt?: number; completion?: number } | undefined,
  groupRatio: number
): number {
  const p = (promptTokens * (modelPrice?.prompt ?? 0)) / 1000;
  const c = (completionTokens * (modelPrice?.completion ?? 0)) / 1000;
  return Math.ceil((p + c) * groupRatio * 1000) / 1000 * 1000; // 以 token 为单位存储（NewAPI 习惯）
}

/** 取得分组倍率 */
export async function getGroupRatio(env: Env, groupId: string): Promise<number> {
  const row = await db(env).get<{ ratio: number }>(`SELECT ratio FROM groups WHERE name = ?`, [groupId]);
  return row?.ratio ?? 1;
}
