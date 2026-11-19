import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { SqliteEngine, isSqliteFile } from '../src/database/sqlite';
import { SqliteClient } from '../src/database/sqlite-client';
import { applyRowChanges, browse } from '../src/database/service';
import { splitSql, quoteIdentifier, validateProfile, validateUserSql, dbValue } from '../src/database/sql';
import type { DbObject } from '../src/database/types';

const engines: SqliteEngine[] = [];
async function database(sql = '') {
  const db = await SqliteEngine.open();
  engines.push(db);
  if (sql) await db.execute(sql);
  return db;
}
const object = (name: string): DbObject => ({ schema: 'main', name, type: 'table' });
before(async () => {
  const directory = resolve('output/database-test');
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: ['src/database/sqlite-worker.ts'],
    outfile: resolve(directory, 'sqlite-worker.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
  });
  await copyFile('node_modules/sql.js/dist/sql-wasm.wasm', resolve(directory, 'sql-wasm.wasm'));
});
after(async () => {
  for (const db of engines) await db.close();
});

test('SQLite identifies actual file contents, rejecting renamed or encrypted database formats', async () => {
  assert.equal(isSqliteFile(Buffer.from('not a sqlite database')), false);
  await assert.rejects(() => SqliteEngine.open(Buffer.from('DuckDB or encrypted database')), /不是 SQLite/);
  const db = await database('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT);');
  const image = db.image();
  assert.equal(isSqliteFile(image), true);
  const reopened = await SqliteEngine.open(image);
  engines.push(reopened);
  assert.deepEqual(
    (await reopened.catalog()).map((o) => o.name),
    ['test'],
  );
});
test('SQLite browses metadata including composite keys, generated columns, indexes, foreign keys and views', async () => {
  const db = await database(`CREATE TABLE parent (a INTEGER, b TEXT, PRIMARY KEY(a,b)) WITHOUT ROWID;
    CREATE TABLE child (id INTEGER PRIMARY KEY, a INTEGER, b TEXT, doubled INTEGER GENERATED ALWAYS AS (a*2) STORED, FOREIGN KEY(a,b) REFERENCES parent(a,b));
    CREATE INDEX ix_child_b ON child(b);
    CREATE VIEW child_view AS SELECT id,a,b FROM child;`);
  const detail = await db.describe(object('child'));
  assert.equal(detail.columns.find((c) => c.name === 'doubled')?.generated, true);
  assert.deepEqual(detail.identityColumns, ['id']);
  assert.deepEqual(
    detail.foreignKeys.map((f) => f.column),
    ['a', 'b'],
  );
  assert.deepEqual(detail.indexes[0].columns, ['b']);
  assert.equal((await db.catalog()).find((o) => o.name === 'child_view')?.type, 'view');
  assert.deepEqual((await db.describe(object('parent'))).identityColumns, ['a', 'b']);
});
test('SQLite pagination, sorting and filters bind values and treat wildcard text literally', async () => {
  const db = await database(`CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, extra TEXT);
    INSERT INTO items VALUES (1,'100%_off',NULL),(2,'plain','x'),(3,'100ZZoff','y'),(4,'[bracket]','z');`);
  const page = await browse(db, object('items'), { offset: 1, limit: 2, sortColumn: 'id', descending: true });
  assert.equal(page.total, 4);
  assert.deepEqual(
    page.rows.map((row) => row[0]),
    [3, 2],
  );
  assert.equal((await browse(db, object('items'), { search: '%_', filterColumn: 'name' })).total, 1);
  assert.equal((await browse(db, object('items'), { search: '[bracket]', filterColumn: 'name' })).total, 1);
  assert.equal((await browse(db, object('items'), { search: "' OR 1=1 --" })).total, 0);
  assert.equal((await browse(db, object('items'), { filterColumn: 'extra', filterOperator: 'isNull' })).rows[0][0], 1);
  await assert.rejects(() => browse(db, object('items'), { sortColumn: 'id; DROP TABLE items' }), /排序列/);
  assert.equal((await db.catalog()).length, 1);
});
test('SQLite quotes unusual table and column identifiers and can edit rowid tables without a primary key', async () => {
  const name = 'odd" table',
    column = 'value"] --';
  const db = await database(
    `CREATE TABLE ${quoteIdentifier('sqlite', name)} (${quoteIdentifier('sqlite', column)} TEXT, rowid TEXT);`,
  );
  await applyRowChanges(db, object(name), [{ type: 'insert', values: { [column]: 'original', rowid: 'shadow' } }]);
  const page = await browse(db, object(name));
  assert.equal(page.detail.rowidAlias, '_rowid_');
  assert.deepEqual(page.identities, [[1]]);
  await applyRowChanges(db, object(name), [
    {
      type: 'update',
      identity: page.identities[0],
      original: page.rows[0],
      values: { [column]: "'; DROP TABLE test; --" },
    },
  ]);
  assert.equal((await browse(db, object(name))).rows[0][0], "'; DROP TABLE test; --");
});
test('SQLite batch changes preserve NULL, BLOBs, exact int64 values and allow one snapshot to restore everything', async () => {
  const db = await database(`CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT, blob BLOB, large INTEGER);
    INSERT INTO records VALUES (1,'before',X'0001ff',9223372036854775806);`);
  const page = await browse(db, object('records')),
    before = db.image();
  assert.equal(page.rows[0][3], '9223372036854775806');
  assert.deepEqual(page.rows[0][2], { type: 'blob', hex: '0001ff' });
  await applyRowChanges(db, object('records'), [
    {
      type: 'update',
      identity: page.identities[0],
      original: page.rows[0],
      values: { value: null, blob: { type: 'blob', hex: 'abcd00' }, large: '9223372036854775805' },
    },
    { type: 'insert', values: { value: 'new' } },
  ]);
  const changed = await browse(db, object('records'));
  assert.equal(changed.total, 2);
  assert.equal(changed.rows[0][1], null);
  assert.equal(changed.rows[0][3], '9223372036854775805');
  db.restore(before);
  assert.deepEqual((await browse(db, object('records'))).rows, page.rows);
});
test('SQLite rolls back an entire batch on a constraint failure and rejects stale or duplicate identities', async () => {
  const db = await database(`CREATE TABLE records(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL UNIQUE);
    INSERT INTO records VALUES(1,10),(2,20);`);
  const page = await browse(db, object('records'));
  await assert.rejects(
    () =>
      applyRowChanges(db, object('records'), [
        { type: 'update', identity: [1], original: page.rows[0], values: { amount: 15 } },
        { type: 'update', identity: [2], original: page.rows[1], values: { amount: 15 } },
      ]),
    /UNIQUE/,
  );
  assert.deepEqual((await browse(db, object('records'))).rows, page.rows);
  await db.execute('UPDATE records SET amount=11 WHERE id=1;');
  await assert.rejects(
    () => applyRowChanges(db, object('records'), [{ type: 'delete', identity: [1], original: page.rows[0] }]),
    /已改变/,
  );
  assert.equal((await browse(db, object('records'))).total, 2);
});
test('SQLite failed SQL scripts roll back preceding DDL/DML, foreign keys remain enforced after exporting', async () => {
  const db = await database(
    'CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));',
  );
  await assert.rejects(
    () => db.execute('INSERT INTO parent VALUES(1); CREATE TABLE transient(x); INSERT INTO missing VALUES(2);'),
    /no such table/,
  );
  assert.equal((await browse(db, object('parent'))).total, 0);
  assert.equal(
    (await db.catalog()).some((o) => o.name === 'transient'),
    false,
  );
  db.image();
  await assert.rejects(
    () => applyRowChanges(db, object('child'), [{ type: 'insert', values: { id: 1, parent_id: 999 } }]),
    /FOREIGN KEY/,
  );
  await assert.rejects(() => db.execute('COMMIT;'), /事务/);
});
test('SQLite SELECT is nonmutating, limits returned rows and retains trigger effects and affected row counts', async () => {
  const db = await database(`CREATE TABLE numbers(id INTEGER PRIMARY KEY, n INTEGER); CREATE TABLE audit(value INTEGER);
    CREATE TRIGGER log_insert AFTER INSERT ON numbers BEGIN INSERT INTO audit(value) VALUES(new.n); END;
    INSERT INTO numbers(n) VALUES(1),(2),(3),(4);`);
  const before = db.image(),
    sets = await db.execute('SELECT * FROM numbers; SELECT COUNT(*) FROM audit;', 2);
  assert.equal(sets[0].rows.length, 2);
  assert.equal(sets[0].truncated, true);
  assert.equal(sets[0].affectedRows, 0);
  assert.equal(sets[1].rows[0][0], 4);
  assert.deepEqual(db.image(), before);
  const updated = await db.execute('UPDATE numbers SET n=10 WHERE id=1 RETURNING n;');
  assert.equal(updated[0].affectedRows, 1);
  assert.deepEqual(updated[0].rows, [[10]]);
});
test('SQLite SQL dump reconstructs data, views, indexes and triggers without firing triggers during data restoration', async () => {
  const db = await database(`CREATE TABLE numbers(id INTEGER PRIMARY KEY, value TEXT, data BLOB);
    CREATE TABLE audit(value TEXT); CREATE INDEX ix_value ON numbers(value);
    CREATE TRIGGER log_insert AFTER INSERT ON numbers BEGIN INSERT INTO audit VALUES(new.value); END;
    INSERT INTO numbers VALUES(1,'quoted''value',X'00ff');
    CREATE VIEW number_view AS SELECT id,value FROM numbers;`);
  const dump = await db.dump(),
    restored = await database();
  await restored.execute(dump);
  assert.deepEqual((await browse(restored, object('numbers'))).rows, (await browse(db, object('numbers'))).rows);
  assert.equal((await browse(restored, object('audit'))).total, 1);
  assert.equal((await restored.describe(object('numbers'))).indexes[0].name, 'ix_value');
  assert.equal(
    (await restored.catalog()).some((o) => o.name === 'number_view'),
    true,
  );
});
test('SQLite imports a complete SQL dump with forward foreign keys and more than twenty inserts atomically', async () => {
  const db = await database(`CREATE TABLE z_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE a_child(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES z_parent(id));
    INSERT INTO z_parent VALUES(1);`);
  for (let i = 0; i < 30; i++) await db.execute(`INSERT INTO a_child VALUES(${i + 1},1);`);
  const restored = await database();
  await restored.execute(await db.dump());
  assert.equal((await browse(restored, object('a_child'))).total, 30);
  await assert.rejects(() => restored.execute('BEGIN; INSERT INTO z_parent VALUES(2);'), /缺少 COMMIT/);
  assert.equal((await browse(restored, object('z_parent'))).total, 1);
});
test('SQLite worker cancellation and timeout leave extension responsive and restore prior completed changes', async () => {
  const client = new SqliteClient(resolve('output/database-test'), new Uint8Array(), 120);
  try {
    await client.call('execute', { sql: 'CREATE TABLE data(id INTEGER PRIMARY KEY); INSERT INTO data VALUES(42);' });
    await assert.rejects(
      () =>
        client.call('execute', {
          sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT SUM(x) FROM n;',
        }),
      /超时|取消/,
    );
    const page = (await client.call<any>('page', { object: object('data') })).result;
    assert.deepEqual(page.rows, [[42]]);
    const request = client.call('execute', {
      sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT SUM(x) FROM n;',
    });
    const rejected = assert.rejects(() => request, /取消/);
    setTimeout(() => void client.cancel(), 30);
    await rejected;
    assert.deepEqual((await client.call<any>('page', { object: object('data') })).result.rows, [[42]]);
  } finally {
    await client.close();
  }
});
test('SQLite initialization can be cancelled immediately and the next request opens a fresh worker', async () => {
  const client = new SqliteClient(resolve('output/database-test'), new Uint8Array());
  try {
    const opening = client.call('catalog');
    const rejected = assert.rejects(opening, /取消/);
    await client.cancel();
    await rejected;
    assert.deepEqual((await client.call('catalog')).result, []);
  } finally {
    await client.close();
  }
});
test('SQL splitting and profile validation handle quoted semicolons, dollar bodies and strip unexpected password fields', () => {
  assert.equal(splitSql("SELECT ';'; -- comment ;\n SELECT $$body;value$$; /* ; */ SELECT 'it''s;fine';").length, 3);
  assert.throws(() => validateUserSql('SELECT 1; COMMIT;'), /事务/);
  const profile = validateProfile({
    id: 'test',
    kind: 'postgres',
    name: 'Local',
    host: 'localhost',
    port: 5432,
    database: 'test',
    username: 'user',
    ssl: 'verify',
    password: 'never in settings',
  });
  assert.equal('password' in profile, false);
  assert.throws(() => validateProfile({ ...profile, port: 0 }), /端口/);
  assert.equal(quoteIdentifier('mysql', 'a`b'), '`a``b`');
  assert.equal(quoteIdentifier('mssql', 'a]b'), '[a]]b]');
  assert.equal(dbValue(9223372036854775806n), '9223372036854775806');
});
