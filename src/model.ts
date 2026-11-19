export type Scalar = string | number | boolean | null;
export interface CellStyle {
  bold?: boolean; italic?: boolean; underline?: boolean;
  color?: string; background?: string;
  align?: 'left' | 'center' | 'right'; wrap?: boolean;
  fontSize?: number; numberFormat?: string;
}
export interface Cell {
  value: Scalar;
  formula?: string;
  cached?: Scalar;
  kind?: 'date' | 'error';
  style?: CellStyle;
  textRaw?: string;
  nativeStyle?: Record<string, any>;
}
export interface Merge { r1: number; c1: number; r2: number; c2: number }
export interface Sheet {
  id: string; name: string; cells: Record<string, Cell>;
  rowCount: number; columnCount: number;
  columnWidths: Record<number, number>;
  rowHeights: Record<number, number>;
  merges: Merge[];
  frozenRows: number; frozenColumns: number;
  hidden?: boolean;
}
export interface Workbook {
  version: 1; sheets: Sheet[];
  format: string; name: string;
  warnings: string[];
  text?: { encoding: string; delimiter: string; newline: string; bom: boolean };
}
export type Operation =
  | { type: 'cells'; sheetId: string; changes: { row: number; col: number; cell: Cell | null }[]; label?: string }
  | { type: 'style'; sheetId: string; range: Merge; style: CellStyle }
  | { type: 'addSheet'; name: string; id: string }
  | { type: 'renameSheet'; sheetId: string; name: string }
  | { type: 'deleteSheet'; sheetId: string }
  | { type: 'duplicateSheet'; sheetId: string; id: string; name: string }
  | { type: 'resize'; sheetId: string; axis: 'row' | 'column'; index: number; count?: number; size: number }
  | { type: 'freeze'; sheetId: string; rows: number; columns: number }
  | { type: 'structure'; sheetId: string; axis: 'row' | 'column'; index: number; count: number; remove?: boolean }
  | { type: 'sort'; sheetId: string; column: number; descending: boolean; header: boolean; values?: Record<number, Scalar> }
  | { type: 'merge'; sheetId: string; range: Merge; unmerge?: boolean };

export const MAX_ROWS = 1_048_576;
export const MAX_COLUMNS = 16_384;
export const key = (row: number, col: number) => `${row},${col}`;
export const coordinates = (address: string) => address.split(',').map(Number) as [number, number];
export function columnName(col: number): string {
  let name = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}
