import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import iconv from 'iconv-lite';
import { unzipSync, strFromU8 } from 'fflate';
import { basename, extname } from 'node:path';
import { blankSheet, coordinates, key, cellAddress, type Workbook, type Sheet, type Cell, type CellStyle } from './model';
import { Calculator } from './formula';

export interface ReadOptions { encoding?: string; delimiter?: string }
export interface LoadedFile { model: Workbook; original: Uint8Array; fidelityRisk: boolean }
export function detectEncoding(bytes: Uint8Array, preferred = 'auto'): string {
  if (preferred !== 'auto') return preferred;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf16be';
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return 'utf8'; } catch { return 'gb18030'; }
}
function color(value: any): string | undefined {
  if (value?.argb) return `#${value.argb.slice(-6)}`;
  const themes = ['#FFFFFF', '#172033', '#E7E6E6', '#44546A', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
  return typeof value?.theme === 'number' ? themes[value.theme] : undefined;
}
function readStyle(cell: ExcelJS.Cell): CellStyle | undefined {
  const style: CellStyle = {};
  if (cell.font?.bold) style.bold = true;
  if (cell.font?.italic) style.italic = true;
  if (cell.font?.underline) style.underline = true;
  if (cell.font?.size) style.fontSize = cell.font.size;
  if (cell.font?.color && cell.font.color.theme !== 1) style.color = color(cell.font.color);
  if (cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid') style.background = color(cell.fill.fgColor);
  if (['left', 'center', 'right'].includes(cell.alignment?.horizontal ?? '')) style.align = cell.alignment.horizontal as CellStyle['align'];
  if (cell.alignment?.wrapText) style.wrap = true;
  if (cell.numFmt && cell.numFmt !== 'General') style.numberFormat = cell.numFmt;
  return Object.keys(style).length ? style : undefined;
}
function scalar(value: any): Cell['value'] {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value.richText) return value.richText.map((v: any) => v.text).join('');
  if (value.text !== undefined) return String(value.text);
  if (value.error) return value.error;
  return String(value);
}
export async function readWorkbook(bytes: Uint8Array, filename: string, options: ReadOptions = {}): Promise<LoadedFile> {
  const format = extname(filename).slice(1).toLowerCase();
  const model: Workbook = { version: 1, sheets: [], format, name: basename(filename), warnings: [] };
  let fidelityRisk = false;
  if (format === 'csv' || format === 'tsv') {
    const encoding = detectEncoding(bytes, options.encoding);
    const text = iconv.decode(Buffer.from(bytes), encoding);
    const parsed = Papa.parse<string[]>(text, { delimiter: format === 'tsv' ? '\t' : options.delimiter === 'auto' ? '' : options.delimiter, skipEmptyLines: false });
    const fatal = parsed.errors.find(e => e.type === 'Quotes');
    if (fatal) throw new Error(`CSV 引号不完整：第 ${(fatal.row ?? 0) + 1} 行。${fatal.message}`);
    const sheet = blankSheet('Sheet1', 'sheet-1');
    let rows = parsed.data;
    if (rows.length > 1 && rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === '' && /[\r\n]$/.test(text)) rows = rows.slice(0, -1);
    rows.forEach((values, r) => values.forEach((value, c) => {
      // Keep the original spelling while safely recognizing ordinary numeric values.
      if (value !== '') {
        const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) && !/^[-+]?0\d/.test(value.trim()) && value.replace(/\D/g, '').length <= 15 ? Number(value) : null;
        sheet.cells[key(r, c)] = { value: number !== null && Number.isFinite(number) ? number : value, textRaw: value };
      }
      sheet.columnCount = Math.max(sheet.columnCount, c + 1);
    }));
    sheet.rowCount = Math.max(sheet.rowCount, rows.length);
    model.sheets.push(sheet);
    model.text = { encoding, delimiter: parsed.meta.delimiter || (format === 'tsv' ? '\t' : ','), newline: parsed.meta.linebreak || '\r\n', bom: text.charCodeAt(0) === 0xfeff || (bytes[0] === 0xef && bytes[1] === 0xbb) || encoding.startsWith('utf16') };
  } else if (format === 'xlsx') {
    const zip = unzipSync(bytes, { filter: file => /^(xl\/.*|docProps\/.*|_rels\/.*|\[Content_Types\]\.xml)$/.test(file.name) });
    const names = Object.keys(zip);
    const advanced = names.some(n => /^xl\/(charts|pivotTables|pivotCache|slicer|externalLinks|activeX|embeddings|tables|drawings)\//.test(n) || n.endsWith('vbaProject.bin'));
    const worksheetXML = names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).map(n => strFromU8(zip[n]));
    const additional = worksheetXML.some(xml => /<(?:\w+:)?(?:extLst|sheetProtection|oleObjects|conditionalFormatting|dataValidations)\b/.test(xml)) || (zip['xl/workbook.xml'] && /<definedNames\b/.test(strFromU8(zip['xl/workbook.xml'])));
    fidelityRisk = advanced || additional;
    if (fidelityRisk) model.warnings.push('此文件含图表、表格对象、透视表、名称、条件格式、数据验证或扩展对象。编辑后请导出副本，原文件会保留。');
    const native = new ExcelJS.Workbook();
    await native.xlsx.load(Buffer.from(bytes) as any);
    for (const ws of native.worksheets) {
      // ExcelJS exposes rows in the serialized model, including rows with only a custom height.
      const worksheetModel = ws.model as ExcelJS.WorksheetModel & { rows?: { number: number; height?: number }[] };
      const sheet = blankSheet(ws.name, `sheet-${ws.id}`);
      sheet.hidden = ws.state !== 'visible';
      sheet.rowCount = Math.max(100, ws.rowCount);
      sheet.columnCount = Math.max(26, ws.columnCount, ws.columns?.length ?? 0);
      for (const row of worksheetModel.rows ?? []) {
        if (row.height && row.number) sheet.rowHeights[row.number - 1] = row.height * 96 / 72;
      }
      ws.eachRow({ includeEmpty: false }, row => {
        row.eachCell({ includeEmpty: false }, nativeCell => {
          if (nativeCell.isMerged && nativeCell.master.address !== nativeCell.address) return;
          const cell: Cell = { value: null, style: readStyle(nativeCell), nativeStyle: structuredClone(nativeCell.style) };
          if (nativeCell.type === ExcelJS.ValueType.Formula) {
            cell.formula = nativeCell.formula;
            cell.cached = scalar(nativeCell.result);
          } else {
            cell.value = scalar(nativeCell.value);
            if (nativeCell.value instanceof Date) cell.kind = 'date';
            else if (nativeCell.type === ExcelJS.ValueType.Error) cell.kind = 'error';
          }
          sheet.cells[key(Number(nativeCell.row) - 1, Number(nativeCell.col) - 1)] = cell;
        });
      });
      ws.columns?.forEach((column, c) => {
        if (column?.width) sheet.columnWidths[c] = Math.max(20, Math.round((column.width * 7 + 5) * 100) / 100);
      });
      sheet.merges = (worksheetModel.merges ?? []).map(range => {
        const decoded = XLSX.utils.decode_range(range);
        return { r1: decoded.s.r, c1: decoded.s.c, r2: decoded.e.r, c2: decoded.e.c };
      });
      const view = ws.views?.find(v => v.state === 'frozen');
      if (view?.state === 'frozen') { sheet.frozenRows = view.ySplit ?? 0; sheet.frozenColumns = view.xSplit ?? 0; }
      model.sheets.push(sheet);
    }
  } else {
    const source = XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellStyles: true, cellDates: true, bookVBA: true, sheetStubs: true });
    fidelityRisk = true;
    model.warnings.push(`${format.toUpperCase()} 以兼容模式打开。编辑后可导出为 XLSX、CSV 或 TSV，保留原文件。`);
    for (let i = 0; i < source.SheetNames.length; i++) {
      const name = source.SheetNames[i], ws = source.Sheets[name];
      const sheet = blankSheet(name, `sheet-${i + 1}`);
      if (ws['!ref']) {
        const range = XLSX.utils.decode_range(ws['!ref']);
        sheet.rowCount = Math.max(100, range.e.r + 1); sheet.columnCount = Math.max(26, range.e.c + 1);
      }
      sheet.hidden = !!source.Workbook?.Sheets?.[i]?.Hidden;
      for (const [address, data] of Object.entries(ws)) {
        if (address.startsWith('!')) continue;
        const { r, c } = XLSX.utils.decode_cell(address);
        sheet.cells[key(r, c)] = { value: data.f ? null : scalar(data.v), formula: data.f, cached: data.f ? scalar(data.v) : undefined, kind: data.t === 'd' ? 'date' : data.t === 'e' ? 'error' : undefined, style: data.z ? { numberFormat: data.z } : undefined };
      }
      sheet.merges = (ws['!merges'] ?? []).map(m => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }));
      model.sheets.push(sheet);
    }
  }
  if (!model.sheets.length) model.sheets.push(blankSheet());
  const cells = model.sheets.reduce((n, s) => n + Object.keys(s.cells).length, 0);
  if (cells > 1_000_000) throw new Error('当前版本最多打开 1,000,000 个非空单元格，请拆分文件。');
  return { model, original: bytes, fidelityRisk };
}
function writeStyle(cell: ExcelJS.Cell, style?: CellStyle) {
  if (!style) return;
  const current = readStyle(cell);
  style = Object.fromEntries(Object.entries(style).filter(([k, value]) => value !== current?.[k as keyof CellStyle])) as CellStyle;
  if (!Object.keys(style).length) return;
  cell.font = { ...cell.font, ...(style.bold !== undefined ? { bold: style.bold } : {}), ...(style.italic !== undefined ? { italic: style.italic } : {}), ...(style.underline !== undefined ? { underline: style.underline } : {}), ...(style.fontSize ? { size: style.fontSize } : {}), ...(style.color ? { color: { argb: 'FF' + style.color.replace('#', '') } } : {}) };
  if (style.background) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + style.background.replace('#', '') } };
  cell.alignment = { ...cell.alignment, ...(style.align ? { horizontal: style.align } : {}), ...(style.wrap !== undefined ? { wrapText: style.wrap } : {}) };
  if (style.numberFormat !== undefined) cell.numFmt = style.numberFormat || 'General';
}
export async function writeWorkbook(model: Workbook, format: 'xlsx' | 'csv' | 'tsv', source?: LoadedFile, activeSheetId?: string): Promise<Uint8Array> {
  const calculator = new Calculator(model);
  if (format === 'csv' || format === 'tsv') {
    const sheet = model.sheets.find(s => s.id === activeSheetId) ?? model.sheets[0];
    let lastRow = 0, lastCol = 0;
    for (const address of Object.keys(sheet.cells)) {
      const cell = sheet.cells[address];
      if (cell.value === null && cell.formula === undefined) continue;
      const [r, c] = coordinates(address); lastRow = Math.max(lastRow, r); lastCol = Math.max(lastCol, c);
    }
    if ((lastRow + 1) * (lastCol + 1) > 5_000_000) throw new Error('导出文本矩形区域过大，请缩小数据范围或导出 XLSX。');
    const data = Array.from({ length: lastRow + 1 }, (_, r) => Array.from({ length: lastCol + 1 }, (_, c) => {
      const cell = sheet.cells[key(r, c)];
      if (cell?.formula) return calculator.evaluate(sheet.id, r, c).value ?? '';
      return cell?.textRaw ?? cell?.value ?? '';
    }));
    const delimiter = format === 'tsv' ? '\t' : model.format === 'csv' ? model.text?.delimiter ?? ',' : ',';
    const text = Papa.unparse(data, { delimiter, newline: model.text?.newline ?? '\r\n', quotes: false });
    const encoding = model.text?.encoding ?? 'utf8';
    return iconv.encode(text, encoding, { addBOM: model.text?.bom ?? true });
  }
  const native = new ExcelJS.Workbook();
  if (source?.model.format === 'xlsx' && source.original.length) await native.xlsx.load(Buffer.from(source.original) as any);
  else { native.creator = 'Sheet Studio'; native.created = new Date(); }
  native.modified = new Date();
  native.calcProperties.fullCalcOnLoad = true;
  const ids = new Set(model.sheets.map(s => s.id));
  for (const ws of [...native.worksheets]) if (!ids.has(`sheet-${ws.id}`)) native.removeWorksheet(ws.id);
  // Temporary names allow sheet renames, including swapping two sheet names.
  for (const ws of native.worksheets) ws.name = `_ss_${ws.id}_${Date.now()}`;
  for (const sheet of model.sheets) {
    const nativeId = /^sheet-(\d+)$/.exec(sheet.id)?.[1];
    const ws = nativeId ? native.getWorksheet(Number(nativeId)) ?? native.addWorksheet(sheet.name) : native.addWorksheet(sheet.name);
    ws.name = sheet.name;
    ws.state = sheet.hidden ? 'hidden' : 'visible';
    const previous = source?.model.sheets.find(s => s.id === sheet.id);
    const structurallyChanged = previous && (previous.rowCount !== sheet.rowCount || previous.columnCount !== sheet.columnCount);
    for (const range of [...(ws.model.merges ?? [])]) ws.unMergeCells(range);
    if (previous) {
      for (const address of Object.keys(previous.cells)) if (!sheet.cells[address]) {
        const [r, c] = coordinates(address); ws.getCell(r + 1, c + 1).value = null;
      }
    }
    for (const [address, cell] of Object.entries(sheet.cells)) {
      const [r, c] = coordinates(address), nativeCell = ws.getCell(r + 1, c + 1);
      const old = previous?.cells[address];
      if (cell.nativeStyle) nativeCell.style = structuredClone(cell.nativeStyle);
      if (cell.formula !== undefined) {
        const result = calculator.evaluate(sheet.id, r, c);
        nativeCell.value = { formula: cell.formula, result: (result.error && !result.cached ? { error: result.error === '#CIRC!' || result.error === '#LIMIT!' || result.error === '#ERROR!' ? '#VALUE!' : result.error } : result.value) as any };
      } else if (structurallyChanged || !old || old.value !== cell.value || old.kind !== cell.kind || old.formula !== undefined) {
        nativeCell.value = cell.kind === 'date' && typeof cell.value === 'string' ? new Date(cell.value) : cell.kind === 'error' ? { error: cell.value as any } : cell.value;
      }
      writeStyle(nativeCell, cell.style);
    }
    for (const col of Object.keys(previous?.columnWidths ?? {})) if (sheet.columnWidths[Number(col)] === undefined) ws.getColumn(Number(col) + 1).width = undefined;
    for (const row of Object.keys(previous?.rowHeights ?? {})) if (sheet.rowHeights[Number(row)] === undefined) ws.getRow(Number(row) + 1).height = ws.properties.defaultRowHeight || 15;
    for (const [col, width] of Object.entries(sheet.columnWidths)) ws.getColumn(Number(col) + 1).width = (width - 5) / 7;
    for (const [row, height] of Object.entries(sheet.rowHeights)) ws.getRow(Number(row) + 1).height = height * 72 / 96;
    for (const merge of sheet.merges) ws.mergeCells(`${cellAddress(merge.r1, merge.c1)}:${cellAddress(merge.r2, merge.c2)}`);
    ws.views = sheet.frozenRows || sheet.frozenColumns ? [{ state: 'frozen', xSplit: sheet.frozenColumns, ySplit: sheet.frozenRows }] : [{ state: 'normal' }];
    if (structurallyChanged && ws.autoFilter) ws.autoFilter = undefined as any;
  }
  return new Uint8Array(await native.xlsx.writeBuffer() as ArrayBuffer);
}
