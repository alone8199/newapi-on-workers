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

/** 分页参数解析 */
export function parsePagination(url: URL): { page: number; perPage: number; offset: number } {
  const page = Math.max(1, Number(url.searchParams.get('p')) || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size')) || 10));
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
// 密码哈希（Workers 无 bcrypt；用 PBKDF2-SHA256 等价替代）
// 存储格式：pbkdf2$<saltHex>$<hashHex>
// ─────────────────────────────────────────────
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hash = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const saltHex = [...salt].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$${saltHex}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') {
    // LIMITATION: 兼容旧明文（迁移期），生产应强制重哈希
    return stored === password;
  }
  const salt = Uint8Array.from(parts[1].match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hash = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hash === parts[2];
}
