// 任务型端点：Midjourney / Suno / 视频
// 提交 → 写 D1 状态机 → 入队 Queues → 消费器轮询上游 → 客户端查询直读 D1
// 设计见 ARCHITECTURE.md §8（物理限制：以轮询替代 MJ 官方 WS 推送）
import { Env, db, kv } from '../config';
import { authenticate } from '../auth';
import { listChannelsForModel, selectChannel, getChannelKeys, pickKey } from '../channels';
import { json, errorResponse, nowUnix } from '../utils';
import { recordLog } from '../log';

interface TaskSubmission {
  type: 'mj' | 'suno' | 'video';
  action: string;
  channel: any;
  payload: any;
  callback?: string;
}

/** 提交任务 */
export async function submitTask(req: Request, env: Env, type: 'mj' | 'suno' | 'video', action: string): Promise<Response> {
  const auth = await authenticate(req, env, 'proxy');
  if (auth instanceof Response) return auth;
  const body = await req.json().catch(() => ({})) as any;
  // 选定渠道（按模型名/类型匹配）
  const channels = await listChannelsForModel(env, type === 'mj' ? 'midjourney' : type === 'suno' ? 'suno' : 'video', auth.groupId);
  const channel = selectChannel(channels);
  if (!channel) return errorResponse(`无可用 ${type} 渠道`, 404);
  const keys = await getChannelKeys(channel, env);
  const taskId = crypto.randomUUID();
  const now = nowUnix();
  await db(env).run(
    `INSERT INTO tasks (id, type, action, status, user_id, token_id, channel_id, progress, properties, result, callback, retry_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,0,?,?,?,0,?,?)`,
    [taskId, type, action, auth.userId, auth.tokenId, channel.id, JSON.stringify(body), '{}', body.callback || '', now, now]
  );
  // 调用上游提交接口
  const key = pickKey(keys);
  const upstreamUrl = buildSubmitUrl(channel.base_url, type, action, key);
  let upstreamId = '';
  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const uj = (await upstream.json().catch(() => ({}))) as any;
    upstreamId = uj.id || uj.taskId || uj.result || '';
  } catch (e) {
    await db(env).run(`UPDATE tasks SET status='fail', result=? WHERE id=?`, [JSON.stringify({ error: String(e) }), taskId]);
    return errorResponse('上游提交失败: ' + String(e), 502);
  }
  await db(env).run(`UPDATE tasks SET upstream_id=? WHERE id=?`, [upstreamId, taskId]);
  // 入队轮询
  try {
    await env.TASK_QUEUE.send({ taskId, type, action });
  } catch {
    /* 队列不可用则依赖 Cron 兜底 */
  }
  return json({ code: 0, message: 'submitted', data: { task_id: taskId, status: 'submitted' } }, 200);
}

/** 查询任务状态（直读 D1） */
export async function queryTask(env: Env, taskId: string): Promise<Response> {
  const row = await db(env).get<any>(`SELECT * FROM tasks WHERE id=?`, [taskId]);
  if (!row) return errorResponse('任务不存在', 404);
  return json({
    code: 0,
    message: 'success',
    data: {
      task_id: row.id,
      type: row.type,
      action: row.action,
      status: row.status,
      progress: row.progress,
      properties: JSON.parse(row.properties || '{}'),
      result: JSON.parse(row.result || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  });
}

/** MJ 兼容路由表（与原版 midjourney-proxy 接口对齐） */
export async function handleTasks(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  // 提交：/v1/mj/submit/<action>  /v1/suno/submit/<action>  /v1/video/submit/<action>
  const submitMatch = path.match(/\/v1\/(mj|suno|video)\/submit\/([\w-]+)/);
  if (submitMatch && req.method === 'POST') {
    return submitTask(req, env, submitMatch[1] as any, submitMatch[2]);
  }
  // 查询：/v1/mj/task/<id>  /v1/mj/task/<id>/fetch  /v1/task/<id>
  const queryMatch = path.match(/\/v1\/(?:mj|suno|video)\/task\/([\w-]+)/);
  if (queryMatch && req.method === 'GET') {
    return queryTask(env, queryMatch[1]);
  }
  return errorResponse(`未知任务端点 ${path}`, 404);
}

function buildSubmitUrl(base: string, type: string, action: string, key: string): string {
  const b = base.replace(/\/$/, '');
  if (type === 'mj') return `${b}/mj/submit/${action}`;
  if (type === 'suno') return `${b}/api/v1/suno/${action}`;
  return `${b}/v1/video/${action}`;
}
