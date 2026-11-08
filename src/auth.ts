// 双鉴权中间件：Bearer(relay token) 用于 /v1 /pg；Bearer(access token) 或 refresh cookie 用于 /api
import { Env, db } from './config';
import { hashKey, verifyAccessToken, errorResponse, json } from './utils';
import { sessionExists } from './auth_session';

export interface AuthContext {
  userId: number;
  role: number;
  tokenId: number;
  groupId: string;
  unlimited: boolean;
  sid?: string;
}

export const ROLE_ADMIN = 10;
export const ROLE_ROOT = 100;

/** 从请求提取 Bearer token */
export function extractBearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** 鉴权主入口。scope='api' 用 access token(Bearer) 或 refresh cookie；scope='proxy' 仅 relay token。 */
export async function authenticate(
  req: Request,
  env: Env,
  scope: 'api' | 'proxy'
): Promise<AuthContext | Response> {
  if (scope === 'proxy') {
    const token = extractBearer(req);
    if (!token) return errorResponse('invalid api key', 401, 'authentication_error', 'invalid_api_key');
    return authByRelayToken(token, env);
  }
  // api：Bearer access token 优先
  const bearer = extractBearer(req);
  if (bearer) {
    const claims = await verifyAccessToken(bearer);
    if (claims) {
      const live = await sessionExists(env, claims.sid);
      if (live) {
        const user = await db(env).get<{ group: string }>(`SELECT "group" FROM users WHERE id = ? AND status = 1`, [claims.uid]);
        if (user) {
          return {
            userId: claims.uid,
            role: claims.role,
            tokenId: 0,
            groupId: user.group || 'default',
            unlimited: false,
            sid: claims.sid,
          };
        }
      }
    }
  }
  // api 鉴权失败 → 200 信封（原版前端只认 success）
  return json({ success: false, code: 'AUTH_TOKEN_INVALID', message: 'unauthorized' }, 200);
}

/** relay token（/v1 /pg）：sk- 前缀，查 tokens 表 */
export async function authByRelayToken(token: string, env: Env): Promise<AuthContext | Response> {
  const hash = await hashKey(token);
  const tokenRow = await db(env).get<any>(
    `SELECT id, user_id, status, remain_quota, unlimited_quota, expired_time FROM tokens WHERE key_hash = ?`,
    [hash]
  );
  if (!tokenRow || tokenRow.status !== 1) {
    return errorResponse('invalid api key', 401, 'authentication_error', 'invalid_api_key');
  }
  const now = Math.floor(Date.now() / 1000);
  if (tokenRow.expired_time && tokenRow.expired_time > 0 && tokenRow.expired_time < now) {
    return errorResponse('token 已过期', 401, 'authentication_error', 'expired');
  }
  const user = await db(env).get<any>(
    `SELECT role, "group", status FROM users WHERE id = ?`,
    [tokenRow.user_id]
  );
  if (!user || user.status !== 1) {
    return errorResponse('用户已被禁用', 403, 'authentication_error', 'user_disabled');
  }
  return {
    userId: tokenRow.user_id,
    role: user.role,
    tokenId: tokenRow.id,
    groupId: user.group || 'default',
    unlimited: tokenRow.unlimited_quota === 1,
  };
}

/** 管理员判定：role >= 10（对齐原版 IsAdmin：role >= RoleAdminUser(10)） */
export function requireAdmin(auth: AuthContext): Response | null {
  if (auth.role < ROLE_ADMIN) {
    return json({ success: false, code: 'PERMISSION_DENIED', message: '无权访问该资源' }, 200);
  }
  return null;
}
