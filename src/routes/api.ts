// /api/* 管理后台：字段与原版逐字段对齐（响应信封 {code,message,data}）
import { Env, db, kv, sessions, isProd } from '../config';
import { authenticate, requireAdmin, AuthContext } from '../auth';
import { SessionStore } from '../storage/session';
import { json, errorResponse, parsePagination, nowUnix, generateToken, hashKey, hashPassword, verifyPassword, encryptSecret } from '../utils';

function apiOk(data: unknown, message = 'success'): Response {
  return json({ code: 0, message, data });
}
function apiErr(message: string, code = 400, http = 400): Response {
  return json({ code, message }, http);
}

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';

  // ── 站点状态 ──
  if (path === '/api/status' && method === 'GET') {
    const opts = await kv(env).getAllOptions();
    return apiOk({
      version: 'newapi-on-workers',
      register_enabled: opts['RegisterEnabled'] === 'true' || opts['FileUploadPermission'] === '1',
      server_address: opts['ServerAddress'] || '',
      display_in_currency: opts['DisplayInCurrencyEnabled'] === '1',
    });
  }

  // ── 登录 ──
  if (path === '/api/user/login' && method === 'POST') {
    const body = await req.json().catch(() => ({})) as any;
    const { username, password } = body;
    if (!username || !password) return apiErr('用户名或密码为空', 400);
    const user = await db(env).get<any>(`SELECT * FROM users WHERE username = ? AND status = 1`, [username]);
    if (!user || !(await verifyPassword(password, user.password))) return apiErr('用户名或密码错误', 401, 401);
    const ss = new SessionStore(kv(env), db(env));
    const session = await ss.create(user.id, user.role, ip);
    const res = apiOk({
      id: user.id, username: user.username, display_name: user.display_name,
      role: user.role, status: user.status, email: user.email, quota: user.quota,
      used_quota: user.used_quota, group: user.group_id,
    });
    res.headers.set('Set-Cookie', SessionStore.cookieHeader(session.id, isProd(env)));
    return res;
  }

  // ── 注册 ──
  if (path === '/api/user/register' && method === 'POST') {
    const opts = await kv(env).getAllOptions();
    if (opts['RegisterEnabled'] !== 'true') return apiErr('注册已关闭', 403, 403);
    const body = await req.json().catch(() => ({})) as any;
    const { username, password } = body;
    if (!username || !password) return apiErr('用户名或密码为空', 400);
    const exists = await db(env).get(`SELECT id FROM users WHERE username = ?`, [username]);
    if (exists) return apiErr('用户名已存在', 409, 409);
    const pwd = await hashPassword(password);
    const quota = Number(opts['QuotaForNewUser'] || env.DEFAULT_QUOTA || 500000);
    await db(env).run(
      `INSERT INTO users (username, password, display_name, role, status, quota, used_quota, group_id, created_time)
       VALUES (?,?,?,1,1,?,0,'default',?)`,
      [username, pwd, username, quota, nowUnix()]
    );
    return apiOk(null, '注册成功');
  }

  // ── 登出 ──
  if (path === '/api/user/logout' && method === 'POST') {
    const cookie = req.headers.get('cookie') || '';
    const m = cookie.match(new RegExp(SessionStore.cookieName + '=([^;]+)'));
    const sid = m?.[1];
    if (sid) await sessions(env).destroy(sid);
    const res = apiOk(null, '已登出');
    res.headers.set('Set-Cookie', `${SessionStore.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return res;
  }

  // ── 当前用户 ──
  if (path === '/api/user/self' && method === 'GET') {
    const auth = await authenticate(req, env, 'api');
    if (auth instanceof Response) return auth;
    const user = await db(env).get<any>(`SELECT id,username,display_name,role,status,email,quota,used_quota,group_id,request_count FROM users WHERE id = ?`, [auth.userId]);
    if (!user) return apiErr('用户不存在', 404, 404);
    return apiOk(user);
  }

  // ── 需要鉴权 ──
  const auth = await authenticate(req, env, 'api');
  if (auth instanceof Response) return auth;

  // ── Token 管理 ──
  if (path === '/api/token/' || path === '/api/token') {
    if (method === 'GET') {
      const { page, perPage, offset } = parsePagination(url);
      const rows = await db(env).all<any>(
        `SELECT id,name,status,created_time,accessed_time,expired_time,remain_quota,unlimited_quota
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
        `INSERT INTO tokens (user_id,name,key,key_hash,status,created_time,remain_quota,unlimited_quota)
         VALUES (?,?,?,?,1,?,?,?)`,
        [auth.userId, name, keyHash, keyHash, nowUnix(), remain, body.unlimited_quota ? 1 : 0]
      );
      return apiOk({ id, token: plain, name, remain_quota: remain, unlimited_quota: body.unlimited_quota ? 1 : 0 });
    }
  }
  if (path.startsWith('/api/token/')) {
    const id = Number(path.split('/').pop());
    if (method === 'GET') {
      const row = await db(env).get<any>(`SELECT id,name,status,remain_quota,unlimited_quota FROM tokens WHERE id=? AND user_id=?`, [id, auth.userId]);
      return row ? apiOk(row) : apiErr('未找到', 404, 404);
    }
    if (method === 'DELETE') {
      await db(env).run(`DELETE FROM tokens WHERE id=? AND user_id=?`, [id, auth.userId]);
      await kv(env).deleteTokenUser((await db(env).get<{ key_hash: string }>(`SELECT key_hash FROM tokens WHERE id=?`, [id]))?.key_hash || '');
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
      const rows = await db(env).all<any>(`SELECT id,type,name,base_url,models,group_id,status,weight,test_model,retry_times,balance,use_time FROM channels ORDER BY id DESC LIMIT ? OFFSET ?`, [perPage, offset]);
      const total = (await db(env).get<{ c: number }>(`SELECT COUNT(*) as c FROM channels`))?.c ?? 0;
      return apiOk({ items: rows, total, page, page_size: perPage });
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({})) as any;
      const keyJson = body.key ? JSON.stringify(String(body.key).split(',').map((s: string) => s.trim()).filter(Boolean)) : '[]';
      const encKey = env.MASTER_KEY ? await encryptSecret(keyJson, env.MASTER_KEY) : keyJson;
      const id = await db(env).insert(
        `INSERT INTO channels (type,name,key,base_url,other,models,group_id,status,weight,test_model,retry_times,auto_ban)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
        [body.type ?? 1, body.name, encKey, body.base_url, JSON.stringify(body.other || {}), body.models, body.group_id || '', body.status ?? 1, body.weight ?? 0, body.test_model || '', body.retry_times ?? 0]
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
      return row ? apiOk(row) : apiErr('未找到', 404, 404);
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await req.json().catch(() => ({})) as any;
      const encKey = body.key ? (env.MASTER_KEY ? await encryptSecret(JSON.stringify(String(body.key).split(',').map((s: string) => s.trim()).filter(Boolean)), env.MASTER_KEY) : JSON.stringify(String(body.key).split(','))) : undefined;
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const f of ['type', 'name', 'base_url', 'other', 'models', 'group_id', 'status', 'weight', 'test_model', 'retry_times', 'auto_ban']) {
        if (body[f] !== undefined) { sets.push(`${f}=?`); params.push(f === 'other' ? JSON.stringify(body[f]) : body[f]); }
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
  if (path === '/api/option/' || path === '/api/option') {
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
  if (path === '/api/log/' || path === '/api/log') {
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
  if (path === '/api/group/' || path === '/api/group') {
    const rows = await db(env).all<any>(`SELECT id,name,ratio,public FROM groups`);
    return apiOk(rows);
  }

  // ── Pricing ──
  if (path === '/api/pricing/' || path === '/api/pricing') {
    const rows = await db(env).all<any>(`SELECT id,model,type,price,purchased_tokens FROM pricing`);
    return apiOk(rows);
  }

  // ── Redemptions（管理员增删，用户兑换） ──
  if (path === '/api/redemption/code' && method === 'POST') {
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
    if (!r) return apiErr('兑换码无效', 400);
    await db(env).run(`UPDATE redemptions SET status=2, redeemed_time=?, user_id=? WHERE id=?`, [nowUnix(), auth.userId, r.id]);
    await db(env).run(`UPDATE users SET quota = quota + ? WHERE id=?`, [r.quota, auth.userId]);
    return apiOk({ quota: r.quota }, '兑换成功');
  }

  // ── Models ──
  if (path === '/api/model/' || path === '/api/model') {
    const rows = await db(env).all<{ models: string }>(`SELECT models FROM channels WHERE status=1`);
    const set = new Set<string>();
    for (const r of rows) for (const m of r.models.split(',')) if (m.trim()) set.add(m.trim());
    return apiOk([...set].map((m) => ({ id: m, name: m })));
  }

  return apiErr(`未知管理端点 ${path}`, 404, 404);
}
