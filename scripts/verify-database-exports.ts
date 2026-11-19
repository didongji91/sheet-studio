import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Papa from 'papaparse';
import { SqliteClient } from '../src/database/sqlite-client';
import { readWorkbook } from '../src/files';
import type { DbObject, TablePage } from '../src/database/types';

async function main() {
  const json = JSON.parse(await readFile('output/database-exports/result.json', 'utf8'));
  assert.deepEqual(json.columns, ['id', 'name', 'empty_value', 'binary_value']);
  assert.equal(json.rows.length, 3);
  assert.equal(json.rows[0][1], '林晓·编辑验证');
  assert.equal(json.rows[0][2], null);
  assert.equal(json.rows[0][3], '0x00ff');
  const csv = Papa.parse<string[]>(await readFile('output/database-exports/result.csv', 'utf8')).data;
  assert.equal(csv[1][1], '林晓·编辑验证');
  const workbook = await readWorkbook(await readFile('output/database-exports/result.xlsx'), 'result.xlsx');
  assert.equal(workbook.model.sheets[0].cells['1,1'].value, '林晓·编辑验证');
  assert.equal(workbook.model.sheets[0].cells['1,3'].value, '0x00ff');
  const copy = new SqliteClient(resolve('dist'), await readFile('output/database-exports/copy.db'));
  const restored = new SqliteClient(resolve('dist'), new Uint8Array());
  try {
    await restored.call('execute', { sql: await readFile('output/database-exports/copy.sql', 'utf8') });
    for (const client of [copy, restored]) {
      const data = (
        await client.call<TablePage>('page', { object: { schema: 'main', name: 'customers', type: 'table' } })
      ).result;
      assert.equal(data.total, 137);
      assert.equal(data.rows[0][1], '林晓·编辑验证');
      assert.equal(
        (await client.call<DbObject[]>('catalog')).result.some((o) => o.name === 'revenue_summary'),
        true,
      );
    }
    console.log(
      'PASS actual browser exports: CSV, JSON, readable XLSX, SQLite copy and SQL dump reconstruct expected data',
    );
  } finally {
    await copy.close();
    await restored.close();
  }
}
void main();
