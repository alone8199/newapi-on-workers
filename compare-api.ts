#!/usr/bin/env npx tsx
// ============================================================================
// compare-api.ts —— 契约逐端点 diff 工具（收尾任务第 2 步核心）
//
// 用法（本地起好原版 :3000 与 wrangler dev :8787 后）：
//   ORIGIN=http://localhost:3000 WORKER=http://localhost:8787 npx tsx compare-api.ts
//   ORIGIN=http://localhost:3000 WORKER=http://localhost:8787 npx tsx compare-api.ts --case=login
//   CHECK_SIDE_EFFECTS=1 ... （额外比对计费副作用，需两端都可读 DB，见 README）
//
// 输出：
//   - 终端逐用例 PASS/FAIL + 差异摘要
//   - diffs/<case>.json  每个非空 diff 的完整结构（左右值）
//   - diffs/summary.json 汇总
//
// 归一化规则（严格遵循收尾铁律，只允许处理「真正易变」字段，禁止掩盖结构差异）：
//   - id / *_id / created / created_at / created_time / access_expires_at / updated_at /
//     last_active_at / expires_at / request_id / X-Oneapi-Request-Id / system_fingerprint /
//     use_time / response_time / 各类耗时 → 占位符 <VAR>
//   - token 明文 / access_token / refresh_token / key（渠道密钥）→ <VAR>
//   - 无序集合（/v1/models 的 data、type_counts 的键序）排序后比；业务有序集合（logs 按时间倒序）保持原序
//   - 数组顺序默认保持（不做排序），仅对显式声明 sortPaths 的路径排序
// ============================================================================

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';
const WORKER = process.env.WORKER || 'http://localhost:8787';
const OUT_DIR = resolve(process.cwd(), 'diffs');
const CASE_FILTER = (process.argv.find((a) => a.startsWith('--case=')) || '').split('=')[1];

// 固定测试凭据：与 seed.sql 一致（root/admin/user1 密码、3 个令牌、5 个渠道）
const CREDS = {
  root: { username: 'root', password: 'root12345' },
  admin: { username: 'admin', password: 'admin1234' },
  user1: { username: 'user1', password: 'user12345' },
  tokenUnlimited: 'sk-worker-seed-token-unlimited',
  tokenLow: 'sk-worker-seed-token-low',
  tokenWhitelist: 'sk-worker-seed-token-whitelist',
};

interface Case {
  name: string;
  method: string;
  path: string;
  auth?: 'token-unlimited' | 'token-low' | 'token-whitelist' | 'session-root' | 'session-admin' | 'session-user1';
  body?: any;
  headers?: Record<string, string>;
  // 需要归一化的 JSON 路径（点号/通配符）
  normalizePaths?: string[];
  // 需要排序后比较的数组路径
  sortPaths?: string[];
  // 跳过该用例（如上游需真实 key）
  skip?: boolean;
  note?: string;
}

