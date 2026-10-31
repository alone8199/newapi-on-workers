// TASK_QUEUE 消费器：任务型端点（Midjourney/Suno/视频）状态轮询与回调
// 设计见 ARCHITECTURE.md §8。以轮询替代 MJ 官方 WS 推送（物理限制已标注）。
import { Env, db, kv } from '../src/config';
import { listChannelsForModel, selectChannel, getChannelKeys, pickKey } from '../src/channels';
import { nowUnix } from '../src/utils';

export async function handleTaskQueue(batch: MessageBatch<any>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const { taskId, type } = msg.body as { taskId: string; type: string };
    try {
      await processTask(taskId, type, env);
      msg.ack();
    } catch (e) {
      // 失败退避重试（Queues 自带重试 + DLQ）
      msg.retry();
    }
  }
}

async function processTask(taskId: string, _type: string, env: Env): Promise<void> {
  const task = await db(env).get<any>(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
  if (!task) return;
  if (task.status === 'success') return;
  if (task.retry_count >= 10) {
    await db(env).run(`UPDATE tasks SET status='timeout' WHERE id=?`, [taskId]);
    return;
  }
  const channel = await db(env).get<any>(`SELECT * FROM channels WHERE id = ?`, [task.channel_id]);
  if (!channel) return;
  const keys = await getChannelKeys(channel, env);
  const key = pickKey(keys);
  const queryUrl = buildQueryUrl(channel.base_url, task.type, task.upstream_id, key);
  let upstream: any = {};
  try {
    const resp = await fetch(queryUrl, {
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    });
    upstream = await resp.json().catch(() => ({}));
  } catch {
    await db(env).run(`UPDATE tasks SET retry_count = retry_count + 1 WHERE id=?`, [taskId]);
    return;
  }
  const { status, progress, result } = normalizeUpstream(task.type, upstream);
  const now = nowUnix();
  await db(env).run(
    `UPDATE tasks SET status=?, progress=?, result=?, updated_at=?, retry_count = retry_count + 1 WHERE id=?`,
    [status, progress, JSON.stringify(result), now, taskId]
  );
  if (status === 'success') {
    // 回调
    if (task.callback) {
      await fetch(task.callback, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, status, result }),
      }).catch(() => {});
    }
  } else if (status === 'fail') {
    // 失败不重试（已是终态）
  } else {
    // 未完成：重新入队（带退避由 Queues 处理）
    await env.TASK_QUEUE.send({ taskId, type: task.type }).catch(() => {});
  }
}

function buildQueryUrl(base: string, type: string, upstreamId: string, key: string): string {
  const b = base.replace(/\/$/, '');
  if (type === 'mj') return `${b}/mj/task/${upstreamId}/fetch`;
  if (type === 'suno') return `${b}/api/v1/suno/${upstreamId}`;
  return `${b}/v1/video/${upstreamId}/result`;
}

function normalizeUpstream(type: string, u: any): { status: string; progress: number; result: any } {
  // 不同上游字段不同；此处做常见归一
  let status = 'processing';
  let progress = 0;
  if (u.status === 'SUCCESS' || u.status === 'success' || u.progress === 100) status = 'success';
  else if (u.status === 'FAILURE' || u.status === 'failed') status = 'fail';
  progress = Number(u.progress ?? u.percent ?? 0);
  const result = u.result ?? u.imageUrl ?? u;
  return { status, progress, result };
}
