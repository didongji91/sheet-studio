import FormulaParser from 'fast-formula-parser';
import * as SSF from 'ssf';
import { key, type Workbook, type Scalar, type Cell } from './model';

export interface Evaluation { value: Scalar; error?: string; cached?: boolean }
const errorPattern = /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|ERROR!|CIRC!|LIMIT!)/;
export class Calculator {
  private cache = new Map<string, Evaluation>();
  private visiting = new Set<string>();
  private parsers: any[] = [];
  private contexts: string[] = [];
  private reads = 0;
  constructor(private workbook: Workbook) {}
  evaluate(sheetId: string, row: number, col: number, depth = 0): Evaluation {
    const cacheKey = `${sheetId}:${key(row, col)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const sheet = this.workbook.sheets.find(s => s.id === sheetId);
    if (!sheet) return { value: '#REF!', error: '#REF!' };
    const cell = sheet.cells[key(row, col)];
    if (!cell?.formula) return { value: cell?.value ?? null, error: cell?.kind === 'error' ? String(cell.value) : undefined };
    if (this.visiting.has(cacheKey)) return { value: '#CIRC!', error: '#CIRC!' };
    if (depth > 100 || ++this.reads > 250_000) return { value: '#LIMIT!', error: '#LIMIT!' };
    this.visiting.add(cacheKey);
    this.contexts[depth] = sheet.name;
    let result: Evaluation;
    try {
      if (/\b(?:WEBSERVICE|IMPORTXML|IMPORTDATA|IMAGE|HYPERLINK)\s*\(/i.test(cell.formula)) throw { name: '#NAME?' };
      const parser = this.parsers[depth] ??= this.createParser(depth);
      const value = parser.parse(cell.formula.replace(/_xlfn\./g, ''), { row: row + 1, col: col + 1, sheet: sheet.name });
      if (value && typeof value === 'object' && String(value.name).startsWith('#')) throw value;
      if (Array.isArray(value)) throw { name: '#VALUE!' };
      if (typeof value === 'number' && !Number.isFinite(value)) throw { name: '#NUM!' };
      result = { value: value ?? null };
    } catch (error: any) {
      let cause = error;
      while (cause?.name === '#ERROR!' && cause?.details && errorPattern.test(cause.details.name ?? '')) cause = cause.details;
      const code = errorPattern.test(cause?.name ?? '') ? cause.name : '#ERROR!';
      result = { value: code, error: code };
      if ((code === '#NAME?' || code === '#ERROR!') && cell.cached !== undefined && cell.cached !== null)
        result = { value: cell.cached, error: code, cached: true };
    } finally {
      this.visiting.delete(cacheKey);
    }
    this.cache.set(cacheKey, result);
    if (depth === 0) this.reads = 0;
    return result;
  }
  private createParser(depth: number) {
    const read = (sheetName: string | undefined, row: number, col: number): any => {
      const sheet = this.workbook.sheets.find(s => s.name.toLowerCase() === (sheetName ?? this.contexts[depth]).toLowerCase());
      if (!sheet) throw FormulaParser.FormulaError.REF;
      const result = this.evaluate(sheet.id, row - 1, col - 1, depth + 1);
      if (result.error && !result.cached) {
        const error = new Error(result.error); error.name = result.error; throw error;
      }
      const cell = sheet.cells[key(row - 1, col - 1)];
      if (cell?.kind === 'date' && typeof result.value === 'string') return (new Date(result.value).getTime() - Date.UTC(1899, 11, 30)) / 86400000;
      return result.value;
    };
    return new FormulaParser({
      onCell: (ref: any) => read(ref.sheet, ref.row, ref.col),
      onRange: (ref: any) => {
        const sheet = this.workbook.sheets.find(s => s.name.toLowerCase() === (ref.sheet ?? this.contexts[depth]).toLowerCase());
        if (!sheet) throw FormulaParser.FormulaError.REF;
        const lastRow = Math.min(ref.to.row, sheet.rowCount), lastCol = Math.min(ref.to.col, sheet.columnCount);
        if ((lastRow - ref.from.row + 1) * (lastCol - ref.from.col + 1) > 250_000) throw { name: '#LIMIT!' };
        const rows = [];
        for (let row = ref.from.row; row <= lastRow; row++) {
          const values = [];
          for (let col = ref.from.col; col <= lastCol; col++) values.push(read(ref.sheet, row, col));
          rows.push(values);
        }
        return rows.length ? rows : [[null]];
      },
      onVariable: () => { throw FormulaParser.FormulaError.NAME; },
      functions: { WEBSERVICE: () => { throw FormulaParser.FormulaError.NAME; } },
    });
  }
}
export function displayCell(cell: Cell | undefined, evaluation: Evaluation): string {
  const value = evaluation.value;
  if (value === null || value === undefined) return '';
  if (cell?.kind === 'date' && typeof value === 'string') {
    const serial = (new Date(value).getTime() - Date.UTC(1899, 11, 30)) / 86400000;
    try { return SSF.format(cell.style?.numberFormat || 'yyyy-mm-dd', serial); } catch { return value.slice(0, 10); }
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'number') return String(value);
  const format = cell?.style?.numberFormat ?? '';
  if (format && format !== 'General' && format !== '@') {
    try { return SSF.format(format, value); } catch { /* Fall back to a readable value for unsupported custom codes. */ }
  }
  if (format.includes('%')) {
    const digits = format.match(/0\.(0+)%/)?.[1].length ?? 0;
    return `${(value * 100).toFixed(Math.min(digits, 10))}%`;
  }
  const decimals = format.match(/0\.(0+)/)?.[1].length;
  const symbol = format.includes('¥') || format.includes('￥') ? '¥' : format.includes('$') ? '$' : '';
  if (format.includes('#,##') || symbol || decimals !== undefined)
    return symbol + value.toLocaleString('zh-CN', { minimumFractionDigits: Math.min(decimals ?? 0, 10), maximumFractionDigits: Math.min(decimals ?? 0, 10), useGrouping: format.includes('#,##') || !!symbol });
  return String(Number(value.toPrecision(12)));
}