// ── 端点覆盖清单（对齐收尾任务 §2.3）──
const CASES: Case[] = [
  // /v1 OpenAI 原生
  { name: 'v1-chat-nostream', method: 'POST', path: '/v1/chat/completions', auth: 'token-unlimited',
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    normalizePaths: ['id', 'created', 'system_fingerprint', 'usage'], skip: true, note: '需真实上游 key' },
  { name: 'v1-chat-stream', method: 'POST', path: '/v1/chat/completions', auth: 'token-unlimited',
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } },
    skip: true, note: '需真实上游 key；流式按 chunk 逐条 diff' },
  { name: 'v1-models', method: 'GET', path: '/v1/models', auth: 'token-unlimited', sortPaths: ['data'] },
  { name: 'v1-embeddings', method: 'POST', path: '/v1/embeddings', auth: 'token-unlimited',
    body: { model: 'text-embedding-3-small', input: 'hello' }, skip: true, note: '需真实上游 key' },
  { name: 'v1-messages', method: 'POST', path: '/v1/messages', auth: 'token-unlimited',
    body: { model: 'claude-3-haiku', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    skip: true, note: 'Claude 入口，需真实上游 key' },
  { name: 'v1-messages-count-tokens', method: 'POST', path: '/v1/messages/count_tokens', auth: 'token-unlimited',
    body: { model: 'claude-3-haiku', messages: [{ role: 'user', content: 'hi' }] }, skip: true, note: '需确认原版路由注册' },
  { name: 'v1-moderations', method: 'POST', path: '/v1/moderations', auth: 'token-unlimited',
    body: { input: 'hello' }, skip: true, note: '需真实上游 key' },
  { name: 'v1-rerank', method: 'POST', path: '/v1/rerank', auth: 'token-unlimited',
    body: { model: 'rerank', query: 'q', documents: ['a', 'b'] }, skip: true, note: '需真实上游 key' },
  { name: 'v1-responses', method: 'POST', path: '/v1/responses', auth: 'token-unlimited',
    body: { model: 'gpt-4o-mini', input: 'hi' }, skip: true, note: '需真实上游 key' },
  { name: 'v1-completions', method: 'POST', path: '/v1/completions', auth: 'token-unlimited',
    body: { model: 'gpt-4o-mini', prompt: 'hi' }, skip: true, note: '需真实上游 key' },
  // /pg 游乐场
  { name: 'pg-chat', method: 'POST', path: '/pg/chat/completions', auth: 'session-root',
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }, skip: true, note: '需真实上游 key' },
  // 管理 API（无需真实上游，优先跑）
  { name: 'api-status', method: 'GET', path: '/api/status' },
  { name: 'api-login-root', method: 'POST', path: '/api/user/login', body: CREDS.root,
    normalizePaths: ['data.access_token', 'data.access_expires_at', 'data.session'] },
  { name: 'api-login-wrong-password', method: 'POST', path: '/api/user/login',
    body: { username: 'root', password: 'wrong' } },
  { name: 'api-self', method: 'GET', path: '/api/user/self', auth: 'session-root' },
  { name: 'api-channel-list', method: 'GET', path: '/api/channel/?p=0&page_size=10', auth: 'session-root',
    normalizePaths: ['data.items[*].key'], sortPaths: [] },
  { name: 'api-channel-list-default-page', method: 'GET', path: '/api/channel/', auth: 'session-root',
    normalizePaths: ['data.items[*].key'] },
  { name: 'api-token-list', method: 'GET', path: '/api/token/', auth: 'session-root' },
  { name: 'api-log-list', method: 'GET', path: '/api/log/', auth: 'session-root' },
  { name: 'api-option-list', method: 'GET', path: '/api/option/', auth: 'session-root' },
  { name: 'api-group-list', method: 'GET', path: '/api/group/', auth: 'session-root' },
  { name: 'api-pricing-list', method: 'GET', path: '/api/pricing/', auth: 'session-root' },
  { name: 'api-model-list', method: 'GET', path: '/api/model/', auth: 'session-root' },
  { name: 'api-redemption-redeem-invalid', method: 'POST', path: '/api/redemption/redeem', auth: 'session-root',
    body: { code: 'INVALID' } },
  { name: 'api-permission-denied', method: 'GET', path: '/api/channel/', auth: 'session-user1' },
  { name: 'api-no-auth', method: 'GET', path: '/api/user/self' },
  // 任务型端点（提交查询，需 mock 上游或占位）
  { name: 'tasks-mj-submit', method: 'POST', path: '/mj/submit/imagine', auth: 'token-unlimited',
    body: { prompt: 'a cat' }, skip: true, note: '需 mock 上游；状态机在 D1' },
];

// ── 归一化 ──
const VOLATILE_KEYS = new Set([
  'id', 'created', 'created_at', 'created_time', 'updated_at', 'last_active_at', 'expires_at',
  'access_expires_at', 'request_id', 'system_fingerprint', 'use_time', 'response_time',
  'prompt_time', 'completion_time', 'test_time', 'balance_updated_time', 'redeemed_time',
  'accessed_time', 'last_login_at', 'token', 'key', 'access_token', 'refresh_token', 'password',
  'session', 'request_detail', 'x-oneapi-request-id',
]);
const VAR = '<VAR>';

function normalize(value: any, sortPaths: string[], path = ''): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const arr = value.map((v, i) => normalize(v, sortPaths, `${path}[${i}]`));
    if (sortPaths.some((p) => matchPath(path, p))) {
      return arr.map((v) => JSON.stringify(v)).sort().map((s) => JSON.parse(s));
    }
    return arr;
  }
  if (typeof value === 'object') {
    const out: any = {};
    for (const k of Object.keys(value).sort()) {
      const childPath = path ? `${path}.${k}` : k;
      if (VOLATILE_KEYS.has(k.toLowerCase())) out[k] = VAR;
      else out[k] = normalize(value[k], sortPaths, childPath);
    }
    return out;
  }
  return value;
}

function matchPath(path: string, pattern: string): boolean {
  // 支持 data / data[*].key 之类简单通配
  const rx = new RegExp('^' + pattern.replace(/\[\*\]/g, '\\[[^\\]]+\\]').replace(/\./g, '\\.') + '$');
  return rx.test(path);
}

