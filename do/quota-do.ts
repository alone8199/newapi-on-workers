// QuotaAggregatorDO：高频额度扣减串行化聚合器
// 以 userId 为 DO ID，单实例串行处理该用户的所有扣减，缓解 D1 写放大。
// 设计见 ARCHITECTURE.md §7（方案 B）。不替代 D1 权威性，仅做写合并。

interface Env {
  NEWAPI_DB: D1Database;
}

interface DeductMsg {
  tokenId: number;
  userId: number;
  amount: number;
}

export class QuotaAggregatorDO {
  private state: DurableObjectState;
  private env: Env;
  private pending: DeductMsg[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method === 'POST') {
      const msg = (await req.json().catch(() => ({}))) as DeductMsg;
      this.pending.push(msg);
      // 触发聚合落盘（alarm 或立即批处理）
      if (this.pending.length >= 10) {
        await this.flush();
      } else {
        this.state.waitUntil(this.scheduleFlush());
      }
      return new Response(JSON.stringify({ ok: true, queued: this.pending.length }), { status: 200 });
    }
    return new Response('Method not allowed', { status: 405 });
  }

  private async scheduleFlush(): Promise<void> {
    // 简单退避批量：300ms 后聚合（避免每笔都写 D1）
    await new Promise((r) => setTimeout(r, 300));
    if (this.pending.length) await this.flush();
  }

  private async flush(): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length);
    // 按 token 聚合
    const byToken = new Map<number, number>();
    for (const m of batch) byToken.set(m.tokenId, (byToken.get(m.tokenId) || 0) + m.amount);
    for (const [tokenId, total] of byToken) {
      await this.env.NEWAPI_DB.prepare(
        `UPDATE tokens SET remain_quota = remain_quota - ? WHERE id = ? AND remain_quota >= ?`
      ).bind(total, tokenId, total).run();
    }
  }
}
