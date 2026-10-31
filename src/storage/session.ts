// Session 会话生命周期（KV 为主，D1 双写便于审计）
// cookie 名称/path/httpOnly/SameSite 与原版一致，见 ARCHITECTURE.md §9

import { D1Store } from './d1';
import { KVStore } from './kv';

const SESSION_COOKIE_NAME = 'new-api-sessionid';
const SESSION_TTL = 2592000; // 30 天（秒）

export interface SessionData {
  id: string;
  user_id: number;
  role: number;
  ip: string;
  created_at: number;
  expires_at: number;
}

export class SessionStore {
  constructor(private kv: KVStore, private db: D1Store) {}

  async create(
    userId: number,
    role: number,
    ip: string
  ): Promise<SessionData> {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const session: SessionData = {
      id,
      user_id: userId,
      role,
      ip,
      created_at: now,
      expires_at: now + SESSION_TTL,
    };
    await this.kv.putSession(id, session);
    await this.db.run(
      `INSERT OR REPLACE INTO sessions (id, user_id, role, ip, created_at, expires_at)
       VALUES (?,?,?,?,?,?)`,
      [id, userId, role, ip, now, session.expires_at]
    );
    return session;
  }

  async get(id: string): Promise<SessionData | null> {
    const s = await this.kv.getSession<SessionData>(id);
    if (!s) return null;
    if (s.expires_at < Math.floor(Date.now() / 1000)) {
      await this.destroy(id);
      return null;
    }
    return s;
  }

  async destroy(id: string): Promise<void> {
    await this.kv.deleteSession(id);
    await this.db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
  }

  /** 生成 Set-Cookie 头（与原版一致） */
  static cookieHeader(id: string, secure: boolean): string {
    const parts = [
      `${SESSION_COOKIE_NAME}=${id}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (secure) parts.push('Secure');
    parts.push(`Max-Age=${SESSION_TTL}`);
    return parts.join('; ');
  }

  static get cookieName(): string {
    return SESSION_COOKIE_NAME;
  }
}