export const cellAddress = (row: number, col: number) => `${columnName(col)}${row + 1}`;
export function parseAddress(text: string): [number, number] | null {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/.exec(text.trim());
  if (!match) return null;
  const col = [...match[1].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const row = Number(match[2]) - 1;
  return row < MAX_ROWS && col < MAX_COLUMNS ? [row, col] : null;
}
export function blankSheet(name = 'Sheet1', id: string = crypto.randomUUID()): Sheet {
  return { id, name, cells: {}, rowCount: 100, columnCount: 26, columnWidths: {}, rowHeights: {}, merges: [], frozenRows: 0, frozenColumns: 0 };
}
export function blankWorkbook(name = '工作簿.xlsx'): Workbook {
  return { version: 1, sheets: [blankSheet()], format: 'xlsx', name, warnings: [] };
}
export function inputCell(text: string, previous?: Cell): Cell | null {
  const style = previous?.style;
  const base = { style, ...(previous?.nativeStyle ? { nativeStyle: previous.nativeStyle } : {}) };
  if (!text) return style || previous?.nativeStyle ? { value: null, ...base } : null;
  if (text.startsWith('=')) return { value: null, formula: text.slice(1), ...base };
  if (text.startsWith("'")) return { value: text.slice(1), ...base };
  if (style?.numberFormat === '@') return { value: text, ...base };
  if (/^(true|false)$/i.test(text)) return { value: text.toLowerCase() === 'true', ...base };
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text)
      return { value: date.toISOString(), ...base, kind: 'date', style: { ...style, numberFormat: style?.numberFormat || 'yyyy-mm-dd' } };
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) && !/^[-+]?0\d/.test(text.trim())) {
    const number = Number(text);
    const digits = text.replace(/[-+.\seE]/g, '');
    if (Number.isFinite(number) && digits.length <= 15) return { value: number, ...base };
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(text.trim())) return { value: parseFloat(text) / 100, ...base, style: { ...style, numberFormat: '0.00%' } };
  return { value: text, ...base };
}
export function rawCell(cell?: Cell): string {
  if (!cell) return '';
  return cell.formula !== undefined ? `=${cell.formula}` : cell.value === null ? '' : String(cell.value);
}
export function normalizeRange(range: Merge): Merge {
  return { r1: Math.min(range.r1, range.r2), c1: Math.min(range.c1, range.c2), r2: Math.max(range.r1, range.r2), c2: Math.max(range.c1, range.c2) };
}
export function validateSheetName(workbook: Workbook, name: string, except?: string) {
  if (!name.trim() || name.length > 31 || /[\\/?*[\]:]/.test(name) || name.startsWith("'") || name.endsWith("'")) throw new Error('工作表名须为 1–31 个字符，不能包含 \\ / ? * [ ] : 或首尾单引号。');
  if (workbook.sheets.some(s => s.id !== except && s.name.toLowerCase() === name.toLowerCase())) throw new Error('工作表名称已存在。');
}
function referenceTokens(formula: string, visit: (token: string, index: number) => string): string {
  return formula.replace(/"(?:[^"]|"")*"|(?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_. ]*)!\$?[A-Za-z]{1,3}\$?[1-9]\d*|\$?[A-Za-z]{1,3}\$?[1-9]\d*/gu, (token, index) => {
    if (token.startsWith('"')) return token;
    const before = formula[index - 1], after = formula[index + token.length];
    if ((before && /[\p{L}\p{N}_.]/u.test(before)) || (after && /[\p{L}\p{N}_(]/u.test(after))) return token;
    return visit(token, index);
  });
}
export function translateFormula(formula: string, rows: number, columns: number): string {
  return referenceTokens(formula, token => token.replace(/(\$?)([A-Za-z]+)(\$?)(\d+)$/, (_m, absCol, col, absRow, row) => {
    const position = parseAddress(`${col}${row}`)!;
    const r = position[0] + (absRow ? 0 : rows), c = position[1] + (absCol ? 0 : columns);
    return r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLUMNS ? '#REF!' : `${absCol}${columnName(c)}${absRow}${r + 1}`;
  }));
}
function adjustFormula(formula: string, owner: string, target: string, axis: 'row' | 'column', index: number, count: number, remove?: boolean): string {
  const tokens: { text: string; start: number; end: number; sheet: string; n: number }[] = [];
  referenceTokens(formula, (text, start) => {
    const bang = text.lastIndexOf('!'), previous = tokens.at(-1);
    const inherited = previous && /^\s*:\s*$/.test(formula.slice(previous.end, start)) ? previous.sheet : owner;
    const sheet = bang >= 0 ? text.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'") : inherited;
    const address = parseAddress(text.slice(bang + 1))!;
    tokens.push({ text, start, end: start + text.length, sheet, n: address[axis === 'row' ? 0 : 1] });
    return text;
  });
  const render = (token: typeof tokens[number], next: number) => token.text.replace(/(\$?)([A-Za-z]+)(\$?)(\d+)$/, (_m, absCol, col, absRow, row) =>
    axis === 'row' ? `${absCol}${col}${absRow}${next + 1}` : `${absCol}${columnName(next)}${absRow}${row}`);
  const move = (n: number) => n >= index ? n + (remove ? -count : count) : n;
  let output = '', cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], end = tokens[i + 1];
    output += formula.slice(cursor, token.start);
    if (token.sheet.toLowerCase() !== target.toLowerCase()) { output += token.text; cursor = token.end; continue; }
    if (end && /^\s*:\s*$/.test(formula.slice(token.end, end.start)) && end.sheet.toLowerCase() === target.toLowerCase()) {
      const low = Math.min(token.n, end.n), high = Math.max(token.n, end.n);
      if (remove && low >= index && high < index + count) output += '#REF!';
      else {
        const nextLow = remove && low >= index && low < index + count ? index : move(low);
        const nextHigh = remove && high >= index && high < index + count ? index - 1 : move(high);
        output += render(token, token.n <= end.n ? nextLow : nextHigh) + formula.slice(token.end, end.start) + render(end, token.n <= end.n ? nextHigh : nextLow);
      }
      cursor = end.end; i++; continue;
    }
    output += remove && token.n >= index && token.n < index + count ? '#REF!' : render(token, move(token.n));
    cursor = token.end;
  }
  return output + formula.slice(cursor);
}
export function applyOperation(workbook: Workbook, operation: Operation): Workbook {
  if (operation.type === 'addSheet' || operation.type === 'duplicateSheet') {
    if (workbook.text) throw new Error('CSV/TSV 只能保存一个工作表，请先导出为 XLSX。');
    validateSheetName(workbook, operation.name);
    const source = operation.type === 'duplicateSheet' ? workbook.sheets.find(s => s.id === operation.sheetId) : undefined;
    const sheet = source ? { ...structuredClone(source), id: operation.id, name: operation.name } : blankSheet(operation.name, operation.id);
    return { ...workbook, sheets: [...workbook.sheets, sheet] };
  }
  const sheetIndex = workbook.sheets.findIndex(s => s.id === operation.sheetId);
  if (sheetIndex < 0) throw new Error('工作表不存在。');
  const original = workbook.sheets[sheetIndex];
  if (operation.type === 'deleteSheet') {
    if (workbook.sheets.length === 1) throw new Error('至少保留一个工作表。');
    if (workbook.sheets.filter(s => !s.hidden).length === 1 && !original.hidden) throw new Error('至少保留一个可见工作表。');
    const sheets = workbook.sheets.filter(s => s.id !== original.id).map(s => ({
      ...s, cells: Object.fromEntries(Object.entries(s.cells).map(([k, cell]) => [k, cell.formula === undefined ? cell : { ...cell, formula: referenceTokens(cell.formula, token => {
        const bang = token.lastIndexOf('!');
        return bang >= 0 && token.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'").toLowerCase() === original.name.toLowerCase() ? '#REF!' : token;
      }) }])),
    }));
    return { ...workbook, sheets };
  }
  const sheet = { ...original, cells: { ...original.cells } };
  const sheets = [...workbook.sheets]; sheets[sheetIndex] = sheet;
  const result = { ...workbook, sheets };
  switch (operation.type) {
    case 'cells':
      if (operation.changes.length > 250_000) throw new Error('单次编辑最多 250,000 个单元格。');
      for (const { row, col, cell } of operation.changes) {
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= MAX_ROWS || col >= MAX_COLUMNS) throw new Error('单元格坐标超出范围。');
        if (cell && (cell.value !== null || cell.formula !== undefined) && sheet.merges.some(m => row >= m.r1 && row <= m.r2 && col >= m.c1 && col <= m.c2 && (row !== m.r1 || col !== m.c1))) throw new Error('编辑区域包含合并单元格，请先取消合并。');
        const address = key(row, col);
        if (cell) sheet.cells[address] = structuredClone(cell); else delete sheet.cells[address];
        sheet.rowCount = Math.max(sheet.rowCount, row + 1); sheet.columnCount = Math.max(sheet.columnCount, col + 1);
      }
      break;
    case 'style': {
      const { r1, c1, r2, c2 } = normalizeRange(operation.range);
      if ((r2 - r1 + 1) * (c2 - c1 + 1) > 250_000) throw new Error('单次格式设置最多 250,000 个单元格。');
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const address = key(r, c), cell = sheet.cells[address] ?? { value: null };
        sheet.cells[address] = { ...cell, style: { ...cell.style, ...operation.style } };
      }
      sheet.rowCount = Math.max(sheet.rowCount, r2 + 1); sheet.columnCount = Math.max(sheet.columnCount, c2 + 1);
      break;
    }
    case 'renameSheet':
      validateSheetName(workbook, operation.name, sheet.id);
      sheet.name = operation.name;
      for (const s of sheets) {
        const renamed = { ...s, cells: { ...s.cells } };
        sheets[sheets.indexOf(s)] = renamed;
        for (const [address, cell] of Object.entries(renamed.cells)) if (cell.formula !== undefined) {
          renamed.cells[address] = { ...cell, formula: referenceTokens(cell.formula, token => {
            const bang = token.lastIndexOf('!');
            if (bang < 0 || token.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'").toLowerCase() !== original.name.toLowerCase()) return token;
            return `'${operation.name.replace(/'/g, "''")}'!${token.slice(bang + 1)}`;
          }) };
        }
      }
      break;
    case 'resize': {
      if (!Number.isFinite(operation.size) || operation.size < 20 || operation.size > 1000) throw new Error('尺寸必须在 20–1000 像素之间。');
      if (!['row', 'column'].includes(operation.axis)) throw new Error('请选择行高或列宽。');
      const count = operation.count ?? 1;
      const limit = operation.axis === 'row' ? sheet.rowCount : sheet.columnCount;
      if (!Number.isInteger(operation.index) || !Number.isInteger(count) || operation.index < 0 || count < 1 || operation.index + count > limit) throw new Error('行列尺寸设置超出工作表范围。');
      const sizes = { ...(operation.axis === 'column' ? sheet.columnWidths : sheet.rowHeights) };
      for (let i = operation.index; i < operation.index + count; i++) sizes[i] = operation.size;
      if (operation.axis === 'column') sheet.columnWidths = sizes;
      else sheet.rowHeights = sizes;
      break;
    }
    case 'freeze': sheet.frozenRows = operation.rows; sheet.frozenColumns = operation.columns; break;
    case 'merge': {
      const range = normalizeRange(operation.range);
      const overlaps = (m: Merge) => !(m.r2 < range.r1 || m.r1 > range.r2 || m.c2 < range.c1 || m.c1 > range.c2);
      sheet.merges = sheet.merges.filter(m => !overlaps(m));
      if (!operation.unmerge && (range.r1 !== range.r2 || range.c1 !== range.c2)) {
        const occupied = Object.entries(sheet.cells).some(([k, cell]) => {
          const [r, c] = coordinates(k);
          return r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2 && (r !== range.r1 || c !== range.c1) && (cell.value !== null || cell.formula !== undefined);
        });
        if (occupied) throw new Error('合并区域中有多个非空单元格，请先清空或移动数据。');
        sheet.merges.push(range);
      }
      break;
    }
    case 'structure': {
      const { axis, index, count, remove } = operation;
      if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || count < 1 || count > 10000) throw new Error('插入或删除位置无效。');
      const limit = axis === 'row' ? MAX_ROWS : MAX_COLUMNS;
      const size = axis === 'row' ? sheet.rowCount : sheet.columnCount;
      if (index >= size || (remove && index + count > size) || (!remove && size + count > limit)) throw new Error('插入或删除超出工作表范围。');
      const shifted: Record<string, Cell> = {};
      for (const [address, cell] of Object.entries(sheet.cells)) {
        const [r, c] = coordinates(address), n = axis === 'row' ? r : c;
        if (remove && n >= index && n < index + count) continue;
        const next = n >= index ? n + (remove ? -count : count) : n;
        shifted[key(axis === 'row' ? next : r, axis === 'column' ? next : c)] = cell;
      }
      sheet.cells = shifted;
      if (axis === 'row') sheet.rowCount = Math.max(1, size + (remove ? -count : count));
      else sheet.columnCount = Math.max(1, size + (remove ? -count : count));
      const sizes = axis === 'row' ? sheet.rowHeights : sheet.columnWidths;
      const nextSizes: Record<number, number> = {};
      for (const [n, value] of Object.entries(sizes)) {
        const old = Number(n);
        if (remove && old >= index && old < index + count) continue;
        nextSizes[old >= index ? old + (remove ? -count : count) : old] = value;
      }
      if (axis === 'row') sheet.rowHeights = nextSizes; else sheet.columnWidths = nextSizes;
      sheet.merges = sheet.merges.flatMap(m => {
        const a = axis === 'row' ? 'r1' : 'c1', b = axis === 'row' ? 'r2' : 'c2';
        if (remove && m[a] >= index && m[b] < index + count) return [];
        const move = (n: number, end: boolean) => !remove ? n >= index ? n + count : n : n < index ? n : n >= index + count ? n - count : end ? index - 1 : index;
        const next = { ...m, [a]: move(m[a], false), [b]: move(m[b], true) };
        return next[a] <= next[b] && (next.r1 !== next.r2 || next.c1 !== next.c2) ? [next] : [];
      });
      for (let i = 0; i < sheets.length; i++) {
        const s = { ...sheets[i], cells: { ...sheets[i].cells } };
        for (const [address, cell] of Object.entries(s.cells)) if (cell.formula !== undefined)
          s.cells[address] = { ...cell, formula: adjustFormula(cell.formula, s.name, original.name, axis, index, count, remove), cached: undefined };
        sheets[i] = s;
      }
      break;
    }
    case 'sort': {
      if (sheet.merges.length) throw new Error('请先取消合并单元格，再排序。');
      const start = operation.header ? 1 : 0;
      const last = Object.keys(sheet.cells).reduce((max, k) => Math.max(max, coordinates(k)[0]), start - 1);
      const rows = Array.from({ length: Math.max(0, last - start + 1) }, (_, i) => i + start);
      rows.sort((a, b) => {
        const x = sheet.cells[key(a, operation.column)], y = sheet.cells[key(b, operation.column)];
        const av = operation.values && a in operation.values ? operation.values[a] : x?.formula ? x.cached : x?.value;
        const bv = operation.values && b in operation.values ? operation.values[b] : y?.formula ? y.cached : y?.value;
        if ((x?.formula && av === undefined) || (y?.formula && bv === undefined)) throw new Error('排序列存在无法计算的公式。');
        if (av === null || av === undefined || av === '') return bv === null || bv === undefined || bv === '' ? 0 : 1;
        if (bv === null || bv === undefined || bv === '') return -1;
        const compare = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true });
        return operation.descending ? -compare : compare;
      });
      const destinations = new Map(rows.map((r, i) => [r, start + i]));
      sheet.cells = {};
      for (const [address, cell] of Object.entries(original.cells)) {
        const [r, c] = coordinates(address), dest = destinations.get(r) ?? r;
        sheet.cells[key(dest, c)] = cell.formula ? { ...cell, formula: translateFormula(cell.formula, dest - r, 0), cached: undefined } : cell;
      }
      break;
    }
  }
  return result;
}
