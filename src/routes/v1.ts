// /v1/* 与协议入口路由：OpenAI / Claude / Gemini / Responses
import { Env, db, kv } from '../config';
import { authenticate, AuthContext } from '../auth';
import { listChannelsForModel, selectChannel, markChannelFailure, resetChannelFailure, ChannelRow } from '../channels';
import { proxyChat, estimatePreQuota } from '../proxy';
import { preDeduct, settle, computeQuota, getGroupRatio } from '../billing';
import { recordLog } from '../log';
import { json, errorResponse, nowUnix } from '../utils';
import type { ProtocolName } from '../protocols/types';

/** 取模型单价（KV 缓存 → D1） */
async function getModelPrice(env: Env, model: string): Promise<{ prompt: number; completion: number } | undefined> {
  const all = await kv(env).getPricing();
  if (Object.keys(all).length) {
    const p = all[model];
    if (p != null) return { prompt: p, completion: p };
  }
  const row = await db(env).get<{ price: number }>(`SELECT price FROM pricing WHERE model = ?`, [model]);
  return row ? { prompt: row.price, completion: row.price } : undefined;
}

/** 统一聊天类请求处理：鉴权 → 选渠道(加权+故障切换) → 预扣 → 代理 → 结算 → 日志 */
export async function chatWithAuth(
  env: Env,
  source: ProtocolName,
  model: string,
  clientBody: any,
  ip: string,
  auth: AuthContext
): Promise<Response> {
  if (!model) return errorResponse('缺少 model 参数', 400);

  const channels = await listChannelsForModel(env, model, auth.groupId);
  if (!channels.length) return errorResponse(`无可用渠道服务模型 ${model}`, 404, 'model_error', 'model_not_found');

  const groupRatio = await getGroupRatio(env, auth.groupId);
  const price = await getModelPrice(env, model);
  const preAmount = estimatePreQuota(clientBody);

  const pre = await preDeduct(env, auth.tokenId, auth.userId, preAmount, auth.unlimited);
  // 原版额度不足返回 403（http.StatusForbidden）+ OpenAI 错误对象，非 402
  if (!pre.ok) return errorResponse('额度不足', 403, 'insufficient_quota', 'insufficient_quota');

  const maxRetry = 3;
  let lastErr: Response | null = null;
  for (let attempt = 0; attempt < maxRetry; attempt++) {
    const channel: ChannelRow | null = selectChannel(channels);
    if (!channel) break;
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let success = false;
    let latency = 0;
    const resp = await proxyChat({
      env,
      source,
      channel,
      model,
      clientBody,
      authCtx: auth,
      onUsage: (u) => {
        usage = u;
      },
      onFinish: (ok, ms) => {
        success = ok;
        latency = ms;
        if (ok) resetChannelFailure(env, channel.id);
        else markChannelFailure(env, channel.id);
        // 结算 + 日志（流式在流结束时触发，非流式在 proxyChat 内已触发）
        if (ok) {
          const real = price
            ? computeQuota(usage.prompt_tokens, usage.completion_tokens, price, groupRatio)
            : Math.ceil((usage.prompt_tokens + usage.completion_tokens) * groupRatio);
          settle(env, auth.tokenId, auth.userId, preAmount, Math.max(real, 0), auth.unlimited);
          recordLog(env, {
            user_id: auth.userId, channel_id: channel.id, token_id: auth.tokenId, model,
            mode: 'chat', type: 1, content: '', quota: Math.max(real, 0),
            prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens, ip, use_time: latency,
            is_stream: clientBody.stream ? 1 : 0, success: 1,
          });
        }
      },
    });
    if (resp.ok) {
      return resp;
    }
    lastErr = resp;
    // 故障切换：从候选移除该渠道再试
    const idx = channels.findIndex((c) => c.id === channel.id);
    if (idx >= 0) channels.splice(idx, 1);
    if (!channels.length) break;
  }
  // 全部失败：退款预扣
  await settle(env, auth.tokenId, auth.userId, preAmount, 0, auth.unlimited);
  await recordLog(env, {
    user_id: auth.userId, channel_id: 0, token_id: auth.tokenId, model, mode: 'chat', type: 1,
    content: '', quota: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, ip,
    use_time: 0, is_stream: clientBody.stream ? 1 : 0, success: 0,
  });
  return lastErr ?? errorResponse('所有渠道均不可用', 503, 'upstream_error', 'all_channels_failed');
}

