// 双鉴权中间件：Bearer token（/v1 /pg） + Session cookie（/api）
import { Env, db, kv } from './config';
import { SessionStore } from './storage/session';
import { hashKey } from './utils';
import { errorResponse } from './utils';

export interface AuthContext {
  userId: number;
  role: number;
  tokenId: number;
  groupId: string;
  unlimited: boolean;
}

/** 从请求提取 Bearer token */
export function extractBearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** 从 Cookie 提取 session id */
export function extractSessionId(req: Request): string | null {
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === SessionStore.cookieName) return v;
  }
  return null;
}

/**
 * 鉴权主入口。
 * scope='api' 优先 Bearer 再 Session；scope='proxy' 仅 Bearer。
 */
export async function authenticate(
  req: Request,
  env: Env,
  scope: 'api' | 'proxy'
): Promise<AuthContext | Response> {
  if (scope === 'proxy') {
    const token = extractBearer(req);
    if (!token) return errorResponse('invalid api key', 401, 'authentication_error', 'invalid_api_key');
    const ctx = await authByToken(token, env);
    if (ctx instanceof Response) return ctx;
    return ctx;
  }
  // api：Bearer 优先，否则 Session
  const bearer = extractBearer(req);
  if (bearer) {
    const ctx = await authByToken(bearer, env);
    if (!(ctx instanceof Response)) return ctx;
  }
  const sid = extractSessionId(req);
  if (sid) {
    const ss = new SessionStore(kv(env), db(env));
    const s = await ss.get(sid);
    if (s) {
      return { userId: s.user_id, role: s.role, tokenId: 0, groupId: 'default', unlimited: s.role >= 10 };
    }
  }
  return errorResponse('未登录或登录已过期', 401, 'authentication_error', 'unauthorized');
}

/** Bearer token 鉴权（带 KV 缓存 token→user 映射） */
async function authByToken(token: string, env: Env): Promise<AuthContext | Response> {
  const hash = await hashKey(token);
  const kvStore = kv(env);
  let userId = await kvStore.getTokenUser(hash);
  let tokenRow: any = null;
  if (userId == null) {
    tokenRow = await db(env).get<any>(
      `SELECT id, user_id, status, remain_quota, unlimited_quota, expired_time FROM tokens WHERE key_hash = ?`,
      [hash]
    );
    if (!tokenRow || tokenRow.status !== 1) {
      return errorResponse('invalid api key', 401, 'authentication_error', 'invalid_api_key');
    }
    userId = Number(tokenRow.user_id);
    await kvStore.putTokenUser(hash, userId);
  } else {
    tokenRow = await db(env).get<any>(
      `SELECT id, user_id, status, remain_quota, unlimited_quota, expired_time FROM tokens WHERE key_hash = ?`,
      [hash]
    );
  }
  if (!tokenRow || tokenRow.status !== 1) {
    await kvStore.deleteTokenUser(hash);
    return errorResponse('invalid api key', 401, 'authentication_error', 'invalid_api_key');
  }
  const now = Math.floor(Date.now() / 1000);
  if (tokenRow.expired_time && tokenRow.expired_time < now) {
    return errorResponse('token 已过期', 401, 'authentication_error', 'expired');
  }
  const user = await db(env).get<any>(
    `SELECT role, group_id, status, quota, used_quota FROM users WHERE id = ?`,
    [Number(tokenRow.user_id)]
  );
  if (!user || user.status !== 1) {
    return errorResponse('用户已被禁用', 403, 'authentication_error', 'user_disabled');
  }
  return {
    userId: Number(user.id ?? tokenRow.user_id),
    role: Number(user.role),
    tokenId: Number(tokenRow.id),
    groupId: String(user.group_id || 'default'),
    unlimited: tokenRow.unlimited_quota === 1,
  };
}

/** 仅管理员可访问 */
export function requireAdmin(ctx: AuthContext): Response | null {
  if (ctx.role < 10) return errorResponse('需要管理员权限', 403, 'permission_error', 'forbidden');
  return null;
}
