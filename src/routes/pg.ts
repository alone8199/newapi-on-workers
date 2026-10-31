// /pg/* 游乐场：使用登录会话选择分组与模型，复用统一分流/转换/计费/重试链路
import { Env } from '../config';
import { authenticate } from '../auth';
import { chatWithAuth } from './v1';
import { errorResponse, json } from '../utils';
import type { ProtocolName } from '../protocols/types';

export async function handlePg(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';

  if (path === '/pg/chat/completions' && req.method === 'POST') {
    // 游乐场用 Session 登录态（api scope，Bearer 优先回退 Session）
    const auth = await authenticate(req, env, 'api');
    if (auth instanceof Response) return auth;
    const body: any = await req.json().catch(() => null);
    if (!body) return errorResponse('无效 JSON', 400);
    const source: ProtocolName = 'openai';
    return chatWithAuth(env, source, body.model, body, ip, auth);
  }

  if (path === '/pg/health' && req.method === 'GET') {
    return json({ status: 'ok' });
  }

  return errorResponse(`未知游乐场端点 ${path}`, 404);
}
