// D1 查询封装：统一参数化、batch、条件更新、行映射
// 所有写操作汇聚主区域；批量用 batch()；高频额度扣减经 DO 聚合后落 D1（见 billing.ts）

export interface DBEnv {
  NEWAPI_DB: D1Database;
}

export class D1Store {
  constructor(private db: D1Database) {}

  get raw(): D1Database {
    return this.db;
  }

  /** 单行查询 */
  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    const bound = params.length ? stmt.bind(...(params as never[])) : stmt;
    const row = await bound.first<T>();
    return (row as T) ?? null;
  }

  /** 多行查询 */
  async all<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const bound = params.length ? stmt.bind(...(params as never[])) : stmt;
    const res = await bound.all<T>();
    return res.results as T[];
  }

  /** 执行写操作，返回变更行数 */
  async run(sql: string, params: unknown[] = []): Promise<number> {
    const stmt = this.db.prepare(sql);
    const bound = params.length ? stmt.bind(...(params as never[])) : stmt;
    const res = await bound.run();
    return res.meta.changes ?? 0;
  }

  /** 插入并返回 lastInsertRowid */
  async insert(sql: string, params: unknown[] = []): Promise<number> {
    const stmt = this.db.prepare(sql);
    const bound = params.length ? stmt.bind(...(params as never[])) : stmt;
    const res = await bound.run();
    return Number(res.meta.last_row_id ?? 0);
  }

  /** 条件更新：仅当满足 where 条件才扣减，返回是否成功（用于额度原子扣减） */
  async conditionalUpdate(
    sql: string,
    params: unknown[] = []
  ): Promise<boolean> {
    const changes = await this.run(sql, params);
    return changes > 0;
  }

  /** 批量执行（同事务） */
  async batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    return (await this.db.batch(statements)) as D1Result<unknown>[];
  }

  /** 构造参数化占位符 ?,?,? */
  static placeholders(n: number): string {
    return Array.from({ length: n }, () => '?').join(',');
  }
}
