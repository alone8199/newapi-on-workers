// 通用工具：错误结构、token 估算、分页、JSON 响应

// OpenAI 风格错误响应（原版统一错误结构）
export interface APIError {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | number | null;
  };
}

export function errorResponse(
  message: string,
  status = 400,
  type = 'invalid_request_error',
  code: string | number | null = null,
  param: string | null = null
): Response {
  const body: APIError = { error: { message, type, param, code } };
  return json(body, status);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** 粗略 token 估算（中文≈1.6 字符/token，英文≈4 字符/token） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const nonCjk = text.length - cjk;
  return Math.ceil(cjk / 1.6 + nonCjk / 4);
}

/** 从 messages 估算 prompt tokens（含角色与内容） */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: unknown }>
): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // 每条消息开销
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content as Array<{ type: string; text?: string }>) {
        if (part.type === 'text' && part.text) total += estimateTokens(part.text);
      }
    }
  }
  return total + 2;
}

/** 分页参数解析（对齐原版：默认 page_size=20，参数 p / page_size） */
export function parsePagination(url: URL): { page: number; perPage: number; offset: number } {
  const page = Math.max(1, Number(url.searchParams.get('p')) || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size')) || 20));
  const offset = (page - 1) * perPage;
  return { page, perPage, offset };
}

/** 生成安全随机 token（sk- 前缀） */
export async function generateToken(prefix = 'sk-', bytes = 24): Promise<string> {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return prefix + s;
}

/** 派生 key 哈希（不存明文） */
export async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** AES-GCM 加密（用于渠道 key 静态保护，密钥来自 MASTER_KEY） */
export async function encryptSecret(plain: string, masterKey: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(masterKey.padEnd(32).slice(0, 32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyMaterial, enc.encode(plain));
  const merged = new Uint8Array(iv.length + ct.byteLength);
  merged.set(iv, 0);
  merged.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...merged));
}
export async function decryptSecret(cipher: string, masterKey: string): Promise<string> {
  const merged = Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0));
  const iv = merged.slice(0, 12);
  const ct = merged.slice(12);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(masterKey.padEnd(32).slice(0, 32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyMaterial, ct);
  return new TextDecoder().decode(pt);
}

// ─────────────────────────────────────────────
// 密码哈希：bcrypt(cost=10)，与原版（QuantumNous/new-api）一致。
// 存储格式：$2a$10$... / $2b$10$...（bcryptjs 生成）。
// 共用 seed.sql 用 bcrypt 生成，因此 Worker 必须能验证同一哈希 → 引入 bcryptjs（纯 JS，Workers 可用）。
// 兼容项：$argon2id$ 前缀（原版 ValidatePasswordAndHash 支持）本实现不直接验证，按 LIMITATION 处理：
//   若哈希以 $argon2id$ 开头且无法 bcrypt 校验，视为校验失败（不影响 bcrypt 账户）。
// ─────────────────────────────────────────────
import bcrypt from 'bcryptjs';

export const BCRYPT_COST = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith('$argon2id$')) {
    // LIMITATION: Workers 无原生 argon2；seed 与 Worker 自建账户均用 bcrypt，故 argon2 账户无法在 Worker 侧校验。
    return false;
  }
  try {
    return await bcrypt.compare(password, stored);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// 访问令牌（Access Token）：HMAC-SHA256 签名的紧凑 JWT 形令牌。
// 前端不解析，仅作为 Bearer 回传；Worker 自签发自校验，无需外部密钥服务。
// payload: { uid, sid, role, av, iat, exp }
// ─────────────────────────────────────────────
export interface AccessTokenClaims {
  uid: number;
  sid: string;
  role: number;
  av: number; // auth_version
  iat: number;
  exp: number;
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}
async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

export const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 7; // 7 天

export async function issueAccessToken(claims: Omit<AccessTokenClaims, 'iat' | 'exp'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full: AccessTokenClaims = { ...claims, iat: now, exp: now + ACCESS_TOKEN_TTL };
  const header = b64urlJson({ alg: 'HS256', typ: 'at' });
  const payload = b64urlJson(full);
  const sig = await hmac(ACCESS_SECRET(), `${header}.${payload}`);
  return `${header}.${payload}.${b64url(sig)}`;
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = await hmac(ACCESS_SECRET(), `${header}.${payload}`);
  const got = b64urlDecodeBytes(sig);
  if (!constTimeEqual(expected, got)) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecodeBytes(payload))) as AccessTokenClaims;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

function b64urlDecodeBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  return Uint8Array.from(atob(b64 + '='.repeat(pad)), (c) => c.charCodeAt(0));
}
function constTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

let _accessSecret: string | null = null;
function ACCESS_SECRET(): string {
  // 运行时由 setAccessSecret(env.AUTH_SECRET) 注入；缺失时回退固定值（仅本地/测试，生产必须配置 AUTH_SECRET）。
  return _accessSecret || 'newapi-on-workers-dev-secret';
}
export function setAccessSecret(secret: string): void {
  if (secret) _accessSecret = secret;
}
