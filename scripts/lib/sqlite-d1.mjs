/**
 * 最小 D1 兼容层（基于 Node 内置 node:sqlite），供本地开发服务器与集成测试共用。
 *
 * 只实现 Pages Functions 里实际用到的那几个方法：prepare / bind / first / run / all / batch。
 * 真实 D1 的行为：batch() 在一个事务里顺序执行，每条返回一个 { results, success, meta }。
 *
 * 需要 Node ≥ 22.5（node:sqlite）。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; this.stmt = null; }
  bind(...args) {
    const s = new Stmt(this.db, this.sql);
    s.args = args.map(v => (v === undefined ? null : v));
    return s;
  }
  _prep() { if (!this.stmt) this.stmt = this.db.prepare(this.sql); return this.stmt; }
  _rows() {
    const raw = this._prep().all(...this.args);
    return raw.map(r => ({ ...r }));      // 去掉 null 原型，贴近 D1 的普通对象
  }
  async first() { const r = this._rows(); return r.length ? r[0] : null; }
  async all() { return { results: this._rows(), success: true, meta: {} }; }
  async run() {
    const info = this._prep().run(...this.args);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid }, results: [] };
  }
}

class D1 {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new Stmt(this.sqlite, sql); }
  async batch(stmts) {
    this.sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) {
        out.push(/^\s*(select|with|pragma)/i.test(s.sql) ? await s.all() : await s.run());
      }
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  /** 直接跑一段裸 SQL（建表、测试断言用） */
  async exec(sql) { this.sqlite.exec(sql); }
}

export function migrationSql() {
  return readFileSync(join(root, "migrations/0001_sync_auth.sql"), "utf8");
}

/** 建库并执行迁移。path 传 ":memory:" 得到一次性的内存库。 */
export function createD1(path = ":memory:") {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(migrationSql());
  return new D1(sqlite);
}
