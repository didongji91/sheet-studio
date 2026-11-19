import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { SqliteClient } from '../src/database/sqlite-client';
import type { ConnectionProfile, DatabaseState, DbObject, QueryResult, SqlHistory } from '../src/database/types';
import { validateProfile } from '../src/database/sql';
import { RemoteDriver } from '../src/database/remote';
import { applyRowChanges, browse } from '../src/database/service';
import { exportQueryResult } from '../src/database/export';

const client = new SqliteClient(join(process.cwd(), 'dist'), new Uint8Array());
let initialized: Promise<void> | undefined,
  backgroundColor = '#ffffff',
  saved: Uint8Array;
let history: SqlHistory[] = [],
  profiles: ConnectionProfile[] = [],
  passwords = new Map<string, string>();
const undo: Uint8Array[] = [],
  redo: Uint8Array[] = [];
let remote: RemoteDriver | undefined,
  currentProfile: ConnectionProfile | undefined,
  transaction = false;
async function initialize() {
  await client.call('execute', {
    sql: `CREATE TABLE customers (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, city TEXT, status TEXT NOT NULL DEFAULT 'active',
    balance REAL NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, notes TEXT);
    CREATE INDEX idx_customers_city ON customers(city);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL NOT NULL, stock INTEGER DEFAULT 0);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), product_id INTEGER REFERENCES products(id), quantity INTEGER NOT NULL, total REAL NOT NULL, status TEXT DEFAULT 'paid');
    CREATE VIEW revenue_summary AS SELECT city, COUNT(*) AS customers, ROUND(SUM(balance),2) AS balance FROM customers GROUP BY city;`,
  });
  const cities = ['杭州', '上海', '北京', '深圳', '成都', '南京'];
  await client.call('changes', {
    object: { schema: 'main', name: 'customers', type: 'table' },
    changes: Array.from({ length: 137 }, (_, i) => ({
      type: 'insert',
      values: {
        name: ['林晓', '陈晨', '张远', '周宁', '李可', '陈星'][i % 6] + (i < 6 ? '' : String(i + 1)),
        email: `user${i + 1}@example.com`,
        city: cities[i % 6],
        status: i % 7 ? 'active' : 'pending',
        balance: Math.round((500 + i * 127.35) * 100) / 100,
        created_at: `2026-11-${String((i % 19) + 1).padStart(2, '0')} 09:30:00`,
        notes: i % 4 ? null : '重点客户',
      },
    })),
  });
  await client.call('changes', {
    object: { schema: 'main', name: 'products', type: 'table' },
    changes: [
      { type: 'insert', values: { name: '专业版订阅', price: 299, stock: 1000 } },
      { type: 'insert', values: { name: '团队版订阅', price: 999, stock: 300 } },
    ],
  });
  await client.call('changes', {
    object: { schema: 'main', name: 'orders', type: 'table' },
    changes: Array.from({ length: 240 }, (_, i) => ({
      type: 'insert',
      values: {
        customer_id: (i % 137) + 1,
        product_id: (i % 2) + 1,
        quantity: (i % 3) + 1,
        total: (i % 2 ? 999 : 299) * ((i % 3) + 1),
        status: i % 9 ? 'paid' : 'pending',
      },
    })),
  });
  saved = (await client.call<Uint8Array>('image')).result;
}
async function state(manager: boolean): Promise<DatabaseState> {
  return manager
    ? {
        name: currentProfile?.name ?? '数据库管理器',
        kind: currentProfile?.kind ?? 'postgres',
        local: false,
        dirty: false,
        connected: !!remote,
        objects: remote ? await remote.catalog() : [],
        transaction,
      }
    : {
        name: 'workspace.db',
        kind: 'sqlite',
        local: true,
        connected: true,
        dirty: !Buffer.from(saved).equals(Buffer.from((await client.call<Uint8Array>('image')).result)),
        objects: (await client.call<DbObject[]>('catalog')).result,
        transaction: false,
      };
}
export async function databasePreview(request: any, manager = false): Promise<any> {
  await (initialized ??= initialize());
  const { action, args = {} } = request;
  const initial = async () => ({ state: await state(manager), profiles, history, backgroundColor });
  try {
    if (action === 'ready') return { data: await initial() };
    if (action === 'appearance') {
      backgroundColor = args.color;
      return { data: true };
    }
    if (action === 'cancel') {
      if (manager) {
        await remote?.cancel();
        remote = undefined;
        transaction = false;
      } else await client.cancel();
      return { data: true, state: await state(manager) };
    }
    if (action === 'saveConnection') {
      const profile = validateProfile(args.profile);
      profiles = [...profiles.filter((p) => p.id !== profile.id), profile];
      if (args.password) passwords.set(profile.id, args.password);
      return { data: profiles };
    }
    if (action === 'deleteConnection') {
      profiles = profiles.filter((p) => p.id !== args.id);
      passwords.delete(args.id);
      return { data: profiles };
    }
    if (action === 'testConnection' || action === 'connect') {
      const profile = args.profile ?? profiles.find((p) => p.id === args.id);
      const next = await RemoteDriver.connect(profile, args.password || passwords.get(profile.id) || '');
      if (action === 'testConnection') {
        await next.close();
        return { data: true };
      }
      await remote?.close();
      remote = next;
      currentProfile = profile;
      transaction = false;
      return { data: await initial() };
    }
    if (action === 'disconnect') {
      await remote?.close();
      remote = undefined;
      transaction = false;
      return { data: await state(manager) };
    }
    if (action === 'refresh') return { data: await state(manager) };
    if (action === 'page')
      return {
        data: manager ? await browse(remote!, args.object, args.options) : (await client.call('page', args)).result,
      };
    if (action === 'describe')
      return { data: manager ? await remote!.describe(args.object) : (await client.call('describe', args)).result };
    if (action === 'save') {
      saved = (await client.call<Uint8Array>('image')).result;
      return { data: true, state: await state(manager) };
    }
    if (action === 'undo' || action === 'redo') {
      const source = action === 'undo' ? undo : redo,
        destination = action === 'undo' ? redo : undo;
      if (source.length) {
        destination.push((await client.call<Uint8Array>('image')).result);
        await client.call('restore', { bytes: source.pop()! });
      }
      return { data: true, state: await state(manager), changed: true };
    }
    if (action === 'transaction') {
      if (args.command === 'begin') {
        await remote!.begin();
        transaction = true;
      }
      if (args.command === 'commit') {
        await remote!.commit();
        transaction = false;
      }
      if (args.command === 'rollback') {
        await remote!.rollback();
        transaction = false;
      }
      return { data: await state(manager) };
    }
    if (action === 'execute' || action === 'changes') {
      const start = performance.now();
      const response = manager
        ? {
            result:
              action === 'execute'
                ? await remote!.query(args.sql, [], args.limit)
                : await applyRowChanges(remote!, args.object, args.changes, transaction),
            change: undefined,
          }
        : await client.call<any>(action, args);
      if (response.change) {
        undo.push(response.change.before);
        redo.length = 0;
      }
      if (action === 'execute') {
        const results = response.result as QueryResult[];
        history = [
          {
            sql: args.sql,
            success: true,
            time: new Date().toISOString(),
            elapsedMs: performance.now() - start,
            rows: results.reduce((n, r) => n + r.rows.length + r.affectedRows, 0),
          },
          ...history,
        ].slice(0, 80);
        return { data: { results, history }, state: await state(manager), changed: !!response.change };
      }
      return { data: { affectedRows: response.result }, state: await state(manager), changed: !!response.change };
    }
    if (action === 'exportResults') {
      await mkdir('output/database-exports', { recursive: true });
      await writeFile(
        `output/database-exports/result.${args.format}`,
        await exportQueryResult(args.result, args.format),
      );
      return { data: true };
    }
    if (action === 'exportDatabase') {
      await mkdir('output/database-exports', { recursive: true });
      await writeFile(
        `output/database-exports/copy.${args.format}`,
        args.format === 'sql'
          ? (await client.call<string>('dump')).result
          : (await client.call<Uint8Array>('image')).result,
      );
      return { data: true };
    }
    if (['openManager', 'openFile', 'createFile', 'importCsv'].includes(action)) return { data: false };
    throw new Error('未知的预览操作。');
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
export async function closeDatabasePreview() {
  await client.close();
  await remote?.close();
}
