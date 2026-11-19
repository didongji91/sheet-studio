import Papa from 'papaparse';
import { blankWorkbook } from '../model';
import { writeWorkbook } from '../files';
import type { DbValue, QueryResult } from './types';

export async function exportQueryResult(result: QueryResult, format: string): Promise<Uint8Array> {
  if (
    !result ||
    !Array.isArray(result.columns) ||
    !Array.isArray(result.rows) ||
    result.rows.length > 20000 ||
    !['csv', 'json', 'xlsx'].includes(format)
  )
    throw new Error('导出结果无效。');
  const scalar = (value: DbValue) => (value && typeof value === 'object' ? '0x' + value.hex : value);
  const rows = result.rows.map((row) => row.map(scalar));
  if (format === 'json')
    return Buffer.from(JSON.stringify({ columns: result.columns, rows, truncated: result.truncated }, null, 2));
  if (format === 'csv') return Buffer.from('\ufeff' + Papa.unparse({ fields: result.columns, data: rows }));
  const workbook = blankWorkbook('查询结果.xlsx'),
    sheet = workbook.sheets[0];
  [result.columns, ...rows].forEach((row, r) =>
    row.forEach((value, c) => {
      sheet.cells[`${r},${c}`] = { value, ...(r === 0 ? { style: { bold: true, background: '#eef5f1' } } : {}) };
    }),
  );
  sheet.frozenRows = 1;
  return writeWorkbook(workbook, 'xlsx');
}
