// 本地契约集成测试：用 miniflare 起 Worker + 内存 D1/KV，灌入 migrations+seed，
// 断言「登录 → /api/user/self → /api/channel 列表 → 登出 → 刷新失效」全链路
// 与原版契约（HTTP 200 + {success,message,data}、access/refresh token、buildSelfUserData、type_counts）一致。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
let mf: Miniflare;
let baseUrl: string;

beforeAll(async () => {
  const opts: any = {
    modules: true,
    scriptPath: resolve(ROOT, 'dist/index.js'),
    wranglerConfigPath: false,
    compatibilityDate: '2024-09-23',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { AUTH_SECRET: 'contract-test-secret', DEFAULT_QUOTA: '500000' },
    kvNamespaces: { NEWAPI_KV: 'kv-contract' },
    d1Databases: { NEWAPI_DB: 'db-contract' },
    // ASSETS：静态资源 fallback 打到一个永不命中的 fetch，测试只打 /api/*
    serviceBindings: {
      ASSETS: async () => new Response('<!doctype html><html><body>spa</body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    },
  };
  mf = new Miniflare(opts);
  const ready: any = await mf.ready; // URL 对象
  baseUrl = String(ready.origin ?? ready).replace(/\/$/, '');

  // 灌入 D1 schema + seed（与本地 wrangler dev 同一套 SQL）
  const d1 = await mf.getD1Database('NEWAPI_DB');
  const schema = readFileSync(resolve(ROOT, 'src/storage/migrations.sql'), 'utf8');
  const seed = readFileSync(resolve(ROOT, 'seed.sql'), 'utf8');
  // miniflare 的 D1 exec 不接受纯注释语句；剥离 -- 注释后按分号逐条执行
  async function execSql(sql: string): Promise<void> {
    const stripped = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of stripped.split(';')) {
      const s = stmt.trim();
      if (s) await d1.prepare(s).run();
    }
  }
  await execSql(schema);
  await execSql(seed);
});

afterAll(async () => {
  if (mf) await mf.dispose();
});

function hit(path: string, init: RequestInit = {}): Promise<any> {
  return mf.dispatchFetch(`${baseUrl}${path}`, init as any) as Promise<any>;
}

describe('管理 API 响应信封契约（对齐 common/gin.go）', () => {
  it('未知端点返回 HTTP 200 + {success:false,message,code}', async () => {
    const res = await hit('/api/nope');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.message).toBe('string');
  });

  it('回带 X-Oneapi-Request-Id header（对齐 common/constants.go）', async () => {
    const res = await hit('/api/status');
    expect(res.headers.get('X-Oneapi-Request-Id')).toBeTruthy();
  });

  it('/api/status 返回 {success:true,message:"",data}', async () => {
    const res = await hit('/api/status');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe('');
    expect(body.data).toBeTypeOf('object');
  });
});

