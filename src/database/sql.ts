import type { DatabaseKind, DbColumn, DbObject, DbValue, QueryResult, ConnectionProfile } from './types';

export function quoteIdentifier(kind: DatabaseKind, value: string): string {
  if (!value || value.includes('\0')) throw new Error('数据库对象名称无效。');
  return kind === 'mysql' || kind === 'mariadb'
    ? '`' + value.replaceAll('`', '``') + '`'
    : kind === 'mssql'
      ? '[' + value.replaceAll(']', ']]') + ']'
      : '"' + value.replaceAll('"', '""') + '"';
}
export const objectName = (kind: DatabaseKind, object: DbObject) =>
  (object.schema ? quoteIdentifier(kind, object.schema) + '.' : '') + quoteIdentifier(kind, object.name);
export const placeholder = (kind: DatabaseKind, index: number) =>
  kind === 'postgres' ? `$${index + 1}` : kind === 'mssql' ? `@p${index}` : '?';
export function dbValue(value: unknown): DbValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint')
    return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)
      ? String(value)
      : Number(value);
  if (value instanceof Uint8Array) return { type: 'blob', hex: Buffer.from(value).toString('hex') };
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}
export function nativeValue(value: DbValue): null | string | number | boolean | Buffer {
  if (value && typeof value === 'object') {
    if (value.type !== 'blob' || !/^(?:[\da-f]{2})*$/i.test(value.hex)) throw new Error('BLOB 须为偶数位十六进制。');
    return Buffer.from(value.hex, 'hex');
  }
  return value;
}
export function records(result: QueryResult[]): Record<string, DbValue>[] {
  const set = result.find((r) => r.columns.length);
  return set ? set.rows.map((row) => Object.fromEntries(set.columns.map((name, i) => [name, row[i]]))) : [];
}
export function basicDdl(kind: DatabaseKind, object: DbObject, columns: DbColumn[]): string {
  const lines = columns.map(
    (c) =>
      `  ${quoteIdentifier(kind, c.name)} ${c.type}${c.notNull ? ' NOT NULL' : ''}${c.defaultValue !== null ? ' DEFAULT ' + c.defaultValue : ''}`,
  );
  const primary = columns.filter((c) => c.primaryKey).sort((a, b) => a.primaryKey - b.primaryKey);
  if (primary.length) lines.push(`  PRIMARY KEY (${primary.map((c) => quoteIdentifier(kind, c.name)).join(', ')})`);
  return `-- 结构参考，索引、外键等详见结构面板\nCREATE TABLE ${objectName(kind, object)} (\n${lines.join(',\n')}\n);`;
}
export function validateProfile(value: unknown): ConnectionProfile {
  const p = value as ConnectionProfile;
  if (!p || !['postgres', 'mysql', 'mariadb', 'mssql'].includes(p.kind)) throw new Error('请选择支持的数据库类型。');
  if (
    ![p.name, p.host, p.database, p.username].every(
      (v) => typeof v === 'string' && v.trim() && v.length <= 512 && !/[\0\r\n]/.test(v),
    )
  )
    throw new Error('请填写连接名称、主机、数据库和用户名。');
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new Error('端口须为 1–65535。');
  if (!['off', 'verify', 'insecure'].includes(p.ssl)) throw new Error('TLS 设置无效。');
  if (typeof p.id !== 'string' || !/^[\w-]{1,100}$/.test(p.id)) throw new Error('连接标识无效。');
  return {
    id: p.id,
    name: p.name.trim(),
    kind: p.kind,
    host: p.host.trim(),
    port: p.port,
    database: p.database.trim(),
    username: p.username.trim(),
    ssl: p.ssl,
  };
}
// Used for SQL history/transaction controls, not as a substitute for SQL parameter binding.
export function splitSql(text: string): string[] {
  const parts: string[] = [];
  let start = 0,
    quote = '',
    dollar = '',
    line = false,
    block = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i],
      next = text[i + 1];
    if (line) {
      if (ch === '\n') line = false;
      continue;
    }
    if (block) {
      if (ch === '/' && next === '*') {
        block++;
        i++;
      } else if (ch === '*' && next === '/') {
        block--;
        i++;
      }
      continue;
    }
    if (dollar) {
      if (text.startsWith(dollar, i)) {
        i += dollar.length - 1;
        dollar = '';
      }
      continue;
    }
    if (quote) {
      const end = quote === '[' ? ']' : quote;
      if (ch === end) {
        if (next === end) i++;
        else quote = '';
      } else if (ch === '\\' && quote === "'") i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      line = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      block = 1;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      quote = ch;
      continue;
    }
    if (ch === '$') {
      const match = /^\$(?:[a-z_]\w*)?\$/i.exec(text.slice(i));
      if (match) {
        dollar = match[0];
        i += dollar.length - 1;
        continue;
      }
    }
    if (ch === ';') {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((p) => firstKeyword(p));
}
export function firstKeyword(sql: string): string {
  return (
    sql
      .replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/g, '')
      .match(/^[a-z]+/i)?.[0]
      .toUpperCase() ?? ''
  );
}
export function validateUserSql(sql: unknown, sqlite = false): asserts sql is string {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('请输入 SQL。');
  if (sql.length > 1_000_000) throw new Error('SQL 脚本最多 1 MB。');
  for (const statement of splitSql(sql)) {
    if (!sqlite && ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'START'].includes(firstKeyword(statement)))
      throw new Error('请使用工具栏的“开启事务 / 提交 / 回滚”管理事务。');
  }
}
