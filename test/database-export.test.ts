import { test } from 'node:test';
import assert from 'node:assert/strict';
import Papa from 'papaparse';
import { exportQueryResult } from '../src/database/export';
import { readWorkbook } from '../src/files';
import type { QueryResult } from '../src/database/types';

const result: QueryResult = {
  columns: ['重复列', '重复列', '空值', '二进制', '备注'],
  rows: [['9223372036854775806', '=1+2', null, { type: 'blob', hex: '00ff' }, '第一行\n"第二行",中文']],
  truncated: true,
  affectedRows: 0,
  elapsedMs: 12,
};
test('database JSON and CSV exports preserve duplicate columns, large IDs, BLOBs and quoted multiline text', async () => {
  const json = JSON.parse(Buffer.from(await exportQueryResult(result, 'json')).toString('utf8'));
  assert.deepEqual(json.columns, result.columns);
  assert.equal(json.rows[0][0], '9223372036854775806');
  assert.equal(json.rows[0][2], null);
  assert.equal(json.rows[0][3], '0x00ff');
  assert.equal(json.truncated, true);
  const csv = Papa.parse<string[]>(Buffer.from(await exportQueryResult(result, 'csv')).toString('utf8')).data;
  assert.deepEqual(csv[0], result.columns);
  assert.equal(csv[1][4], result.rows[0][4]);
});
test('database XLSX export opens as a workbook and retains text, precision, formatting and frozen headers', async () => {
  const bytes = await exportQueryResult(result, 'xlsx');
  assert.equal(Buffer.from(bytes.subarray(0, 2)).toString(), 'PK');
  const { model } = await readWorkbook(bytes, 'database-result.xlsx');
  const sheet = model.sheets[0];
  assert.equal(sheet.cells['0,0'].value, '重复列');
  assert.equal(sheet.cells['0,1'].value, '重复列');
  assert.equal(sheet.cells['0,0'].style?.bold, true);
  assert.equal(sheet.cells['1,0'].value, '9223372036854775806');
  assert.equal(sheet.cells['1,1'].value, '=1+2');
  assert.equal(sheet.cells['1,1'].formula, undefined);
  assert.equal(sheet.cells['1,3'].value, '0x00ff');
  assert.equal(sheet.frozenRows, 1);
});
