import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import iconv from 'iconv-lite';
import { strToU8, zipSync, unzipSync } from 'fflate';
import { readWorkbook, writeWorkbook } from '../src/files';
import { applyOperation, blankWorkbook, inputCell } from '../src/model';

test('CSV round trip preserves quoting, embedded newline, leading zeroes, long IDs, formula text and numeric spelling', async () => {
  const csv = '编号,金额,说明\r\n00123,1.00,"第一行\r\n第二行"\r\n123456789012345678,20,"a,b"\r\n=1+2,3,"他说""好"""\r\n';
  const loaded = await readWorkbook(Buffer.from(csv), 'sample.csv');
  const cells = loaded.model.sheets[0].cells;
  assert.equal(cells['1,0'].value, '00123');
  assert.equal(cells['2,0'].value, '123456789012345678');
  assert.equal(cells['3,0'].formula, undefined);
  assert.equal(cells['3,0'].value, '=1+2');
  assert.equal(cells['1,1'].value, 1);
  const bytes = await writeWorkbook(loaded.model, 'csv', loaded);
  const again = await readWorkbook(bytes, 'sample.csv');
  assert.equal(again.model.sheets[0].cells['1,1'].textRaw, '1.00');
  assert.deepEqual(again.model.sheets[0].cells, cells);
});
test('GB18030, UTF-16 and delimiter detection round trip Chinese text', async () => {
  for (const encoding of ['gb18030', 'utf16le']) {
    const source = iconv.encode('姓名;城市\r\n张三;杭州', encoding, { addBOM: encoding === 'utf16le' });
    const loaded = await readWorkbook(source, 'chinese.csv');
    assert.equal(loaded.model.text?.encoding, encoding);
    assert.equal(loaded.model.text?.delimiter, ';');
    assert.equal(loaded.model.sheets[0].cells['1,1'].value, '杭州');
    const again = await readWorkbook(await writeWorkbook(loaded.model, 'csv'), 'chinese.csv');
    assert.equal(again.model.sheets[0].cells['1,0'].value, '张三');
  }
});
test('TSV preserves tab-separated quoted text and blank cells', async () => {
  const loaded = await readWorkbook(Buffer.from('编号\t备注\t数量\n0001\t"含\t制表符"\t10\n0002\t\t20'), 'data.tsv');
  assert.equal(loaded.model.sheets[0].cells['1,1'].value, '含\t制表符');
  const again = await readWorkbook(await writeWorkbook(loaded.model, 'tsv'), 'data.tsv');
  assert.equal(again.model.sheets[0].cells['1,0'].value, '0001');
  assert.equal(again.model.sheets[0].cells['2,2'].value, 20);
});
async function fixture() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据');
  ws.getCell('A1').value = '产品';
  ws.getCell('B1').value = '金额';
  ws.getCell('A2').value = '测试';
  ws.getCell('B2').value = 120;
  ws.getCell('B3').value = 80;
  ws.getCell('B4').value = { formula: 'SUM(B2:B3)', result: 200 };
  ws.getCell('A1').font = { bold: true, color: { argb: 'FF123456' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEADD' } };
  ws.getCell('B2').numFmt = '"¥"#,##0.00';
  ws.getCell('B2').border = { bottom: { style: 'thin', color: { argb: 'FF112233' } } };
  ws.getCell('D1').value = new Date('2026-11-19T00:00:00Z');
  ws.getCell('D1').numFmt = 'yyyy-mm-dd';
  ws.getCell('D2').value = { text: '文档', hyperlink: 'https://example.com' };
  ws.mergeCells('F1:G1'); ws.getCell('F1').value = '合并区域';
  ws.getColumn(2).width = 18; ws.getRow(1).height = 25;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  wb.addWorksheet('汇总').getCell('A1').value = { formula: "'数据'!B4", result: 200 };
  return new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer);
}
test('XLSX edit/save/reload preserves types, formatting, borders, links, merges, panes and recalculates formulas', async () => {
  const loaded = await readWorkbook(await fixture(), 'sample.xlsx');
  const id = loaded.model.sheets[0].id;
  const model = applyOperation(loaded.model, { type: 'cells', sheetId: id, changes: [{ row: 1, col: 1, cell: inputCell('150', loaded.model.sheets[0].cells['1,1']) }] });
  const bytes = await writeWorkbook(model, 'xlsx', loaded);
  const native = new ExcelJS.Workbook(); await native.xlsx.load(Buffer.from(bytes) as any);
  const ws = native.worksheets[0];
  assert.equal(ws.getCell('B2').value, 150);
  assert.equal(ws.getCell('B4').result, 230);
  assert.equal(native.worksheets[1].getCell('A1').result, 230);
  assert.equal(ws.getCell('A1').font.bold, true);
  assert.equal(ws.getCell('A1').fill.type, 'pattern');
  assert.equal(ws.getCell('B2').border.bottom?.style, 'thin');
  assert.equal(ws.getCell('B2').numFmt, '"¥"#,##0.00');
  assert.equal(ws.getCell('D1').value instanceof Date, true);
  assert.equal((ws.getCell('D1').value as Date).toISOString(), '2026-11-19T00:00:00.000Z');
  assert.equal(ws.getCell('D2').hyperlink, 'https://example.com');
  assert.equal(ws.getCell('G1').master.address, 'F1');
  assert.equal(ws.views[0].state, 'frozen');
});
test('XLSX cleared cells stay cleared, added sheets survive and renamed references recalculate', async () => {
  const loaded = await readWorkbook(await fixture(), 'sample.xlsx');
  let wb = applyOperation(loaded.model, { type: 'cells', sheetId: loaded.model.sheets[0].id, changes: [{ row: 1, col: 1, cell: null }] });
  wb = applyOperation(wb, { type: 'renameSheet', sheetId: wb.sheets[0].id, name: '新数据' });
  wb = applyOperation(wb, { type: 'addSheet', id: 'uuid-extra', name: '新增' });
  const again = await readWorkbook(await writeWorkbook(wb, 'xlsx', loaded), 'again.xlsx');
  assert.equal(again.model.sheets.length, 3);
  assert.equal(again.model.sheets[0].cells['1,1']?.value ?? null, null);
  assert.equal(again.model.sheets[1].cells['0,0'].cached, 80);
});
test('advanced XLSX objects trigger copy-only compatibility mode', async () => {
  const entries = unzipSync(await fixture());
  entries['xl/charts/chart1.xml'] = strToU8('<chart/>');
  const loaded = await readWorkbook(zipSync(entries), 'chart.xlsx');
  assert.equal(loaded.fidelityRisk, true);
  assert.ok(loaded.model.warnings.length);
});
test('legacy XLS and ODS open in compatibility mode and export to XLSX', async () => {
  for (const format of ['xls', 'ods'] as const) {
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['编号', '值'], ['00123', 42]]), '测试');
    const loaded = await readWorkbook(XLSX.write(wb, { type: 'buffer', bookType: format }), `legacy.${format}`);
    assert.equal(loaded.fidelityRisk, true);
    assert.equal(loaded.model.sheets[0].cells['1,0'].value, '00123');
    const exported = await readWorkbook(await writeWorkbook(loaded.model, 'xlsx'), 'converted.xlsx');
    assert.equal(exported.model.sheets[0].cells['1,1'].value, 42);
  }
});
test('CSV export uses computed values of the selected sheet', async () => {
  const loaded = await readWorkbook(await fixture(), 'sample.xlsx');
  const bytes = await writeWorkbook(loaded.model, 'csv', loaded, loaded.model.sheets[1].id);
  assert.equal(Buffer.from(bytes).toString('utf8').replace(/^\ufeff/, ''), '200');
});
test('XLSX stores resized empty rows and columns and keeps fractional dimensions after reopening and another save', async () => {
  let wb = blankWorkbook(); const id = wb.sheets[0].id;
  wb = applyOperation(wb, { type: 'resize', sheetId: id, axis: 'row', index: 8, count: 3, size: 47.5 });
  wb = applyOperation(wb, { type: 'resize', sheetId: id, axis: 'column', index: 4, count: 2, size: 173.25 });
  const bytes = await writeWorkbook(wb, 'xlsx');
  const native = new ExcelJS.Workbook(); await native.xlsx.load(Buffer.from(bytes) as any);
  assert.equal(native.worksheets[0].getRow(10).height, 35.625);
  const nativeWidth = native.worksheets[0].getColumn(6).width;
  assert.ok(nativeWidth);
  assert.ok(Math.abs((nativeWidth * 7 + 5) - 173.25) < .01);
  const loaded = await readWorkbook(bytes, 'empty-dimensions.xlsx');
  for (const row of [8, 9, 10]) assert.equal(loaded.model.sheets[0].rowHeights[row], 47.5);
  for (const col of [4, 5]) assert.equal(loaded.model.sheets[0].columnWidths[col], 173.25);
  assert.equal(Object.keys(loaded.model.sheets[0].cells).length, 0, 'resizing must not invent cell contents');
  const updated = applyOperation(loaded.model, { type: 'resize', sheetId: loaded.model.sheets[0].id, axis: 'row', index: 9, size: 65 });
  const again = await readWorkbook(await writeWorkbook(updated, 'xlsx', loaded), 'again.xlsx');
  assert.equal(again.model.sheets[0].rowHeights[8], 47.5);
  assert.equal(again.model.sheets[0].rowHeights[9], 65);
  assert.equal(again.model.sheets[0].columnWidths[5], 173.25);
});
test('XLSX dimension-only rows and columns beyond the used cells stay reachable', async () => {
  const native = new ExcelJS.Workbook(), ws = native.addWorksheet('稀疏表格');
  ws.getCell('A1').value = '数据';
  ws.getRow(150).height = 60;
  ws.getColumn(40).width = 24;
  const loaded = await readWorkbook(new Uint8Array(await native.xlsx.writeBuffer() as ArrayBuffer), 'sparse.xlsx');
  const sheet = loaded.model.sheets[0];
  assert.ok(sheet.rowCount >= 150);
  assert.ok(sheet.columnCount >= 40);
  assert.equal(sheet.rowHeights[149], 80);
  assert.equal(sheet.columnWidths[39], 173);
  const wb = applyOperation(loaded.model, { type: 'resize', sheetId: sheet.id, axis: 'column', index: 39, size: 225 });
  const again = await readWorkbook(await writeWorkbook(wb, 'xlsx', loaded), 'again.xlsx');
  assert.equal(again.model.sheets[0].columnWidths[39], 225);
  assert.equal(again.model.sheets[0].rowHeights[149], 80);
});
