// NewAPI on Workers — 入口：路由分发 + Cron + Queue + 静态托管
import { Env } from './config';
import { setAccessSecret } from './utils';
import { handleV1 } from './routes/v1';
import { handlePg } from './routes/pg';
import { handleApi } from './routes/api';
import { handleTasks } from './routes/tasks';
import { RelayDurableObject } from '../do/relay-do';
import { QuotaAggregatorDO } from '../do/quota-do';
import { handleTaskQueue } from '../queues/task-consumer';

export { RelayDurableObject, QuotaAggregatorDO };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, cookie',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

/** 生成请求 ID（对齐原版 X-Oneapi-Request-Id；diff 阶段归一化该字段） */
function genRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return `${Date.now()}-${s}`;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const requestId = genRequestId();
    // 注入 access token 签名密钥（生产必须配置 AUTH_SECRET，见 wrangler.toml / .dev.vars.example）
    if (env.AUTH_SECRET) setAccessSecret(env.AUTH_SECRET);

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    let res: Response;
    try {
      if (path.startsWith('/api/')) {
        res = await handleApi(req, env, url);
      } else if (path.startsWith('/pg/')) {
        res = await handlePg(req, env, url);
      } else if (path === '/v1/realtime' || path === '/v1/responses/ws') {
        // WebSocket 经 Durable Object 托管（Realtime / Responses WebSocket）
        const id = env.RELAY_DO.idFromName('realtime-global');
        const stub = env.RELAY_DO.get(id);
        return stub.fetch(req);
      } else if (path.startsWith('/v1/mj/') || path.startsWith('/v1/suno/') || path.startsWith('/v1/video/')) {
        res = await handleTasks(req, env, url);
      } else if (path.startsWith('/v1/') || path.startsWith('/v1beta/')) {
        res = await handleV1(req, env, url);
      } else {
        // 静态资源 / SPA fallback（复用原版前端构建产物）
        res = await env.ASSETS.fetch(req);
      }
    } catch (e) {
      res = new Response(JSON.stringify({ error: { message: '内部错误: ' + String(e), type: 'internal_error', param: null, code: null } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 附加 CORS + 请求 ID（原版在 middleware 回带 X-Oneapi-Request-Id）。
    // 注意：上游/ASSETS fetch 返回的 Response.headers 是 immutable，不可就地 set；
    // 必须克隆为新 Response 并传入新的 Headers（流式 body 可直接透传）。
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    headers.set('X-Oneapi-Request-Id', requestId);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  },

  // Cron Triggers：清理过期 session、归档日志、重试失败任务
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;
    if (cron === '*/15 * * * *') {
      await cleanupSessions(env);
      await archiveOldLogs(env);
    } else if (cron === '23 3 * * *') {
      await retryFailedTasks(env);
    }
  },

  // Queues 消费器（任务型端点状态轮询/回调）
  async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleTaskQueue(batch, env);
  },
} as unknown as { fetch: any; scheduled: any; queue: any };

// ── Cron 任务实现 ──
async function cleanupSessions(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.NEWAPI_DB.prepare(`DELETE FROM user_sessions WHERE expires_at < ?`).bind(now).run();
}

async function archiveOldLogs(env: Env): Promise<void> {
  // 删除 > 30 天的日志（归档策略可改为搬移到冷表）
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  await env.NEWAPI_DB.prepare(`DELETE FROM logs WHERE request_time < ? AND success = 1 LIMIT 5000`).bind(cutoff).run();
}

async function retryFailedTasks(env: Env): Promise<void> {
  const rows = await env.NEWAPI_DB.prepare(
    `SELECT id FROM tasks WHERE status IN ('fail','timeout') AND retry_count < 5`
  ).all<{ id: string }>();
  for (const r of rows.results) {
    await env.TASK_QUEUE.send({ taskId: r.id, type: 'retry' }).catch(() => {});
  }
}
