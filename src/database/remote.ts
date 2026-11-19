import { Client, Query } from 'pg';
import mysql, { type Connection } from 'mysql2';
import mssql from 'mssql';
import type {
  ConnectionProfile,
  DbColumn,
  DbDriver,
  DbForeignKey,
  DbIndex,
  DbObject,
  DbValue,
  QueryResult,
  RemoteKind,
  TableDetail,
} from './types';
import { basicDdl, dbValue, nativeValue, objectName, records, validateProfile } from './sql';

export class RemoteDriver implements DbDriver {
  readonly kind: RemoteKind;
  private pg?: Client;
  private mysql?: Connection;
  private pool?: mssql.ConnectionPool;
  private transaction?: mssql.Transaction;
  private requests = new Set<mssql.Request>();
  private queryCancellations = new Set<() => void>();
  private failure = '';
  private constructor(readonly profile: ConnectionProfile) {
    this.kind = profile.kind;
  }
  static async connect(profile: ConnectionProfile, password: string): Promise<RemoteDriver> {
    profile = validateProfile(profile);
    const driver = new RemoteDriver(profile),
      ssl = profile.ssl === 'off' ? undefined : { rejectUnauthorized: profile.ssl === 'verify' };
    try {
      if (profile.kind === 'postgres') {
        const client = (driver.pg = new Client({
          host: profile.host,
          port: profile.port,
          database: profile.database,
          user: profile.username,
          password,
          ssl,
          connectionTimeoutMillis: 10000,
          statement_timeout: 30000,
          lock_timeout: 10000,
          application_name: 'Sheet Studio',
          keepAlive: true,
        }));
        client.on('error', (error) => {
          driver.failure = error.message;
        });
        await client.connect();
      } else if (profile.kind === 'mysql' || profile.kind === 'mariadb') {
        const connection = (driver.mysql = mysql.createConnection({
          host: profile.host,
          port: profile.port,
          database: profile.database,
          user: profile.username,
          password,
          ssl,
          connectTimeout: 10000,
          supportBigNumbers: true,
          bigNumberStrings: true,
          dateStrings: true,
          rowsAsArray: true,
          multipleStatements: true,
          enableKeepAlive: true,
          infileStreamFactory: () => {
            throw new Error('请通过“导入 CSV”导入数据。');
          },
        }));
        connection.on('error', (error) => {
          driver.failure = error.message;
        });
        await new Promise<void>((resolve, reject) =>
          connection.connect((error) => (error ? reject(error) : resolve())),
        );
      } else {
        const pool = (driver.pool = new mssql.ConnectionPool({
          server: profile.host,
          port: profile.port,
          database: profile.database,
          user: profile.username,
          password,
          connectionTimeout: 10000,
          requestTimeout: 30000,
          pool: { max: 1, min: 0, idleTimeoutMillis: 30000 },
          options: {
            encrypt: profile.ssl !== 'off',
            trustServerCertificate: profile.ssl === 'insecure',
            appName: 'Sheet Studio',
            abortTransactionOnError: true,
          },
        }));
        pool.on('error', (error) => {
          driver.failure = error.message;
        });
        await pool.connect();
      }
      return driver;
    } catch (error) {
      await driver.close();
      throw error;
    }
  }
  async query(sql: string, params: DbValue[] = [], limit = 1000): Promise<QueryResult[]> {
    if (this.failure) throw new Error('数据库连接已失效，请重新连接。' + this.failure);
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new Error('数据库查询已取消，连接已关闭。'));
      this.queryCancellations.add(cancel);
      void this.queryInternal(sql, params, limit)
        .then(resolve, reject)
        .finally(() => this.queryCancellations.delete(cancel));
    });
  }
  private async queryInternal(sql: string, params: DbValue[], limit: number): Promise<QueryResult[]> {
    const start = performance.now();
    if (this.pg) {
      return new Promise((resolve, reject) => {
        const sets = new Map<any, QueryResult>();
        const configuration = { text: sql, values: params.map(nativeValue), rowMode: 'array' };
        const query = new Query(configuration);
        const get = (result: any) => {
          let set = sets.get(result);
          if (!set) {
            set = {
              columns: result.fields.map((f: any) => f.name),
              rows: [],
              affectedRows: 0,
              elapsedMs: 0,
              truncated: false,
            };
            sets.set(result, set);
          }
          return set;
        };
        query.on('row', (row: unknown[], result: any) => {
          const set = get(result);
          if (set.rows.length < limit) set.rows.push(row.map(dbValue));
          else set.truncated = true;
        });
        query.on('error', reject);
        query.on('end', (result: any) => {
          const results = (Array.isArray(result) ? result : [result]).map((r) => {
            const set = get(r);
            set.elapsedMs = performance.now() - start;
            set.affectedRows = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(r.command) ? (r.rowCount ?? 0) : 0;
            return set;
          });
          resolve(results.slice(0, 20));
        });
        this.pg!.query(query);
      });
    }
    if (this.mysql) {
      return new Promise((resolve, reject) => {
        const sets: QueryResult[] = [];
        let current: QueryResult | undefined;
        const query = params.length
          ? this.mysql!.execute({ sql, rowsAsArray: true }, params.map(nativeValue))
          : this.mysql!.query({ sql, rowsAsArray: true, timeout: 30000 });
        query.on('fields', (fields: any[]) => {
          current = { columns: fields.map((f) => f.name), rows: [], affectedRows: 0, elapsedMs: 0, truncated: false };
          if (sets.length < 20) sets.push(current);
        });
        query.on('result', (row: any) => {
          if (!Array.isArray(row)) {
            if (sets.length < 20)
              sets.push({ columns: [], rows: [], affectedRows: row.affectedRows ?? 0, elapsedMs: 0, truncated: false });
          } else if (current && sets.includes(current)) {
            if (current.rows.length < limit) current.rows.push(row.map(dbValue));
            else current.truncated = true;
          }
        });
        query.on('error', reject);
        query.on('end', () => {
          for (const set of sets) set.elapsedMs = performance.now() - start;
          resolve(sets);
        });
      });
    }
    if (this.pool) {
      const request = this.transaction ? new mssql.Request(this.transaction) : this.pool.request();
      request.stream = true;
      request.arrayRowMode = true;
      params.forEach((value, index) => request.input(`p${index}`, nativeValue(value)));
      const results: QueryResult[] = [];
      let current: QueryResult | undefined;
      request.on('recordset', (columns: any) => {
        current = {
          columns: (Array.isArray(columns) ? columns : Object.values(columns)).map((c: any) => c.name),
          rows: [],
          affectedRows: 0,
          elapsedMs: 0,
          truncated: false,
        };
        if (results.length < 20) results.push(current);
      });
      request.on('row', (row: unknown[]) => {
        if (current && results.includes(current)) {
          if (current.rows.length < limit) current.rows.push(row.map(dbValue));
          else current.truncated = true;
        }
      });
      request.on('error', () => {}); // The query promise reports the same error.
      this.requests.add(request);
      let response: mssql.IResult<unknown>;
      try {
        response = await request.query(sql);
      } finally {
        this.requests.delete(request);
      }
      if (!results.length) results.push({ columns: [], rows: [], affectedRows: 0, elapsedMs: 0, truncated: false });
      const affected = response.rowsAffected?.reduce((n, count) => n + count, 0) ?? 0;
      if (!results[0].columns.length || /^\s*(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql))
        results[0].affectedRows = affected;
      for (const set of results) set.elapsedMs = performance.now() - start;
      return results;
    }
    throw new Error('数据库连接已关闭。');
  }
  async catalog(): Promise<DbObject[]> {
    let sql: string;
    if (this.kind === 'postgres')
      sql =
        "SELECT table_schema AS schema, table_name AS name, CASE WHEN table_type='VIEW' THEN 'view' ELSE 'table' END AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name";
    else if (this.mysql)
      sql =
        "SELECT TABLE_SCHEMA AS `schema`, TABLE_NAME AS name, CASE WHEN TABLE_TYPE='VIEW' THEN 'view' ELSE 'table' END AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME";
    else
      sql =
        "SELECT s.name AS [schema], o.name AS name, CASE WHEN o.type='V' THEN 'view' ELSE 'table' END AS type FROM sys.objects o JOIN sys.schemas s ON o.schema_id=s.schema_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY s.name,o.name";
    return records(await this.query(sql, [], 10000)).map((r) => ({
      schema: String(r.schema),
      name: String(r.name),
      type: r.type as 'table' | 'view',
    }));
  }
  async describe(object: DbObject): Promise<TableDetail> {
    const actual = (await this.catalog()).find((o) => o.schema === object.schema && o.name === object.name);
    if (!actual) throw new Error('数据库对象不存在或没有权限，请刷新列表。');
    const fullName = objectName(this.kind, actual);
    let columns: DbColumn[], indexRows: Record<string, DbValue>[], foreignKeys: DbForeignKey[], ddl: string;
    if (this.kind === 'postgres') {
      const rows = records(
        await this.query(
          `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
        pg_get_expr(d.adbin,d.adrelid) AS default_value, (a.attgenerated<>'' OR a.attidentity='a') AS generated,
        COALESCE((SELECT array_position(i.indkey::smallint[],a.attnum)+1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary),0) AS primary_key
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
          [actual.schema, actual.name],
          10000,
        ),
      );
      columns = rows.map((r) => ({
        name: String(r.name),
        type: String(r.type),
        notNull: !!r.not_null,
        defaultValue: r.default_value === null ? null : String(r.default_value),
        primaryKey: Number(r.primary_key),
        generated: !!r.generated,
      }));
      indexRows = records(
        await this.query(
          `SELECT i.relname AS name, ix.indisunique AS is_unique, pg_get_indexdef(ix.indexrelid) AS definition
        FROM pg_index ix JOIN pg_class t ON t.oid=ix.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class i ON i.oid=ix.indexrelid WHERE n.nspname=$1 AND t.relname=$2`,
          [actual.schema, actual.name],
          10000,
        ),
      );
      foreignKeys = records(
        await this.query(
          `SELECT c.conname AS name, a.attname AS column_name, rn.nspname||'.'||rt.relname AS target, ra.attname AS target_column
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        JOIN pg_class rt ON rt.oid=c.confrelid JOIN pg_namespace rn ON rn.oid=rt.relnamespace
        JOIN LATERAL unnest(c.conkey,c.confkey) AS k(col,ref) ON true JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.col
        JOIN pg_attribute ra ON ra.attrelid=rt.oid AND ra.attnum=k.ref WHERE c.contype='f' AND n.nspname=$1 AND t.relname=$2`,
          [actual.schema, actual.name],
          10000,
        ),
      ).map((r) => ({
        name: String(r.name),
        column: String(r.column_name),
        target: String(r.target),
        targetColumn: String(r.target_column),
      }));
      ddl =
        actual.type === 'view'
          ? `CREATE VIEW ${fullName} AS\n${records(await this.query('SELECT pg_get_viewdef($1::regclass,true) AS ddl', [fullName]))[0]?.ddl ?? ''};`
          : basicDdl(this.kind, actual, columns);
    } else if (this.mysql) {
      const rows = records(
        await this.query(
          `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_value,
        COLUMN_KEY AS column_key, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`,
          [actual.schema, actual.name],
          10000,
        ),
      );
      let pk = 0;
      columns = rows.map((r) => ({
        name: String(r.name),
        type: String(r.type),
        notNull: r.nullable === 'NO',
        defaultValue: r.default_value === null ? null : String(r.default_value),
        primaryKey: r.column_key === 'PRI' ? ++pk : 0,
        generated: /GENERATED|auto_increment/i.test(String(r.extra)),
      }));
      indexRows = records(
        await this.query(
          `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX`,
          [actual.schema, actual.name],
          10000,
        ),
      );
      foreignKeys = records(
        await this.query(
          `SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS column_name, CONCAT(REFERENCED_TABLE_SCHEMA,'.',REFERENCED_TABLE_NAME) AS target,
        REFERENCED_COLUMN_NAME AS target_column FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL`,
          [actual.schema, actual.name],
          10000,
        ),
      ).map((r) => ({
        name: String(r.name),
        column: String(r.column_name),
        target: String(r.target),
        targetColumn: String(r.target_column),
      }));
      ddl =
        String(
          (await this.query(`SHOW CREATE ${actual.type === 'view' ? 'VIEW' : 'TABLE'} ${fullName}`))[0]?.rows[0]?.[1] ??
            '',
        ) + ';';
    } else {
      const rows = records(
        await this.query(
          `SELECT c.name AS name, TYPE_NAME(c.user_type_id) +
        CASE WHEN TYPE_NAME(c.user_type_id) IN ('varchar','nvarchar','char','nchar','varbinary','binary') THEN '('+CASE WHEN c.max_length=-1 THEN 'MAX' ELSE CAST(CASE WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar') THEN c.max_length/2 ELSE c.max_length END AS varchar(10)) END+')'
        WHEN TYPE_NAME(c.user_type_id) IN ('numeric','decimal') THEN '('+CAST(c.precision AS varchar(10))+','+CAST(c.scale AS varchar(10))+')' ELSE '' END AS type,
        c.is_nullable AS nullable, dc.definition AS default_value, c.is_computed AS computed, c.is_identity AS identity_column,
        COALESCE((SELECT ic.key_ordinal FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
        WHERE i.object_id=c.object_id AND i.is_primary_key=1 AND ic.column_id=c.column_id),0) AS primary_key
        FROM sys.columns c LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id WHERE c.object_id=OBJECT_ID(@p0) ORDER BY c.column_id`,
          [fullName],
          10000,
        ),
      );
      columns = rows.map((r) => ({
        name: String(r.name),
        type: String(r.type),
        notNull: !r.nullable,
        defaultValue: r.default_value === null ? null : String(r.default_value),
        primaryKey: Number(r.primary_key),
        generated: !!r.computed || !!r.identity_column || /rowversion|timestamp/i.test(String(r.type)),
      }));
      indexRows = records(
        await this.query(
          `SELECT i.name AS name, i.is_unique AS is_unique, c.name AS column_name FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
        WHERE i.object_id=OBJECT_ID(@p0) AND i.name IS NOT NULL ORDER BY i.name,ic.key_ordinal`,
          [fullName],
          10000,
        ),
      );
      foreignKeys = records(
        await this.query(
          `SELECT fk.name AS name, c.name AS column_name, SCHEMA_NAME(rt.schema_id)+'.'+rt.name AS target, rc.name AS target_column
        FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id
        JOIN sys.columns c ON c.object_id=fkc.parent_object_id AND c.column_id=fkc.parent_column_id JOIN sys.tables rt ON rt.object_id=fkc.referenced_object_id
        JOIN sys.columns rc ON rc.object_id=rt.object_id AND rc.column_id=fkc.referenced_column_id WHERE fk.parent_object_id=OBJECT_ID(@p0)`,
          [fullName],
          10000,
        ),
      ).map((r) => ({
        name: String(r.name),
        column: String(r.column_name),
        target: String(r.target),
        targetColumn: String(r.target_column),
      }));
      ddl =
        actual.type === 'view'
          ? String(
              records(await this.query('SELECT OBJECT_DEFINITION(OBJECT_ID(@p0)) AS ddl', [fullName]))[0]?.ddl ?? '',
            )
          : basicDdl(this.kind, actual, columns);
    }
    const indexes: DbIndex[] = [];
    for (const row of indexRows) {
      const name = String(row.name);
      let index = indexes.find((i) => i.name === name);
      if (!index) {
        index = {
          name,
          unique: row.non_unique === undefined ? !!row.is_unique : !row.non_unique,
          columns: [],
          definition: String(row.definition ?? ''),
        };
        indexes.push(index);
      }
      if (row.column_name) index.columns.push(String(row.column_name));
    }
    return {
      object: actual,
      columns,
      indexes,
      foreignKeys,
      ddl,
      identityColumns: columns
        .filter((c) => c.primaryKey)
        .sort((a, b) => a.primaryKey - b.primaryKey)
        .map((c) => c.name),
    };
  }
  async begin() {
    if (this.pool) {
      const transaction = new mssql.Transaction(this.pool);
      await transaction.begin();
      this.transaction = transaction;
    } else await this.query('BEGIN');
  }
  async commit() {
    if (this.transaction) {
      await this.transaction.commit();
      this.transaction = undefined;
    } else await this.query('COMMIT');
  }
  async rollback() {
    if (this.transaction) {
      try {
        await this.transaction.rollback();
      } finally {
        this.transaction = undefined;
      }
    } else await this.query('ROLLBACK');
  }
  async cancel() {
    await this.close();
  }
  async close() {
    for (const cancel of this.queryCancellations) cancel();
    this.queryCancellations.clear();
    for (const request of this.requests) request.cancel();
    if (this.transaction) await this.rollback().catch(() => {});
    const pg = this.pg,
      connection = this.mysql,
      pool = this.pool;
    this.pg = undefined;
    this.mysql = undefined;
    this.pool = undefined;
    connection?.destroy();
    await Promise.allSettled([pg?.end(), pool?.close()]);
  }
}
