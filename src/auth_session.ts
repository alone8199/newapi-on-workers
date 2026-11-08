// 登录会话（access token + refresh token + D1 会话） —— 对齐原版 service/auth_session.go
// Cookie 名称/属性：new_api_refresh（Path=/api/user/auth, HttpOnly, SameSite=Strict）
//                  new_api_has_session（Path=/, 非 HttpOnly, SameSite=Strict，前端冷启动探测用）
import { Env, db } from './config';
import { nowUnix, issueAccessToken, ACCESS_TOKEN_TTL, generateToken } from './utils';

const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 天（对应原版 LoginSessionTTL）
const REFRESH_COOKIE = 'new_api_refresh';
const HINT_COOKIE = 'new_api_has_session';
const COOKIE_PATH = '/api/user/auth';

export interface LoginSessionRow {
  id: number;
  sid: string;
  user_id: number;
  auth_version: number;
  version: number;
  refresh_token_hash: string;
  login_method: string;
  ip: string;
  user_agent: string;
  created_at: number;
  last_active_at: number;
  expires_at: number;
}

export interface LoginSessionView {
  sid: string;
  current: boolean;
  login_method: string;
  ip: string;
  user_agent: string;
  created_at: number;
  last_active_at: number;
  expires_at: number;
}

export interface AuthBundle {
  access_token: string;
  token_type: string;
  access_expires_at: number;
  session: LoginSessionView;
  refresh_token: string;
}

function sessionView(row: LoginSessionRow, current: boolean): LoginSessionView {
  return {
    sid: row.sid,
    current,
    login_method: row.login_method,
    ip: row.ip,
    user_agent: row.user_agent,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    expires_at: row.expires_at,
  };
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 创建登录会话：写 D1 user_sessions + 签发 access/refresh token */
export async function createLoginSession(
  env: Env,
  userId: number,
  role: number,
  loginMethod: string,
  ip: string,
  ua: string
): Promise<AuthBundle> {
  const sid = await generateToken('', 16);
  const refreshToken = await generateToken('', 32);
  const refreshHash = await sha256Hex(refreshToken);
  const now = nowUnix();
  const expires = now + REFRESH_TOKEN_TTL;
  const av = (await db(env).get<{ auth_version: number }>(`SELECT auth_version FROM users WHERE id = ?`, [userId]))?.auth_version ?? 1;
  await db(env).run(
    `INSERT INTO user_sessions (sid, user_id, auth_version, version, refresh_token_hash, login_method, ip, user_agent, created_at, last_active_at, expires_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [sid, userId, av, refreshHash, loginMethod, ip, ua, now, now, expires]
  );
  const accessToken = await issueAccessToken({ uid: userId, sid, role, av });
  const row: LoginSessionRow = {
    id: 0, sid, user_id: userId, auth_version: av, version: 1,
    refresh_token_hash: refreshHash, login_method: loginMethod, ip, user_agent: ua,
    created_at: now, last_active_at: now, expires_at: expires,
  };
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    access_expires_at: now + ACCESS_TOKEN_TTL,
    session: sessionView(row, true),
    refresh_token: refreshToken,
  };
}

/** 用 refresh token 轮换 access token（校验会话未过期/未吊销/未因 auth_version 变更失效） */
export async function refreshAccessToken(
  env: Env,
  rawToken: string
): Promise<{ bundle: AuthBundle; current: boolean; user: any } | null> {
  const hash = await sha256Hex(rawToken);
  const row = await db(env).get<LoginSessionRow>(
    `SELECT * FROM user_sessions WHERE refresh_token_hash = ? AND expires_at > ?`,
    [hash, nowUnix()]
  );
  if (!row) return null;
  const user = await db(env).get<any>(
    `SELECT * FROM users WHERE id = ? AND status = 1`,
    [row.user_id]
  );
  if (!user) return null;
  if (user.auth_version !== row.auth_version) return null; // 用户改密导致 auth_version 变更 → 刷新令牌失效
  await db(env).run(`UPDATE user_sessions SET last_active_at = ? WHERE id = ?`, [nowUnix(), row.id]);
  const accessToken = await issueAccessToken({ uid: row.user_id, sid: row.sid, role: user.role, av: row.auth_version });
  return {
    bundle: {
      access_token: accessToken,
      token_type: 'Bearer',
      access_expires_at: nowUnix() + ACCESS_TOKEN_TTL,
      session: sessionView(row, true),
      refresh_token: rawToken,
    },
    current: true,
    user,
  };
}

export async function revokeByRefreshToken(env: Env, rawToken: string): Promise<boolean> {
  const hash = await sha256Hex(rawToken);
  const changes = await db(env).run(`DELETE FROM user_sessions WHERE refresh_token_hash = ?`, [hash]);
  return changes > 0;
}

export async function revokeSession(env: Env, userId: number, sid: string): Promise<boolean> {
  const changes = await db(env).run(`DELETE FROM user_sessions WHERE user_id = ? AND sid = ?`, [userId, sid]);
  return changes > 0;
}

export async function listLoginSessions(env: Env, userId: number, currentSid: string): Promise<LoginSessionView[]> {
  const rows = await db(env).all<LoginSessionRow>(
    `SELECT * FROM user_sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_active_at DESC`,
    [userId, nowUnix()]
  );
  return rows.map((r) => sessionView(r, r.sid === currentSid));
}

export async function sessionExists(env: Env, sid: string): Promise<boolean> {
  const row = await db(env).get<{ id: number }>(
    `SELECT id FROM user_sessions WHERE sid = ? AND expires_at > ?`,
    [sid, nowUnix()]
  );
  return !!row;
}

// ── Cookie 辅助 ──
function maxAgeOf(bundle: AuthBundle): number {
  return Math.max(1, bundle.session.expires_at - nowUnix());
}

function cookieAttrs(maxAge: number, secure: boolean): string {
  return `; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}
function hintAttrs(maxAge: number, secure: boolean): string {
  return `; Path=/; Max-Age=${maxAge}; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function setSessionCookies(bundle: AuthBundle, secure: boolean): string[] {
  const maxAge = maxAgeOf(bundle);
  return [
    `${REFRESH_COOKIE}=${bundle.refresh_token}${cookieAttrs(maxAge, secure)}`,
    `${HINT_COOKIE}=1${hintAttrs(maxAge, secure)}`,
  ];
}

export function clearSessionCookies(secure: boolean): string[] {
  const exp = '; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  return [
    `${REFRESH_COOKIE}=${exp}${cookieAttrs(-1, secure)}`,
    `${HINT_COOKIE}=${exp}${hintAttrs(-1, secure)}`,
  ];
}

export function extractRefreshToken(req: Request): string | null {
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === REFRESH_COOKIE) return decodeURIComponent(v);
  }
  return null;
}

export function refreshCookieName(): string {
  return REFRESH_COOKIE;
}
