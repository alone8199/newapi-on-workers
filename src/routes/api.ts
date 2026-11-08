// /api/* 管理后台：逐字段对齐 QuantumNous/new-api
// 响应信封：{ success, message, data }，管理 API 一律 HTTP 200（原版前端只认 success）。
// 登录/刷新/登出：access token(JWT) + refresh cookie 流程（对齐 service/auth_session.go）。
import { Env, db, kv } from '../config';
import { authenticate, requireAdmin } from '../auth';
import { loadOptions, getBoolOption, getOption } from '../options';
import {
  json, parsePagination, nowUnix, generateToken, hashKey, hashPassword, verifyPassword, encryptSecret, decryptSecret, verifyAccessToken,
} from '../utils';
import {
  createLoginSession, refreshAccessToken, revokeByRefreshToken, revokeSession, listLoginSessions,
  extractRefreshToken, setSessionCookies, clearSessionCookies,
} from '../auth_session';

// ── 信封 ──
function apiOk(data: unknown, message = ''): Response {
  return json({ success: true, message, data }, 200);
}
function apiErr(message: string, code?: string): Response {
  const body: any = { success: false, message };
  if (code) body.code = code;
  return json(body, 200);
}

function secureCookie(req: Request): boolean {
  try { return new URL(req.url).protocol === 'https:'; } catch { return false; }
}

// ── buildSelfUserData（对齐 controller/user.go）──
function calculateUserPermissions(role: number): any {
  if (role === 100) return { sidebar_settings: false, sidebar_modules: {} };
  if (role === 10) return { sidebar_settings: true, sidebar_modules: { admin: { setting: false } } };
  return { sidebar_settings: true, sidebar_modules: { admin: false } };
}
function buildSelfUserData(user: any): any {
  let sidebar_modules: any[] = [];
  try { const s = JSON.parse(user.setting || '{}'); sidebar_modules = s.sidebar_modules || []; } catch { /* ignore */ }
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name || '',
    has_password: !!user.password,
    role: user.role,
    status: user.status,
    email: user.email || '',
    github_id: user.github_id || '',
    discord_id: user.discord_id || '',
    oidc_id: user.oidc_id || '',
    wechat_id: user.wechat_id || '',
    telegram_id: user.telegram_id || '',
    group: user.group || 'default',
    quota: user.quota || 0,
    used_quota: user.used_quota || 0,
    request_count: user.request_count || 0,
    aff_code: user.aff_code || '',
    aff_count: user.aff_count || 0,
    aff_quota: user.aff_quota || 0,
    aff_history_quota: user.aff_history_quota || 0,
    inviter_id: user.inviter_id || 0,
    linux_do_id: user.linux_do_id || '',
    setting: user.setting || '{}',
    stripe_customer: user.stripe_customer || '',
    sidebar_modules,
    // LIMITATION: admin_permissions 来自原版 authz.Capabilities（未移植）；当前返回 {}。
    // 主要管理菜单可见性由 sidebar_modules.admin 控制（已对齐），细粒度权限待第 2 步本地 diff 补齐。
    permissions: { ...calculateUserPermissions(user.role), admin_permissions: {} },
  };
}

// ── 渠道字段归一化（异步：解密 key）──
// DB 物理列已统一为 "group"（与原版 GORM 一致），SELECT 直接返回 group 字段。
// 原版 clearChannelInfo 此版本不剥离 key（前端自行打码），但 Worker 若启用 MASTER_KEY 加密，
// 返回给前端前必须解密回明文（换行分隔纯文本），否则前端编辑回传密文导致二次加密。
/** 渠道 key 输入归一化为原版格式（换行分隔纯文本）。兼容：字符串(逗号/换行)、数组。 */
function normalizeChannelKeyInput(input: unknown): string {
  if (input == null) return '';
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean).join('\n');
  const s = String(input).trim();
  if (!s) return '';
  if (s.startsWith('[')) {
    try { const arr = JSON.parse(s); if (Array.isArray(arr)) return arr.map(String).filter(Boolean).join('\n'); } catch { /* ignore */ }
  }
  return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join('\n');
}