// ── 结构化 diff ──
type Diff = { path: string; origin: any; worker: any };
function deepDiff(a: any, b: any, path = '', out: Diff[] = []): Diff[] {
  if (a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    out.push({ path: path || '<root>', origin: a, worker: b });
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      out.push({ path: path || '<root>', origin: a, worker: b });
      return out;
    }
    for (let i = 0; i < a.length; i++) deepDiff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in a)) out.push({ path: p, origin: '<missing>', worker: b[k] });
    else if (!(k in b)) out.push({ path: p, origin: a[k], worker: '<missing>' });
    else deepDiff(a[k], b[k], p, out);
  }
  return out;
}

// ── 请求发送 ──
async function hit(base: string, c: Case, authHeaders: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; body: any; raw: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(c.headers || {}), ...authHeaders };
  let res: Response;
  try {
    res = await fetch(`${base}${c.path}`, {
      method: c.method,
      headers,
      body: c.body ? JSON.stringify(c.body) : undefined,
    });
  } catch (e) {
    return { status: 0, headers: {}, body: null, raw: `FETCH_ERROR: ${String(e)}` };
  }
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  // 只保留少量稳定 header 参与 diff
  const h: Record<string, string> = {};
  for (const k of ['content-type', 'cache-control', 'x-oneapi-request-id']) {
    const v = res.headers.get(k);
    if (v) h[k] = k.includes('request-id') ? VAR : v;
  }
  return { status: res.status, headers: h, body, raw };
}

async function getAuthHeaders(base: string, auth: Case['auth']): Promise<Record<string, string>> {
  if (!auth) return {};
  if (auth === 'token-unlimited') return { authorization: `Bearer ${CREDS.tokenUnlimited}` };
  if (auth === 'token-low') return { authorization: `Bearer ${CREDS.tokenLow}` };
  if (auth === 'token-whitelist') return { authorization: `Bearer ${CREDS.tokenWhitelist}` };
  // session-*：登录取 access_token 作 Bearer（新版前端行为）；refresh cookie 单独在登录用例比对
  const cred = auth === 'session-root' ? CREDS.root : auth === 'session-admin' ? CREDS.admin : CREDS.user1;
  const r = await fetch(`${base}/api/user/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cred),
  });
  const j: any = await r.json().catch(() => ({}));
  return j?.data?.access_token ? { authorization: `Bearer ${j.data.access_token}` } : {};
}

function normalizeResponse(r: Awaited<ReturnType<typeof hit>>, c: Case): any {
  return {
    status: r.status,
    headers: r.headers,
    body: normalize(r.body, c.sortPaths || [], ''),
  };
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const cases = CASE_FILTER ? CASES.filter((c) => c.name.includes(CASE_FILTER)) : CASES;
  const summary: any[] = [];
  let pass = 0, fail = 0, skipped = 0;

  for (const c of cases) {
    if (c.skip) {
      skipped++;
      summary.push({ case: c.name, result: 'SKIP', reason: c.note });
      console.log(`⊘ SKIP  ${c.name} — ${c.note}`);
      continue;
    }
    const [ao, aw] = await Promise.all([getAuthHeaders(ORIGIN, c.auth), getAuthHeaders(WORKER, c.auth)]);
    const [ro, rw] = await Promise.all([hit(ORIGIN, c, ao), hit(WORKER, c, aw)]);
    const no = normalizeResponse(ro, c);
    const nw = normalizeResponse(rw, c);
    const diffs = deepDiff(no, nw);
    if (diffs.length === 0) {
      pass++;
      summary.push({ case: c.name, result: 'PASS' });
      console.log(`✓ PASS  ${c.name}`);
    } else {
      fail++;
      writeFileSync(resolve(OUT_DIR, `${c.name}.json`), JSON.stringify({ case: c, origin: no, worker: nw, diffs }, null, 2));
      summary.push({ case: c.name, result: 'FAIL', diffCount: diffs.length, file: `diffs/${c.name}.json` });
      console.log(`✗ FAIL  ${c.name}  (${diffs.length} diffs)`);
      for (const d of diffs.slice(0, 5)) {
        console.log(`        ${d.path}\n          ORIGIN: ${JSON.stringify(d.origin)?.slice(0, 160)}\n          WORKER: ${JSON.stringify(d.worker)?.slice(0, 160)}`);
      }
      if (diffs.length > 5) console.log(`        … 其余 ${diffs.length - 5} 条见 diffs/${c.name}.json`);
    }
  }

  writeFileSync(resolve(OUT_DIR, 'summary.json'), JSON.stringify({ ORIGIN, WORKER, pass, fail, skipped, total: cases.length, cases: summary }, null, 2));
  console.log(`\n===== 汇总：PASS ${pass} / FAIL ${fail} / SKIP ${skipped} / TOTAL ${cases.length} =====`);
  console.log(`diffs 输出目录：${OUT_DIR}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
