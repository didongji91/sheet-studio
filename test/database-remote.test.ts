import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { RemoteDriver } from '../src/database/remote';
import { browse, applyRowChanges } from '../src/database/service';
import type { ConnectionProfile, DatabaseKind, DbDriver, QueryResult, TableDetail } from '../src/database/types';

const profile: ConnectionProfile = {
  id: 'test',
  name: 'test',
  kind: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  username: 'user',
  database: 'test',
  ssl: 'off',
};
const result = (columns: string[], rows: any[][], affectedRows = 0): QueryResult => ({
  columns,
  rows,
  affectedRows,
  elapsedMs: 0,
  truncated: false,
});
const detail: TableDetail = {
  object: { schema: 'public', name: 'records', type: 'table' },
  identityColumns: ['id'],
  indexes: [],
  foreignKeys: [],
  ddl: '',
  columns: [
    { name: 'id', type: 'INTEGER', notNull: true, defaultValue: null, generated: false, primaryKey: 1 },
    { name: 'name', type: 'VARCHAR(200)', notNull: false, defaultValue: null, generated: false, primaryKey: 0 },
  ],
};
function stub(kind: DatabaseKind) {
  const calls: { sql: string; params?: any[] }[] = [];
  const driver: DbDriver = {
    kind,
    catalog: async () => [detail.object],
    describe: async () => detail,
    begin: async () => {
      calls.push({ sql: 'BEGIN' });
    },
    commit: async () => {
      calls.push({ sql: 'COMMIT' });
    },
    rollback: async () => {
      calls.push({ sql: 'ROLLBACK' });
    },
    close: async () => {},
    query: async (sql, params) => {
      calls.push({ sql, params });
      return [
        sql.includes('COUNT(*)')
          ? result(['count'], [[1]])
          : sql.startsWith('SELECT')
            ? result(['id', 'name'], [[1, 'old']])
            : result([], [], 1),
      ];
    },
  };
  return { driver, calls };
}
test('all supported dialects parameterize filters and use their own pagination syntax', async () => {
  for (const kind of ['sqlite', 'postgres', 'mysql', 'mariadb', 'mssql'] as const) {
    const { driver, calls } = stub(kind);
    await browse(driver, detail.object, {
      offset: 20,
      limit: 50,
      filterColumn: 'name',
      search: "' OR 1=1 --",
      sortColumn: 'id',
    });
    assert.equal(calls.length, 2);
    assert.equal(
      calls.every((c) => !c.sql.includes("' OR 1=1 --")),
      true,
    );
    assert.equal(calls[0].params?.[0], "%' OR 1=1 --%");
    assert.ok(
      calls[1].sql.includes(kind === 'mssql' ? 'OFFSET 20 ROWS FETCH NEXT 50 ROWS ONLY' : 'LIMIT 50 OFFSET 20'),
    );
    assert.ok(calls[0].sql.includes(kind === 'postgres' ? '$1' : kind === 'mssql' ? '@p0' : '?'));
  }
});
test('all supported dialects bind row changes, check original text values and commit only after the whole batch', async () => {
  for (const kind of ['sqlite', 'postgres', 'mysql', 'mariadb', 'mssql'] as const) {
    const { driver, calls } = stub(kind);
    await applyRowChanges(driver, detail.object, [
      { type: 'update', identity: [1], original: [1, 'old'], values: { name: "new'; DELETE FROM records; --" } },
    ]);
    assert.equal(calls[0].sql, 'BEGIN');
    assert.equal(calls.at(-1)?.sql, 'COMMIT');
    assert.equal(calls[1].sql.includes("new';"), false);
    assert.deepEqual(calls[1].params, ["new'; DELETE FROM records; --", 1, 'old']);
  }
});
test('remote transaction batches use savepoints and refuse to update views or generated columns', async () => {
  for (const kind of ['postgres', 'mysql', 'mariadb', 'mssql'] as const) {
    const { driver, calls } = stub(kind);
    await applyRowChanges(driver, detail.object, [{ type: 'delete', identity: [1], original: [1, 'old'] }], true);
    assert.equal(calls[0].sql, kind === 'mssql' ? 'SAVE TRANSACTION sheet_studio_grid' : 'SAVEPOINT sheet_studio_grid');
    assert.equal(
      calls.some((c) => c.sql === 'COMMIT'),
      false,
    );
  }
  const { driver } = stub('postgres');
  driver.describe = async () => ({ ...detail, object: { ...detail.object, type: 'view' } });
  await assert.rejects(() => applyRowChanges(driver, detail.object, [{ type: 'insert', values: {} }]), /视图/);
});
test('PostgreSQL streaming retains multiple result metadata and bounded rows without accumulating the whole response', async () => {
  const driver = new (RemoteDriver as any)(profile);
  const a = { fields: [{ name: 'value' }], command: 'SELECT', rowCount: 3 },
    b = { fields: [], command: 'UPDATE', rowCount: 7 };
  driver.pg = {
    query(query: EventEmitter & { values: any[] }) {
      assert.deepEqual(query.values, ["quoted'param"]);
      queueMicrotask(() => {
        for (const n of [1, 2, 3]) query.emit('row', [n], a);
        query.emit('end', [a, b]);
      });
    },
  };
  const sets = await driver.query('SELECT $1; UPDATE demo SET n=1', ["quoted'param"], 2);
  assert.deepEqual(sets[0].rows, [[1], [2]]);
  assert.equal(sets[0].truncated, true);
  assert.equal(sets[1].affectedRows, 7);
});
test('MySQL/MariaDB streaming uses bound prepared parameters and retains result column order', async () => {
  for (const kind of ['mysql', 'mariadb'] as const) {
    const driver = new (RemoteDriver as any)({ ...profile, kind });
    driver.mysql = {
      execute(config: any, params: any[]) {
        assert.equal(config.rowsAsArray, true);
        assert.deepEqual(params, [Buffer.from('00ff', 'hex')]);
        const stream = new EventEmitter();
        queueMicrotask(() => {
          stream.emit('fields', [{ name: 'id' }, { name: 'name' }]);
          stream.emit('result', [1, 'one']);
          stream.emit('result', [2, 'two']);
          stream.emit('result', [3, 'three']);
          stream.emit('end');
        });
        return stream;
      },
    };
    const sets = await driver.query('SELECT id,name FROM demo WHERE blob=?', [{ type: 'blob', hex: '00ff' }], 2);
    assert.deepEqual(sets[0].columns, ['id', 'name']);
    assert.deepEqual(sets[0].rows, [
      [1, 'one'],
      [2, 'two'],
    ]);
    assert.equal(sets[0].truncated, true);
  }
});
test('SQL Server streaming requests bind named parameters and preserve duplicate column names with array rows', async () => {
  const driver = new (RemoteDriver as any)({ ...profile, kind: 'mssql' });
  const events = new EventEmitter();
  const request = Object.assign(events, {
    stream: false,
    arrayRowMode: false,
    input(name: string, value: unknown) {
      assert.equal(name, 'p0');
      assert.equal(value, 'quoted');
      return this;
    },
    async query(sql: string) {
      assert.equal(this.stream, true);
      assert.equal(this.arrayRowMode, true);
      assert.equal(sql, 'SELECT @p0 AS value, 2 AS value');
      events.emit('recordset', [{ name: 'value' }, { name: 'value' }]);
      events.emit('row', ['quoted', 2]);
      return { rowsAffected: [1] };
    },
  });
  driver.pool = { request: () => request };
  const sets = await driver.query('SELECT @p0 AS value, 2 AS value', ['quoted']);
  assert.deepEqual(sets[0].columns, ['value', 'value']);
  assert.deepEqual(sets[0].rows, [['quoted', 2]]);
  assert.equal(sets[0].affectedRows, 0);
});
test('bundled PostgreSQL, MySQL, MariaDB and SQL Server clients fail closed for an unavailable server without leaking passwords', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const password = 'secret-not-to-be-logged';
  await Promise.all(
    (['postgres', 'mysql', 'mariadb', 'mssql'] as const).map(async (kind) => {
      await assert.rejects(
        () => RemoteDriver.connect({ ...profile, kind, port }, password),
        (error) => {
          assert.equal(String(error).includes(password), false);
          return true;
        },
      );
    }),
  );
});
test('remote cancellation rejects pending queries even when a destroyed MySQL stream emits no completion event', async () => {
  const driver = new (RemoteDriver as any)({ ...profile, kind: 'mysql' });
  let destroyed = false;
  driver.mysql = {
    query: () => new EventEmitter(),
    destroy: () => {
      destroyed = true;
    },
  };
  const pending = assert.rejects(driver.query('SELECT SLEEP(30)'), /取消/);
  await driver.cancel();
  await pending;
  assert.equal(destroyed, true);
  await assert.rejects(driver.query('SELECT 1'), /已关闭/);
});
test('SQL Server cancellation calls the active request before closing its pool', async () => {
  const driver = new (RemoteDriver as any)({ ...profile, kind: 'mssql' });
  const events: string[] = [];
  let rejectQuery: (error: Error) => void;
  const request = Object.assign(new EventEmitter(), {
    query: () =>
      new Promise((_, reject) => {
        rejectQuery = reject;
      }),
    cancel: () => {
      events.push('cancel');
      rejectQuery(new Error('Cancelled'));
    },
  });
  driver.pool = {
    request: () => request,
    close: async () => {
      events.push('close');
    },
  };
  const pending = assert.rejects(driver.query("WAITFOR DELAY '00:00:30'"), /取消/);
  await driver.cancel();
  await pending;
  assert.deepEqual(events, ['cancel', 'close']);
});