/** 简单透传（embeddings/completions/images/audio/rerank/moderations 等 OpenAI 原生） */
async function proxySimple(req: Request, env: Env, path: string, modelField: string): Promise<Response> {
  const auth = await authenticate(req, env, 'proxy');
  if (auth instanceof Response) return auth;
  let body: any = {};
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('application/json')) body = await req.json().catch(() => ({}));
  else if (ct.includes('multipart')) { /* 图片/音频以原样转发 */ }
  const model = body[modelField] || '';
  if (!model) return errorResponse('缺少 model', 400);
  const channels = await listChannelsForModel(env, model, auth.groupId);
  if (!channels.length) return errorResponse(`无可用渠道服务模型 ${model}`, 404);
  const channel = selectChannel(channels)!;
  const target = channel.type === 3 ? 'claude' : channel.type === 4 ? 'gemini' : 'openai';
  const base = channel.base_url.replace(/\/$/, '');
  const url = `${base}${path}`;
  const headers = new Headers();
  const key = (await getFirstKey(channel, env));
  if (target === 'claude') {
    headers.set('x-api-key', key); headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('authorization', `Bearer ${key}`);
  }
  headers.set('content-type', ct.includes('multipart') ? ct : 'application/json');
  const init: any = { method: 'POST', headers };
  if (ct.includes('multipart')) {
    init.body = req.body;
    init.duplex = 'half';
  } else {
    init.body = JSON.stringify(body);
  }
  try {
    const upstream = await fetch(url, init);
    const out = new Response(upstream.body, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' } });
    return out;
  } catch (e) {
    return errorResponse('上游连接失败: ' + String(e), 502);
  }
}

async function getFirstKey(channel: ChannelRow, env: Env): Promise<string> {
  const { getChannelKeys, pickKey } = await import('../channels');
  const keys = await getChannelKeys(channel, env);
  return pickKey(keys);
}

/** 主分发 */
export async function handleV1(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';

  // ── 聊天类（需读取 body 判定 model） ──
  if (path === '/v1/chat/completions') {
    const body: any = await req.json().catch(() => null);
    if (!body) return errorResponse('无效 JSON', 400);
    const auth = await authenticate(req, env, 'proxy');
    if (auth instanceof Response) return auth;
    return chatWithAuth(env, 'openai', body.model, body, ip, auth);
  }
  if (path === '/v1/messages') {
    const body: any = await req.json().catch(() => null);
    if (!body) return errorResponse('无效 JSON', 400);
    const auth = await authenticate(req, env, 'proxy');
    if (auth instanceof Response) return auth;
    return chatWithAuth(env, 'claude', body.model, body, ip, auth);
  }
  if (path === '/v1/responses' || path === '/v1/responses/compact') {
    const body: any = await req.json().catch(() => null);
    if (!body) return errorResponse('无效 JSON', 400);
    const auth = await authenticate(req, env, 'proxy');
    if (auth instanceof Response) return auth;
    const model = typeof body.model === 'string' ? body.model : '';
    return chatWithAuth(env, 'responses', model, body, ip, auth);
  }
  // Gemini 原生路径：/v1beta/models/{model}:generateContent 或 :streamGenerateContent
  const gemMatch = path.match(/\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)/);
  if (gemMatch) {
    const model = gemMatch[1];
    const body: any = await req.json().catch(() => ({}));
    const auth = await authenticate(req, env, 'proxy');
    if (auth instanceof Response) return auth;
    return chatWithAuth(env, 'gemini', model, body, ip, auth);
  }

  // ── /v1/models ──
  if (path === '/v1/models' && req.method === 'GET') {
    const auth = await authenticate(req, env, 'proxy');
    if (auth instanceof Response) return auth;
    const cached = await kv(env).getModelList(auth.groupId);
    if (cached) return json({ object: 'list', data: cached });
    const rows = await db(env).all<{ models: string }>(
      `SELECT models FROM channels WHERE status=1 AND ("group"='' OR "group"=? OR "group" LIKE ?)`,
      [auth.groupId, `%${auth.groupId}%`]
    );
    const set = new Set<string>();
    for (const r of rows) for (const m of r.models.split(',')) if (m.trim()) set.add(m.trim());
    const data = [...set].map((id) => ({
      id, object: 'model', created: nowUnix(), owned_by: 'newapi', permission: [], root: id, parent: null,
    }));
    await kv(env).putModelList(auth.groupId, data);
    return json({ object: 'list', data });
  }

  // ── 简单透传端点 ──
  if (path === '/v1/embeddings') return proxySimple(req, env, '/v1/embeddings', 'model');
  if (path === '/v1/completions') return proxySimple(req, env, '/v1/completions', 'model');
  if (path === '/v1/images/generations') return proxySimple(req, env, '/v1/images/generations', 'model');
  if (path === '/v1/images/edits') return proxySimple(req, env, '/v1/images/edits', 'model');
  if (path === '/v1/edits') return proxySimple(req, env, '/v1/images/edits', 'model'); // 旧版兼容进入图像 Relay
  if (path === '/v1/audio/transcriptions') return proxySimple(req, env, '/v1/audio/transcriptions', 'model');
  if (path === '/v1/audio/translations') return proxySimple(req, env, '/v1/audio/translations', 'model');
  if (path === '/v1/audio/speech') return proxySimple(req, env, '/v1/audio/speech', 'model');
  if (path === '/v1/rerank') return proxySimple(req, env, '/v1/rerank', 'model');
  if (path === '/v1/moderations') return proxySimple(req, env, '/v1/moderations', 'model');

  return errorResponse(`未知端点 ${path}`, 404);
}
