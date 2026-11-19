export type DatabaseKind = 'sqlite' | 'postgres' | 'mysql' | 'mariadb' | 'mssql';
export type RemoteKind = Exclude<DatabaseKind, 'sqlite'>;
export type DbValue = null | string | number | boolean | { type: 'blob'; hex: string };
export interface ConnectionProfile {
  id: string;
  name: string;
  kind: RemoteKind;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: 'off' | 'verify' | 'insecure';
}
export interface DbObject {
  schema: string;
  name: string;
  type: 'table' | 'view';
  sql?: string;
}
export interface DbColumn {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: number;
  generated: boolean;
}
export interface DbIndex {
  name: string;
  unique: boolean;
  columns: string[];
  definition?: string;
}
export interface DbForeignKey {
  name: string;
  column: string;
  target: string;
  targetColumn: string;
}
export interface TableDetail {
  object: DbObject;
  columns: DbColumn[];
  indexes: DbIndex[];
  foreignKeys: DbForeignKey[];
  ddl: string;
  identityColumns: string[];
  rowidAlias?: string;
}
export interface QueryResult {
  columns: string[];
  rows: DbValue[][];
  affectedRows: number;
  elapsedMs: number;
  truncated: boolean;
}
export interface BrowseOptions {
  offset?: number;
  limit?: number;
  search?: string;
  filterColumn?: string;
  filterOperator?: 'contains' | 'equals' | 'isNull' | 'notNull';
  sortColumn?: string;
  descending?: boolean;
}
export interface TablePage extends QueryResult {
  detail: TableDetail;
  identities: DbValue[][];
  total: number;
  offset: number;
  limit: number;
}
export interface RowChange {
  type: 'update' | 'insert' | 'delete';
  identity?: DbValue[];
  original?: DbValue[];
  values?: Record<string, DbValue>;
}
export interface DbDriver {
  kind: DatabaseKind;
  query(sql: string, params?: DbValue[], limit?: number): Promise<QueryResult[]>;
  catalog(): Promise<DbObject[]>;
  describe(object: DbObject): Promise<TableDetail>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  cancel?(): Promise<void>;
}
export interface DatabaseState {
  name: string;
  kind: DatabaseKind;
  objects: DbObject[];
  connected: boolean;
  local: boolean;
  dirty: boolean;
  transaction: boolean;
  error?: string;
}
export interface SqlHistory {
  sql: string;
  time: string;
  elapsedMs: number;
  success: boolean;
  rows: number;
}
export const DATABASE_LABELS: Record<DatabaseKind, string> = {
  sqlite: 'SQLite',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
};
export const SQLITE_EXTENSIONS = ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sqllite'];
export const DEFAULT_PORTS: Record<RemoteKind, number> = { postgres: 5432, mysql: 3306, mariadb: 3306, mssql: 1433 };
