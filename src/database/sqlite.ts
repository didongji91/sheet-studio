import initSqlJs, { type Database, type SqlJsStatic, type Statement } from 'sql.js';
import type { DbColumn, DbDriver, DbForeignKey, DbIndex, DbObject, DbValue, QueryResult, TableDetail } from './types';
import { dbValue, firstKeyword, nativeValue, objectName, quoteIdentifier, records, validateUserSql } from './sql';

let runtime: Promise<SqlJsStatic> | undefined;
export function sqliteRuntime(wasmBinary?: Uint8Array): Promise<SqlJsStatic> {
  return (runtime ??= initSqlJs(wasmBinary ? { wasmBinary: Uint8Array.from(wasmBinary).buffer } : {}));
}
export function isSqliteFile(bytes: Uint8Array): boolean {
  return !bytes.length || Buffer.from(bytes.subarray(0, 16)).toString('binary') === 'SQLite format 3\0';
}
export class SqliteEngine implements DbDriver {
  readonly kind = 'sqlite' as const;
  private constructor(
    private SQL: SqlJsStatic,
    private db: Database,
  ) {
    this.db.run('PRAGMA foreign_keys = ON');
  }
  static async open(bytes: Uint8Array = new Uint8Array(), wasmBinary?: Uint8Array): Promise<SqliteEngine> {
    if (!isSqliteFile(bytes))
      throw new Error(
        '此文件不是 SQLite 3 数据库，或已加密。扩展名 .db 不能代表具体数据库格式；Access、DuckDB 等需要各自驱动。',
      );
    const SQL = await sqliteRuntime(wasmBinary);
    const db = new SQL.Database(bytes.length ? bytes : undefined);
    try {
      db.exec('SELECT name FROM sqlite_schema LIMIT 1');
      return new SqliteEngine(SQL, db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  image(): Uint8Array {
    const image = this.db.export();
    this.db.run('PRAGMA foreign_keys = ON');
    return image;
  }
  restore(bytes: Uint8Array) {
    const next = new this.SQL.Database(bytes);
    next.run('PRAGMA foreign_keys = ON');
    this.db.close();
    this.db = next;
  }
  private readStatement(statement: Statement, limit: number): QueryResult {
    const start = performance.now(),
      columns = statement.getColumnNames(),
      rows: DbValue[][] = [];
    let truncated = false;
    while (statement.step()) {
      if (rows.length < limit) rows.push((statement as any).get(undefined, { useBigInt: true }).map(dbValue));
      else {
        truncated = true;
        if (firstKeyword(statement.getSQL()) === 'SELECT') break;
      }
    }
    return { columns, rows, affectedRows: 0, elapsedMs: performance.now() - start, truncated };
  }
  private totalChanges(): number {
    return Number(this.db.exec('SELECT total_changes()')[0]?.values[0]?.[0] ?? 0);
  }
  async query(sql: string, params: DbValue[] = [], limit = 1000): Promise<QueryResult[]> {
    const before = this.totalChanges(),
      statement = this.db.prepare(sql);
    try {
      if (params.length)
        statement.bind(
          params.map((v) => {
            const value = nativeValue(v);
            return typeof value === 'boolean' ? Number(value) : value;
          }),
        );
      const result = this.readStatement(statement, limit);
      if (this.totalChanges() > before) result.affectedRows = this.db.getRowsModified();
      return [result];
    } finally {
      statement.free();
    }
  }
  async execute(sql: string, limit = 1000): Promise<QueryResult[]> {
    validateUserSql(sql, true);
    const results: QueryResult[] = [];
    let explicitBegin = false,
      explicitEnd = false,
      count = 0;
    this.db.run('SAVEPOINT sheet_studio_script');
    this.db.run('PRAGMA defer_foreign_keys=ON');
    try {
      for (const statement of this.db.iterateStatements(sql)) {
        if (++count > 10000) throw new Error('一次最多执行 10000 条 SQL，请分批导入。');
        const keyword = firstKeyword(statement.getSQL());
        if (keyword === 'BEGIN') {
          if (explicitBegin) throw new Error('SQLite 文件模式不支持嵌套事务。');
          explicitBegin = true;
          continue;
        }
        if (keyword === 'COMMIT' || keyword === 'END') {
          if (!explicitBegin || explicitEnd) throw new Error('事务结束语句缺少对应的 BEGIN。');
          explicitEnd = true;
          continue;
        }
        if (['ROLLBACK', 'SAVEPOINT', 'RELEASE', 'ATTACH', 'DETACH', 'VACUUM'].includes(keyword))
          throw new Error('文件模式不支持附加数据库或直接管理事务；每次 SQL 执行会自动作为一个事务。');
        const before = this.totalChanges(),
          result = this.readStatement(statement, limit);
        if (this.totalChanges() > before) result.affectedRows = this.db.getRowsModified();
        if (results.length < 20) results.push(result);
        else {
          results[19].affectedRows += result.affectedRows;
          results[19].truncated = true;
        }
      }
      if (explicitBegin && !explicitEnd) throw new Error('SQL 脚本中的 BEGIN 缺少 COMMIT，整批修改已回滚。');
      this.db.run('RELEASE SAVEPOINT sheet_studio_script');
      return results;
    } catch (error) {
      this.db.run('ROLLBACK TO SAVEPOINT sheet_studio_script');
      this.db.run('RELEASE SAVEPOINT sheet_studio_script');
      throw error;
    }
  }
  async catalog(): Promise<DbObject[]> {
    return records(
      await this.query(
        "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        [],
        10000,
      ),
    ).map((row) => ({
      schema: 'main',
      name: String(row.name),
      type: row.type as 'table' | 'view',
      sql: String(row.sql ?? ''),
    }));
  }
  async describe(object: DbObject): Promise<TableDetail> {
    const actual = (await this.catalog()).find((o) => o.name === object.name && o.schema === object.schema);
    if (!actual) throw new Error('数据库对象不存在，请刷新对象列表。');
    const columns: DbColumn[] = records(
      await this.query('SELECT * FROM pragma_table_xinfo(?)', [actual.name], 10000),
    ).map((row) => ({
      name: String(row.name),
      type: String(row.type || 'ANY'),
      notNull: !!row.notnull,
      defaultValue: row.dflt_value === null ? null : String(row.dflt_value),
      primaryKey: Number(row.pk),
      generated: Number(row.hidden) > 0,
    }));
    const indexes: DbIndex[] = [];
    for (const row of records(await this.query('SELECT * FROM pragma_index_list(?)', [actual.name], 10000))) {
      const items = records(await this.query('SELECT * FROM pragma_index_info(?)', [row.name], 10000));
      const ddl = records(await this.query('SELECT sql FROM sqlite_schema WHERE name = ?', [row.name]))[0];
      indexes.push({
        name: String(row.name),
        unique: !!row.unique,
        columns: items.map((c) => String(c.name ?? '(表达式)')),
        definition: String(ddl?.sql ?? ''),
      });
    }
    const foreignKeys: DbForeignKey[] = records(
      await this.query('SELECT * FROM pragma_foreign_key_list(?)', [actual.name], 10000),
    ).map((row) => ({
      name: `fk_${row.id}`,
      column: String(row.from),
      target: String(row.table),
      targetColumn: String(row.to ?? '(主键)'),
    }));
    let identityColumns = columns
        .filter((c) => c.primaryKey)
        .sort((a, b) => a.primaryKey - b.primaryKey)
        .map((c) => c.name),
      rowidAlias: string | undefined;
    if (
      !identityColumns.length &&
      actual.type === 'table' &&
      !/\bWITHOUT\s+ROWID\b/i.test(actual.sql ?? '') &&
      !/^CREATE\s+VIRTUAL/i.test(actual.sql ?? '')
    ) {
      rowidAlias = ['_rowid_', 'rowid', 'oid'].find((name) => !columns.some((c) => c.name.toLowerCase() === name));
      if (rowidAlias) identityColumns = [rowidAlias];
    }
    return { object: actual, columns, indexes, foreignKeys, ddl: actual.sql || '', identityColumns, rowidAlias };
  }
  async dump(): Promise<string> {
    const objects = records(
      await this.query(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END",
        [],
        10000,
      ),
    );
    const lines = ['-- Sheet Studio SQLite 导出', 'PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
    let length = 0;
    const append = (text: string) => {
      length += text.length;
      if (length > 32_000_000) throw new Error('SQL 导出超过 32 MB，请导出数据库副本。');
      lines.push(text);
    };
    const literal = (value: DbValue) =>
      value === null
        ? 'NULL'
        : typeof value === 'number'
          ? String(value)
          : typeof value === 'boolean'
            ? String(Number(value))
            : typeof value === 'object'
              ? `X'${value.hex}'`
              : "'" + value.replaceAll("'", "''") + "'";
    const tables = objects.filter((o) => o.type === 'table');
    for (const object of tables) {
      if (/^CREATE\s+VIRTUAL/i.test(String(object.sql)))
        throw new Error('包含虚拟表，请使用数据库副本导出以保留全部数据。');
      append(String(object.sql) + ';');
    }
    for (const object of tables) {
      const detail = await this.describe({ schema: 'main', name: String(object.name), type: 'table' });
      const columns = detail.columns.filter((c) => !c.generated),
        names = columns.map((c) => quoteIdentifier('sqlite', c.name)).join(', ');
      const statement = this.db.prepare(`SELECT ${names} FROM ${objectName('sqlite', detail.object)}`);
      try {
        while (statement.step())
          append(
            `INSERT INTO ${quoteIdentifier('sqlite', String(object.name))} (${names}) VALUES (${(statement as any)
              .get(undefined, { useBigInt: true })
              .map((value: unknown) => (typeof value === 'bigint' ? String(value) : literal(dbValue(value))))
              .join(', ')});`,
          );
      } finally {
        statement.free();
      }
    }
    for (const object of objects.filter((o) => o.type !== 'table')) append(String(object.sql) + ';');
    lines.push('COMMIT;', 'PRAGMA foreign_keys=ON;');
    return lines.join('\n');
  }
  async begin() {
    this.db.run('BEGIN');
  }
  async commit() {
    this.db.run('COMMIT');
  }
  async rollback() {
    this.db.run('ROLLBACK');
  }
  async close() {
    this.db.close();
  }
}
