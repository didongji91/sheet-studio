import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankWorkbook, applyOperation, inputCell, translateFormula, key, parseAddress, cellAddress } from '../src/model';
import { Calculator, displayCell } from '../src/formula';

test('addresses support Excel bounds and reject invalid positions', () => {
  assert.deepEqual(parseAddress('$XFD$1048576'), [1048575, 16383]);
  assert.equal(cellAddress(1048575, 16383), 'XFD1048576');
  for (const bad of ['A0', 'XFE1', 'A1048577', '0', 'A-1']) assert.equal(parseAddress(bad), null);
});
test('input preserves identifiers, handles numeric types, text and percentages', () => {
  assert.equal(inputCell('00123')?.value, '00123');
  assert.equal(inputCell('123456789012345678')?.value, '123456789012345678');
  assert.equal(inputCell('42')?.value, 42);
  assert.equal(inputCell('12.5%')?.value, 0.125);
  assert.equal(inputCell("'=A1")?.value, '=A1');
  assert.equal(inputCell('123', { value: null, style: { numberFormat: '@' } })?.value, '123');
});
test('copying formulas shifts relative references without editing strings or function names', () => {
  assert.equal(translateFormula('SUM(A1,$B$2,C$3,$D4)+"A1"+LOG10(100)', 2, 3), 'SUM(D3,$B$2,F$3,$D6)+"A1"+LOG10(100)');
  assert.equal(translateFormula("'测试 表'!A1:B2", 1, 1), "'测试 表'!B2:C3");
  assert.equal(translateFormula('A1', -1, 0), '#REF!');
});
test('formulas recalculate chained references and cross-sheet ranges after edits', () => {
  let wb = blankWorkbook(); const id = wb.sheets[0].id;
  wb = applyOperation(wb, { type: 'cells', sheetId: id, changes: [
    { row: 0, col: 0, cell: { value: 10 } }, { row: 1, col: 0, cell: { value: 20 } },
    { row: 0, col: 1, cell: { value: null, formula: 'SUM(A1:A2)' } },
    { row: 0, col: 2, cell: { value: null, formula: 'B1*2+IF(A1>5,1,0)' } },
  ] });
  let calc = new Calculator(wb);
  assert.equal(calc.evaluate(id, 0, 1).value, 30);
  assert.equal(calc.evaluate(id, 0, 2).value, 61);
  wb = applyOperation(wb, { type: 'addSheet', name: '合计 表', id: 'other' });
  wb = applyOperation(wb, { type: 'cells', sheetId: 'other', changes: [{ row: 0, col: 0, cell: { value: null, formula: 'SUM(Sheet1!A1:A2)' } }] });
  assert.equal(new Calculator(wb).evaluate('other', 0, 0).value, 30);
  wb = applyOperation(wb, { type: 'cells', sheetId: id, changes: [{ row: 0, col: 0, cell: { value: 50 } }] });
  assert.equal(new Calculator(wb).evaluate('other', 0, 0).value, 70);
});
test('formula errors propagate, cycles are bounded and unsupported formulas identify cached results', () => {
  const wb = blankWorkbook(), sheet = wb.sheets[0];
  sheet.cells = { '0,0': { value: null, formula: 'B1' }, '0,1': { value: null, formula: 'A1' }, '1,0': { value: null, formula: '1/0' }, '2,0': { value: null, formula: 'UNKNOWNFUNCTION(2)', cached: 123 } };
  const calc = new Calculator(wb);
  assert.equal(calc.evaluate(sheet.id, 0, 0).error, '#CIRC!');
  assert.equal(calc.evaluate(sheet.id, 1, 0).error, '#DIV/0!');
  assert.equal(calc.evaluate(sheet.id, 2, 0).value, 123);
  assert.equal(calc.evaluate(sheet.id, 2, 0).cached, true);
});
test('row insertion updates absolute, qualified and range references, but not strings', () => {
  let wb = blankWorkbook(); const id = wb.sheets[0].id;
  wb.sheets[0].cells = { '0,0': { value: 3 }, '1,0': { value: 4 }, '2,1': { value: null, formula: 'SUM($A$1:A2)+"A2"' } };
  wb = applyOperation(wb, { type: 'addSheet', id: 'other', name: 'Other' });
  wb.sheets[1].cells['0,0'] = { value: null, formula: 'SUM(Sheet1!A1:A2)+A2' };
  const original = wb;
  wb = applyOperation(wb, { type: 'structure', sheetId: id, axis: 'row', index: 1, count: 2 });
  assert.equal(wb.sheets[0].cells['4,1'].formula, 'SUM($A$1:A4)+"A2"');
  assert.equal(wb.sheets[1].cells['0,0'].formula, 'SUM(Sheet1!A1:A4)+A2');
  assert.equal(wb.sheets[0].cells['3,0'].value, 4);
  assert.equal(original.sheets[0].cells['1,0'].value, 4);
});
test('renaming a sheet updates quoted references and deletion produces REF', () => {
  let wb = blankWorkbook(); const id = wb.sheets[0].id;
  wb = applyOperation(wb, { type: 'addSheet', id: 'other', name: 'Other' });
  wb.sheets[1].cells['0,0'] = { value: null, formula: 'Sheet1!A1+"Sheet1!A1"' };
  wb = applyOperation(wb, { type: 'renameSheet', sheetId: id, name: "O'Brien" });
  assert.equal(wb.sheets[1].cells['0,0'].formula, `'O''Brien'!A1+"Sheet1!A1"`);
  wb = applyOperation(wb, { type: 'deleteSheet', sheetId: id });
  assert.equal(wb.sheets[0].cells['0,0'].formula, '#REF!+"Sheet1!A1"');
});
test('sort preserves headers, moves whole rows and relocates relative formulas', () => {
  let wb = blankWorkbook(); const sheet = wb.sheets[0];
  sheet.cells = { '0,0': { value: '金额' }, '1,0': { value: 30 }, '2,0': { value: 10 }, '1,1': { value: null, formula: 'A2*2' }, '2,1': { value: null, formula: 'A3*2' } };
  wb = applyOperation(wb, { type: 'sort', sheetId: sheet.id, column: 0, descending: false, header: true });
  assert.equal(wb.sheets[0].cells['0,0'].value, '金额');
  assert.equal(wb.sheets[0].cells['1,0'].value, 10);
  assert.equal(wb.sheets[0].cells['1,1'].formula, 'A2*2');
  assert.equal(new Calculator(wb).evaluate(sheet.id, 1, 1).value, 20);
});
test('merge rejects data loss and structural operations adjust merge ranges', () => {
  let wb = blankWorkbook(); const id = wb.sheets[0].id;
  wb.sheets[0].cells = { '0,0': { value: 1 }, '0,1': { value: 2 } };
  assert.throws(() => applyOperation(wb, { type: 'merge', sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 1 } }), /非空/);
  wb.sheets[0].cells = {};
  wb = applyOperation(wb, { type: 'merge', sheetId: id, range: { r1: 1, c1: 0, r2: 2, c2: 2 } });
  wb = applyOperation(wb, { type: 'structure', sheetId: id, axis: 'row', index: 0, count: 1 });
  assert.deepEqual(wb.sheets[0].merges[0], { r1: 2, c1: 0, r2: 3, c2: 2 });
});
test('styles and cell changes are immutable and text files cannot acquire extra sheets', () => {
  const wb = blankWorkbook(), id = wb.sheets[0].id;
  const updated = applyOperation(wb, { type: 'style', sheetId: id, range: { r1: 0, c1: 0, r2: 1, c2: 1 }, style: { bold: true } });
  assert.equal(wb.sheets[0].cells[key(0, 0)], undefined);
  assert.equal(updated.sheets[0].cells[key(1, 1)].style?.bold, true);
  wb.text = { encoding: 'utf8', delimiter: ',', newline: '\n', bom: false };
  assert.throws(() => applyOperation(wb, { type: 'addSheet', id: 'bad', name: 'Bad' }), /只能保存/);
});
test('deleting part of a referenced range shrinks it instead of turning its endpoint into REF', () => {
  let wb = blankWorkbook(); const id = wb.sheets[0].id;
  wb.sheets[0].cells = { '5,2': { value: null, formula: 'SUM(A1:A5)+SUM($B$1:$B$3)+A1' } };
  wb = applyOperation(wb, { type: 'structure', sheetId: id, axis: 'row', index: 0, count: 1, remove: true });
  assert.equal(wb.sheets[0].cells['4,2'].formula, 'SUM(A1:A4)+SUM($B$1:$B$2)+#REF!');
  wb = applyOperation(wb, { type: 'structure', sheetId: id, axis: 'row', index: 0, count: 4, remove: true });
  assert.equal(wb.sheets[0].cells['0,2'].formula, 'SUM(#REF!)+SUM(#REF!)+#REF!');
});
test('dates and Excel number format codes render as dates, percentages and currency', () => {
  const date = inputCell('2026-11-19')!;
  assert.equal(date.kind, 'date');
  assert.equal(displayCell(date, { value: date.value }), '2026-11-19');
  assert.equal(displayCell({ value: 46345, style: { numberFormat: 'yyyy-mm-dd' } }, { value: 46345 }), '2026-11-19');
  assert.equal(displayCell({ value: 0.125, style: { numberFormat: '0.00%' } }, { value: 0.125 }), '12.50%');
});
test('batch dimension changes retain earlier workbook snapshots for undo and preserve other sheets', () => {
  let before = blankWorkbook();
  before = applyOperation(before, { type: 'addSheet', name: 'Other', id: 'other' });
  const sheet = before.sheets[0];
  sheet.rowHeights = { 0: 35, 5: 60 }; sheet.columnWidths = { 0: 130, 4: 180 };
  const rows = applyOperation(before, { type: 'resize', sheetId: sheet.id, axis: 'row', index: 1, count: 3, size: 48.5 });
  const columns = applyOperation(rows, { type: 'resize', sheetId: sheet.id, axis: 'column', index: 1, count: 2, size: 156.25 });
  assert.deepEqual(before.sheets[0].rowHeights, { 0: 35, 5: 60 });
  assert.deepEqual(before.sheets[0].columnWidths, { 0: 130, 4: 180 });
  assert.deepEqual(columns.sheets[0].rowHeights, { 0: 35, 1: 48.5, 2: 48.5, 3: 48.5, 5: 60 });
  assert.deepEqual(columns.sheets[0].columnWidths, { 0: 130, 1: 156.25, 2: 156.25, 4: 180 });
  assert.deepEqual(rows.sheets[0].columnWidths, { 0: 130, 4: 180 });
  assert.equal(columns.sheets[1], before.sheets[1]);
});
test('resizing rejects nonfinite dimensions and ranges outside the sheet without mutating data', () => {
  const wb = blankWorkbook(), sheetId = wb.sheets[0].id;
  const resize = { type: 'resize' as const, sheetId, axis: 'row' as const, index: 0, size: 30 };
  for (const size of [NaN, Infinity, -1, 19.9, 1000.1]) assert.throws(() => applyOperation(wb, { ...resize, size }), /20–1000/);
  for (const change of [{ index: -1 }, { index: .5 }, { count: 0 }, { count: 1.5 }, { index: 99, count: 2 }, { index: 100 }])
    assert.throws(() => applyOperation(wb, { ...resize, ...change }), /范围/);
  assert.throws(() => applyOperation(wb, { ...resize, axis: 'column', index: 25, count: 2 }), /范围/);
  assert.deepEqual(wb.sheets[0].rowHeights, {});
  assert.deepEqual(wb.sheets[0].columnWidths, {});
  assert.equal(applyOperation(wb, { ...resize, index: 99, size: 20 }).sheets[0].rowHeights[99], 20);
  assert.equal(applyOperation(wb, { ...resize, axis: 'column', index: 25, size: 1000 }).sheets[0].columnWidths[25], 1000);
});
