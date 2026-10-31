// 请求日志落盘（D1）。高频写入可在生产环境改为经 Queues 异步；此处直接写，简单可靠。
import { Env, db } from './config';

export interface LogEntry {
  user_id: number;
  channel_id: number;
  token_id: number;
  model: string;
  mode: string;
  type: number;
  content: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  ip: string;
  use_time: number;
  is_stream: number;
  success: number;
  request_detail?: string;
}

export async function recordLog(env: Env, e: LogEntry): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await db(env).run(
      `INSERT INTO logs (user_id, channel_id, token_id, model, mode, type, content, quota,
        prompt_tokens, completion_tokens, total_tokens, ip, request_time, use_time, is_stream, success, request_detail)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        e.user_id, e.channel_id, e.token_id, e.model, e.mode, e.type, e.content, e.quota,
        e.prompt_tokens, e.completion_tokens, e.total_tokens, e.ip, now, e.use_time,
        e.is_stream, e.success, e.request_detail || '',
      ]
    );
  } catch {
    /* 日志失败不应影响主流程 */
  }
}