describe('登录 / access token / refresh cookie 契约（对齐 user.go + auth_session.go）', () => {
  let accessToken = '';
  let refreshCookie = '';

  it('bcrypt(cost10) 密码可登录，返回 access_token + session + user + 双 cookie', async () => {
    const res = await hit('/api/user/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'root12345' }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe('');
    // data: {access_token, token_type, access_expires_at, session, user}
    expect(body.data.access_token).toBeTypeOf('string');
    expect(body.data.token_type).toBe('Bearer');
    expect(body.data.access_expires_at).toBeTypeOf('number');
    expect(body.data.session.sid).toBeTypeOf('string');
    expect(body.data.session.login_method).toBe('password');
    // buildSelfUserData 字段
    expect(body.data.user.username).toBe('root');
    expect(body.data.user.role).toBe(100);
    expect(body.data.user.group).toBe('default');
    expect(body.data.user.has_password).toBe(true);
    expect(body.data.user.permissions.sidebar_settings).toBe(false); // root
    accessToken = body.data.access_token;

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    const joined = setCookies.join(' ; ');
    expect(joined).toContain('new_api_refresh=');
    expect(joined).toContain('new_api_has_session=1');
    expect(joined).toContain('Path=/api/user/auth');
    expect(joined).toContain('HttpOnly');
    expect(joined).toContain('SameSite=Strict');
    const m = joined.match(/new_api_refresh=([^;]+)/);
    refreshCookie = m ? m[1] : '';
  });

  it('错误密码返回 200 + success:false（非 4xx，前端只认 success）', async () => {
    const res = await hit('/api/user/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'wrong-password' }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(false);
  });

  it('access token Bearer 可调 /api/user/self，未带 token 返回 200 success:false', async () => {
    const noAuth = await hit('/api/user/self');
    expect(noAuth.status).toBe(200);
    expect((await noAuth.json() as any).success).toBe(false);

    const res = await hit('/api/user/self', { headers: { authorization: `Bearer ${accessToken}` } });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.username).toBe('root');
    expect(body.data.permissions.admin_permissions).toEqual({});
  });

  it('渠道列表（admin）返回 {items,total,page,page_size,type_counts} 且 type_counts 正确', async () => {
    const res = await hit('/api/channel/?p=0&page_size=10', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(5);
    expect(body.data.total).toBe(5);
    expect(body.data.page_size).toBe(10);
    expect(body.data.type_counts).toBeTypeOf('object');
    // 5 个渠道里 4 个唯一 type（1 出现 2 次 OpenAI + Broken）
    expect(body.data.type_counts['1']).toBe(2);
    // 列表项含 group 字段（"group" 列），不改名
    expect(body.data.items[0].group).toBeTypeOf('string');
    // 列表项含 key（原版 clearChannelInfo 不剥离）
    expect('key' in body.data.items[0]).toBe(true);
  });

  it('分页默认 page_size=20（对齐 controller/channel.go）', async () => {
    const res = await hit('/api/channel/', { headers: { authorization: `Bearer ${accessToken}` } });
    const body: any = await res.json();
    expect(body.data.page_size).toBe(20);
  });

  it('非 admin 访问渠道列表返回 200 success:false（role>=10 判定）', async () => {
    const login = await hit('/api/user/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'user1', password: 'user12345' }),
    });
    const lb: any = await login.json();
    expect(lb.data.user.role).toBe(1);
    expect(lb.data.user.permissions.sidebar_modules.admin).toBe(false);
    const res = await hit('/api/channel/', { headers: { authorization: `Bearer ${lb.data.access_token}` } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).success).toBe(false);
  });

  it('refresh token 可换新 access token；登出后 refresh 失效', async () => {
    const r1 = await hit('/api/user/auth/refresh', {
      method: 'POST', headers: { cookie: `new_api_refresh=${refreshCookie}` },
    });
    expect(r1.status).toBe(200);
    expect((await r1.json() as any).data.access_token).toBeTypeOf('string');

    const logout = await hit('/api/user/auth/logout', {
      method: 'POST', headers: { cookie: `new_api_refresh=${refreshCookie}` },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie') || (logout.headers as any).getSetCookie?.().join(';')).toMatch(/new_api_refresh=/);

    const r2 = await hit('/api/user/auth/refresh', {
      method: 'POST', headers: { cookie: `new_api_refresh=${refreshCookie}` },
    });
    expect(r2.status).toBe(200);
    const b2: any = await r2.json();
    expect(b2.success).toBe(false);
    expect(b2.code).toBe('AUTH_REFRESH_TOKEN_INVALID');
  });
});

describe('relay token 鉴权契约（/v1/*）', () => {
  it('seed token 的 key_hash=SHA256 可过鉴权，/v1/models 返回 OpenAI list 结构', async () => {
    const res = await hit('/v1/models', {
      headers: { authorization: 'Bearer sk-worker-seed-token-unlimited' },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    // 白名单外：无限额度 token 属 user1(default 组)，应能看到 default 组渠道的所有模型
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('无效 api key 返回 401 + OpenAI 错误对象 {error:{message,type,param,code}}', async () => {
    const res = await hit('/v1/models', { headers: { authorization: 'Bearer sk-invalid' } });
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error.message).toBeTypeOf('string');
    expect(body.error.type).toBe('authentication_error');
    expect('param' in body.error).toBe(true);
    expect('code' in body.error).toBe(true);
  });
});