async function normalizeChannel(row: any, env: Env): Promise<any> {
  if (!row) return row;
  if (row.key && env.MASTER_KEY) {
    try { return { ...row, key: await decryptSecret(row.key, env.MASTER_KEY) }; } catch { /* 明文保存 */ }
  }
  // 原版返回完整 Channel 对象（含 key）；Worker 多出的内部列前端会忽略，保留以免编辑丢数据
  return row;
}

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';
  const ua = req.headers.get('user-agent') || '';
  const secure = secureCookie(req);

  // ── 站点状态 ──
  if (path === '/api/status' && method === 'GET') {
    const opts = await loadOptions(env);
    return apiOk({
      version: 'newapi-on-workers',
      register_enabled: opts['RegisterEnabled'] === 'true',
      server_address: opts['ServerAddress'] || '',
      display_in_currency: opts['DisplayInCurrency'] === '1',
    });
  }

  // ── 登录（access token + refresh cookie 流程）──
  if (path === '/api/user/login' && method === 'POST') {
    // 原版 common.PasswordLoginEnabled 默认 true；未配置不应判为关闭
    if (!(await getBoolOption(env, 'PasswordLoginEnabled', true))) {
      return apiErr('Password login has been disabled by administrator');
    }
    const body = await req.json().catch(() => ({})) as any;
    const { username, password } = body;
    if (!username || !password) return apiErr('Invalid parameters');
    const user = await db(env).get<any>(`SELECT * FROM users WHERE username = ? AND status = 1`, [username]);
    if (!user || !(await verifyPassword(password, user.password))) {
      return apiErr('Username or password is incorrect, or user has been banned');
    }
    const bundle = await createLoginSession(env, user.id, user.role, 'password', ip, ua);
    const res = apiOk({
      access_token: bundle.access_token,
      token_type: bundle.token_type,
      access_expires_at: bundle.access_expires_at,
      session: bundle.session,
      user: buildSelfUserData(user),
    });
    for (const c of setSessionCookies(bundle, secure)) res.headers.append('Set-Cookie', c);
    return res;
  }

  // ── 刷新（access token 轮换）──
  if (path === '/api/user/auth/refresh' && method === 'POST') {
    const rt = extractRefreshToken(req);
    if (!rt) return json({ success: false, code: 'AUTH_REFRESH_TOKEN_REQUIRED', message: 'unauthorized' }, 200);
    const r = await refreshAccessToken(env, rt);
    if (!r) return json({ success: false, code: 'AUTH_REFRESH_TOKEN_INVALID', message: 'unauthorized' }, 200);
    const res = apiOk({
      access_token: r.bundle.access_token,
      token_type: r.bundle.token_type,
      access_expires_at: r.bundle.access_expires_at,
      session: r.bundle.session,
      user: buildSelfUserData(r.user),
    });
    return res;
  }

  // ── 登出 ──
  if ((path === '/api/user/auth/logout' || path === '/api/user/logout') && method === 'POST') {
    const rt = extractRefreshToken(req);
    if (rt) await revokeByRefreshToken(env, rt);
    // 兼容 Bearer access token 吊销会话
    const bearer = req.headers.get('authorization');
    if (bearer) {
      const m = bearer.match(/^Bearer\s+(.+)$/i);
      if (m) {
        const claims = await verifyAccessToken(m[1].trim());
        if (claims) await revokeSession(env, claims.uid, claims.sid);
      }
    }
    const res = apiOk(null, '');
    for (const c of clearSessionCookies(secure)) res.headers.append('Set-Cookie', c);
    return res;
  }

  // ── 登录会话列表 / 撤销（对齐 auth_session.go）──
  if (path === '/api/user/auth/sessions' && method === 'GET') {
    const auth = await authenticate(req, env, 'api');
    if (auth instanceof Response) return auth;
    const sessions = await listLoginSessions(env, auth.userId, auth.sid || '');
    return apiOk(sessions);
  }
  if (path.startsWith('/api/user/auth/sessions/') && method === 'DELETE') {
    const auth = await authenticate(req, env, 'api');
    if (auth instanceof Response) return auth;
    const sid = path.split('/').pop() || '';
    await revokeSession(env, auth.userId, sid);
    return apiOk({ revoked_sid: sid, current: sid === auth.sid }, '');
  }

  // ── 注册 ──
  if (path === '/api/user/register' && method === 'POST') {
    // 原版 common.RegisterEnabled 默认 true
    if (!(await getBoolOption(env, 'RegisterEnabled', true))) return apiErr('注册已关闭');
    const body = await req.json().catch(() => ({})) as any;
    const { username, password } = body;
    if (!username || !password) return apiErr('用户名或密码为空');
    const exists = await db(env).get(`SELECT id FROM users WHERE username = ?`, [username]);
    if (exists) return apiErr('用户名已存在');
    const pwd = await hashPassword(password);
    const quota = Number((await getOption(env, 'QuotaForNewUser')) || env.DEFAULT_QUOTA || 0);
    await db(env).run(
      `INSERT INTO users (username, password, display_name, role, status, quota, used_quota, "group", created_time, auth_version)
       VALUES (?,?,?,1,1,?,0,'default',?,1)`,
      [username, pwd, username, quota, nowUnix()]
    );
    return apiOk(null, '注册成功');
  }

  // ── 当前用户 ──
  if (path === '/api/user/self' && method === 'GET') {
    const auth = await authenticate(req, env, 'api');
    if (auth instanceof Response) return auth;
    const user = await db(env).get<any>(`SELECT * FROM users WHERE id = ?`, [auth.userId]);
    if (!user) return apiErr('用户不存在');
    return apiOk(buildSelfUserData(user));
  }

  // ── 以下需要鉴权 ──
  const auth = await authenticate(req, env, 'api');
  if (auth instanceof Response) return auth;

  // ── Token 管理 ──
  if (path === '/api/token' || path === '/api/token/') {
    if (method === 'GET') {
      const { page, perPage, offset } = parsePagination(url);
      const rows = await db(env).all<any>(
        `SELECT id,name,status,created_time,accessed_time,expired_time,remain_quota,unlimited_quota,"group"
         FROM tokens WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
        [auth.userId, perPage, offset]
      );
      const total = (await db(env).get<{ c: number }>(`SELECT COUNT(*) as c FROM tokens WHERE user_id = ?`, [auth.userId]))?.c ?? 0;
      return apiOk({ items: rows, total, page, page_size: perPage });
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({})) as any;
      const name = body.name || 'token';
      const plain = await generateToken('sk-');
      const keyHash = await hashKey(plain);
      const remain = body.unlimited_quota ? 0 : Number(body.remain_quota ?? 500000);
      const id = await db(env).insert(
        `INSERT INTO tokens (user_id,name,key,key_hash,status,created_time,remain_quota,unlimited_quota,"group")
         VALUES (?,?,?,?,1,?,?,?,?)`,
        [auth.userId, name, keyHash, keyHash, nowUnix(), remain, body.unlimited_quota ? 1 : 0, body.group || '']
      );
      return apiOk({ id, token: plain, name, remain_quota: remain, unlimited_quota: body.unlimited_quota ? 1 : 0 });
    }
  }
  if (path.startsWith('/api/token/')) {
    const id = Number(path.split('/').pop());
    if (method === 'GET') {
      const row = await db(env).get<any>(`SELECT id,name,status,remain_quota,unlimited_quota FROM tokens WHERE id=? AND user_id=?`, [id, auth.userId]);
      return row ? apiOk(row) : apiErr('未找到', 'NOT_FOUND');
    }
    if (method === 'DELETE') {
      const row = await db(env).get<{ key_hash: string }>(`SELECT key_hash FROM tokens WHERE id=? AND user_id=?`, [id, auth.userId]);
      await db(env).run(`DELETE FROM tokens WHERE id=? AND user_id=?`, [id, auth.userId]);
      if (row) await kv(env).deleteTokenUser(row.key_hash);
      return apiOk(null, '已删除');
    }
    if (method === 'PUT') {
      const body = await req.json().catch(() => ({})) as any;
      await db(env).run(`UPDATE tokens SET name=?, status=?, remain_quota=?, unlimited_quota=? WHERE id=? AND user_id=?`,
        [body.name, body.status ?? 1, body.remain_quota ?? 0, body.unlimited_quota ? 1 : 0, id, auth.userId]);
      return apiOk(null, '已更新');
    }
  }

  // ── 渠道管理（管理员） ──
  if (path === '/api/channel' || path === '/api/channel/') {
    const admin = requireAdmin(auth);
    if (admin) return admin;
    if (method === 'GET') {
      const { page, perPage, offset } = parsePagination(url);
      const rows = await db(env).all<any>(
        `SELECT * FROM channels ORDER BY id DESC LIMIT ? OFFSET ?`,
        [perPage, offset]
      );
      const total = (await db(env).get<{ c: number }>(`SELECT COUNT(*) as c FROM channels`))?.c ?? 0;
      const counts = await db(env).all<{ type: number; c: number }>(`SELECT type, COUNT(*) as c FROM channels GROUP BY type`);
      const type_counts: Record<number, number> = {};
      for (const r of counts) type_counts[r.type] = r.c;
      const items = await Promise.all(rows.map((r: any) => normalizeChannel(r, env)));
      return apiOk({ items, total, page, page_size: perPage, type_counts });
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({})) as any;
      // 原版 Channel.Key = 换行分隔纯文本；兼容前端逗号/数组输入，归一化为换行分隔
      const plainKey = normalizeChannelKeyInput(body.key);
      const encKey = env.MASTER_KEY && plainKey ? await encryptSecret(plainKey, env.MASTER_KEY) : plainKey;
      const id = await db(env).insert(
        `INSERT INTO channels (type,name,key,base_url,other,models,"group",status,weight,test_model,retry_times,auto_ban)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
        [body.type ?? 1, body.name, encKey, body.base_url, JSON.stringify(body.other || {}), body.models, body.group || 'default', body.status ?? 1, body.weight ?? 0, body.test_model || '', body.retry_times ?? 0]
      );
      await kv(env).deleteChannel(id);
      return apiOk({ id }, '创建成功');
    }
  }
  if (path.startsWith('/api/channel/')) {
    const admin = requireAdmin(auth);
    if (admin) return admin;
    const id = Number(path.split('/').pop());
    if (method === 'GET') {
      const row = await db(env).get<any>(`SELECT * FROM channels WHERE id=?`, [id]);
      return row ? apiOk(await normalizeChannel(row, env)) : apiErr('未找到', 'NOT_FOUND');
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await req.json().catch(() => ({})) as any;
      const plainKey = body.key !== undefined ? normalizeChannelKeyInput(body.key) : undefined;
      const encKey = plainKey !== undefined
        ? (env.MASTER_KEY && plainKey ? await encryptSecret(plainKey, env.MASTER_KEY) : plainKey)
        : undefined;
      const sets: string[] = [];
      const params: unknown[] = [];
      // 前端字段名 → DB 列名（"group" 为保留字需双引号引用）
      const colName = (f: string): string => (f === 'group' ? '"group"' : f);
      for (const f of ['type', 'name', 'base_url', 'other', 'models', 'group', 'status', 'weight', 'test_model', 'retry_times', 'auto_ban']) {
        if (body[f] !== undefined) { sets.push(`${colName(f)}=?`); params.push(f === 'other' ? JSON.stringify(body[f]) : body[f]); }
      }
      if (encKey) { sets.push('key=?'); params.push(encKey); }
      params.push(id);
      await db(env).run(`UPDATE channels SET ${sets.join(',')} WHERE id=?`, params);
      await kv(env).deleteChannel(id);
      return apiOk(null, '已更新');
    }
    if (method === 'DELETE') {
      await db(env).run(`DELETE FROM channels WHERE id=?`, [id]);
      await kv(env).deleteChannel(id);
      return apiOk(null, '已删除');
    }
  }

  // ── Options ──
  if (path === '/api/option' || path === '/api/option/') {
    if (method === 'GET') {
      const rows = await db(env).all<{ key: string; value: string }>(`SELECT key,value FROM options`);
      const map: Record<string, string> = {};
      for (const r of rows) map[r.key] = r.value;
      await kv(env).setAllOptions(map);
      return apiOk(map);
    }
    if (method === 'POST' || method === 'PUT') {
      const admin = requireAdmin(auth);
      if (admin) return admin;
      const body = await req.json().catch(() => ({})) as any;
      for (const [k, v] of Object.entries(body)) {
        await db(env).run(`INSERT INTO options (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?`, [k, String(v), String(v)]);
        await kv(env).deleteOption(k);
      }
      const fresh = await db(env).all<{ key: string; value: string }>(`SELECT key,value FROM options`);
      const map: Record<string, string> = {};
      for (const r of fresh) map[r.key] = r.value;
      await kv(env).setAllOptions(map);
      return apiOk(null, '已保存');
    }
  }

  // ── Logs ──
  if (path === '/api/log' || path === '/api/log/') {
    if (method === 'GET') {
      const { page, perPage, offset } = parsePagination(url);
      const uid = requireAdmin(auth) ? (Number(url.searchParams.get('user_id')) || 0) : auth.userId;
      const cond = uid ? `WHERE user_id=${uid}` : '';
      const rows = await db(env).all<any>(`SELECT id,user_id,channel_id,model,mode,type,quota,prompt_tokens,completion_tokens,total_tokens,ip,request_time,use_time,is_stream,success,content FROM logs ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`, [perPage, offset]);
      const total = (await db(env).get<{ c: number }>(`SELECT COUNT(*) as c FROM logs ${cond}`))?.c ?? 0;
      return apiOk({ items: rows, total, page, page_size: perPage });
    }
  }

  // ── Groups ──
  if (path === '/api/group' || path === '/api/group/') {
    const rows = await db(env).all<any>(`SELECT id,name,ratio,public FROM groups`);
    return apiOk(rows);
  }

  // ── Pricing ──
  if (path === '/api/pricing' || path === '/api/pricing/') {
    const rows = await db(env).all<any>(`SELECT id,model,type,price,purchased_tokens FROM pricing`);
    return apiOk(rows);
  }

  // ── Redemptions ──
  if (path === '/api/redemption/code' && method === 'POST') {
    const admin = requireAdmin(auth);
    if (admin) return admin;
    const body = await req.json().catch(() => ({})) as any;
    const plain = await generateToken('rk-', 16);
    const h = await hashKey(plain);
    const id = await db(env).insert(`INSERT INTO redemptions (key,key_hash,status,name,quota,created_time) VALUES (?,?,1,?,?,?)`, [h, h, body.name || 'gift', body.quota || 0, nowUnix()]);
    return apiOk({ id, code: plain });
  }
  if (path === '/api/redemption/redeem' && method === 'POST') {
    const body = await req.json().catch(() => ({})) as any;
    const h = await hashKey(body.code || '');
    const r = await db(env).get<any>(`SELECT * FROM redemptions WHERE key_hash=? AND status=1`, [h]);
    if (!r) return apiErr('兑换码无效');
    await db(env).run(`UPDATE redemptions SET status=2, redeemed_time=?, user_id=? WHERE id=?`, [nowUnix(), auth.userId, r.id]);
    await db(env).run(`UPDATE users SET quota = quota + ? WHERE id=?`, [r.quota, auth.userId]);
    return apiOk({ quota: r.quota }, '兑换成功');
  }

  // ── Models ──
  if (path === '/api/model' || path === '/api/model/') {
    const rows = await db(env).all<{ models: string }>(`SELECT models FROM channels WHERE status=1`);
    const set = new Set<string>();
    for (const r of rows) for (const m of r.models.split(',')) if (m.trim()) set.add(m.trim());
    return apiOk([...set].map((m) => ({ id: m, name: m })));
  }

  return apiErr(`未知管理端点 ${path}`, 'NOT_FOUND');
}
