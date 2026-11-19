import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import { applyOperation, key, coordinates, cellAddress, columnName, parseAddress, inputCell, rawCell, normalizeRange, translateFormula, MAX_ROWS, MAX_COLUMNS, type Workbook, type Operation, type Cell, type CellStyle, type Merge, type Scalar } from '../src/model';
import { Calculator, displayCell } from '../src/formula';
import { appearanceVariables, BACKGROUND_PRESETS, DEFAULT_BACKGROUND, isDarkBackground, normalizeBackground, validBackground } from '../src/appearance';
import { bridge, isPreview } from './bridge';
import { Icon } from './icons';

type Selection = Merge;
type Hit = { sheetId: string; row: number; col: number; text: string; address: string };
type ResizeAxis = 'row' | 'column';
type ResizePreview = { axis: ResizeAxis; index: number; count: number; size: number; x: number; y: number };
type Dialog = { title: string; value: string; action: (value: string) => void; numeric?: boolean; hint?: string };
const HEADER = 30, GUTTER = 48, ROW = 30, COL = 120;
const selectionAt = (row: number, col: number): Selection => ({ r1: row, c1: col, r2: row, c2: col });
const uid = () => crypto.randomUUID();
function backgroundText(background?: string) {
  if (!background || !/^#[a-f\d]{6}$/i.test(background)) return undefined;
  const values = [1, 3, 5].map(index => parseInt(background.slice(index, index + 2), 16));
  return values[0] * .299 + values[1] * .587 + values[2] * .114 > 145 ? '#28332d' : '#edf6ef';
}
function offsets(count: number, sizes: Record<number, number>, fallback: number) {
  const values = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) values[i + 1] = values[i] + (sizes[i] ?? fallback);
  return values;
}
function findOffset(values: Float64Array, position: number) {
  let lo = 0, hi = values.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (values[mid] <= position) lo = mid; else hi = mid - 1; }
  return Math.min(lo, values.length - 2);
}
function App() {
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const bookRef = useRef<Workbook | null>(null);
  const [sheetId, setSheetId] = useState<string>(bridge.state()?.sheetId ?? '');
  const [selection, setSelection] = useState<Selection>(bridge.state()?.selection ?? selectionAt(0, 0));
  const [editing, setEditing] = useState<{ row: number; col: number; value: string; selectAll?: boolean } | null>(null);
  const editRef = useRef(editing); editRef.current = editing;
  const [formulaText, setFormulaText] = useState('');
  const [tab, setTab] = useState('开始');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [whole, setWhole] = useState(false);
  const [regex, setRegex] = useState(false);
  const [allSheets, setAllSheets] = useState(false);
  const [searchFormulas, setSearchFormulas] = useState(false);
  const [hitIndex, setHitIndex] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [filterColumn, setFilterColumn] = useState(-1);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'cell' | 'sheet' | 'export' } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0, width: 1000, height: 500 });
  const [zoom, setZoom] = useState(100);
  const [addressText, setAddressText] = useState('A1');
  const [showFormulas, setShowFormulas] = useState(false);
  const [backgroundColor, setBackgroundColor] = useState(() => normalizeBackground(bridge.state()?.backgroundColor));
  const [backgroundInput, setBackgroundInput] = useState(backgroundColor);
  const [resizePreview, setResizePreview] = useState<ResizePreview | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const appearanceStyle = useMemo(() => ({ ...appearanceVariables(backgroundColor), colorScheme: isDarkBackground(backgroundColor) ? 'dark' : 'light' }) as React.CSSProperties, [backgroundColor]);
  const viewport = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLInputElement>(null);
  const formula = useRef<HTMLInputElement>(null);
  const formulaCancelled = useRef(false);
  const pending = useRef<{ sequence: number; operation: Operation }[]>([]);
  const sequence = useRef(0), clientId = useRef(uid());
  const dragging = useRef(false);
  const copied = useRef<{ range: Selection; sheetId: string; cells: (Cell | null)[][]; text: string; cut?: boolean } | null>(null);
  const announce = useCallback((text: string) => { setNotice(text); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); }, [notice]);
  const sheet = workbook?.sheets.find(s => s.id === sheetId) ?? workbook?.sheets.find(s => !s.hidden) ?? workbook?.sheets[0];
  const currentSheetId = sheet?.id ?? '';
  const activeSheetRef = useRef(currentSheetId); activeSheetRef.current = currentSheetId;
  const calc = useMemo(() => workbook ? new Calculator(workbook) : null, [workbook]);
  const range = normalizeRange(selection);
  const activeCell = sheet?.cells[key(selection.r1, selection.c1)];
  const dispatch = useCallback((operation: Operation) => {
    if (!bookRef.current) return;
    try {
      const next = applyOperation(bookRef.current, operation);
      bookRef.current = next; setWorkbook(next); setSaved(false);
      const seq = ++sequence.current;
      pending.current.push({ sequence: seq, operation });
      bridge.post({ type: 'edit', clientId: clientId.current, sequence: seq, operation });
    } catch (error) { announce(error instanceof Error ? error.message : String(error)); }
  }, [announce]);
  const jump = useCallback((row: number, col: number) => {
    setSelection(selectionAt(row, col)); setEditing(null); setAddressText(cellAddress(row, col));
    const element = viewport.current;
    const current = bookRef.current?.sheets.find(s => s.id === activeSheetRef.current);
    if (element && current) {
      const xs = offsets(Math.max(current.columnCount, col + 1), current.columnWidths, COL);
      const ys = offsets(Math.max(current.rowCount, row + 1), current.rowHeights, ROW);
      if (row >= current.frozenRows) {
        const frozen = ys[current.frozenRows] ?? 0;
        if (ys[row] < element.scrollTop + frozen || ys[row + 1] > element.scrollTop + element.clientHeight - HEADER)
          element.scrollTop = Math.max(0, ys[row] - frozen - (element.clientHeight - HEADER - frozen) / 3);
      }
      if (col >= current.frozenColumns) {
        const frozen = xs[current.frozenColumns] ?? 0;
        if (xs[col] < element.scrollLeft + frozen || xs[col + 1] > element.scrollLeft + element.clientWidth - GUTTER)
          element.scrollLeft = Math.max(0, xs[col] - frozen - (element.clientWidth - GUTTER - frozen) / 3);
      }
      element.focus();
    }
  }, [currentSheetId]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const data = event.data;
      if (data.type === 'state' || data.type === 'error') {
        if (data.workbook) {
          if (data.ack !== undefined && (!data.clientId || data.clientId === clientId.current)) pending.current = pending.current.filter(p => p.sequence > data.ack);
          let next: Workbook = data.workbook;
          for (const item of pending.current) {
            try { next = applyOperation(next, item.operation); } catch { /* A deleted sheet can invalidate an optimistic edit. */ }
          }
          bookRef.current = next; setWorkbook(next);
          setSheetId(id => next.sheets.some(s => s.id === id) ? id : next.sheets.find(s => !s.hidden)?.id ?? next.sheets[0].id);
        }
        if (data.saved) { setSaved(true); announce('文件已保存'); }
        if (typeof data.dirty === 'boolean') setSaved(!data.dirty && !pending.current.length);
        if (data.message) announce(data.message);
      }
      if (data.type === 'notice') announce(data.message);
      if (data.type === 'appearance') {
        const color = normalizeBackground(data.backgroundColor);
        setBackgroundColor(color); setBackgroundInput(color);
      }
      if (data.type === 'reveal') {
        setSheetId(data.sheetId); setFilterText('');
        setTimeout(() => jump(data.row, data.col), 80);
      }
    };
    window.addEventListener('message', listener);
    bridge.post({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [announce]);
  useEffect(() => {
    if (!editing && document.activeElement !== formula.current) setFormulaText(rawCell(activeCell));
  }, [activeCell, selection, currentSheetId, editing]);
  useEffect(() => {
    setAddressText(selection.r1 === selection.r2 && selection.c1 === selection.c2 ? cellAddress(selection.r1, selection.c1) : `${cellAddress(range.r1, range.c1)}:${cellAddress(range.r2, range.c2)}`);
    bridge.remember({ sheetId: currentSheetId, selection, backgroundColor });
  }, [selection, currentSheetId, backgroundColor]);
  useEffect(() => {
    if (editing) { editor.current?.focus(); if (editing.selectAll) editor.current?.select(); }
  }, [editing?.row, editing?.col]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(() => setScroll(s => ({ ...s, width: element.clientWidth, height: element.clientHeight })));
    observer.observe(element);
    return () => observer.disconnect();
  }, [!!sheet]);
  useEffect(() => {
    const up = () => { dragging.current = false; };
    const close = () => setMenu(null);
    window.addEventListener('pointerup', up); window.addEventListener('click', close);
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('click', close); };
  }, []);
  useEffect(() => {
    if (!sheet) return;
    setSelection(s => ({ r1: Math.min(s.r1, sheet.rowCount - 1), r2: Math.min(s.r2, sheet.rowCount - 1), c1: Math.min(s.c1, sheet.columnCount - 1), c2: Math.min(s.c2, sheet.columnCount - 1) }));
  }, [currentSheetId, sheet?.rowCount, sheet?.columnCount]);
  useEffect(() => () => { resizeCleanup.current?.(); }, [currentSheetId]);

  function changeBackground(value: string) {
    const color = normalizeBackground(value);
    setBackgroundColor(color); setBackgroundInput(color);
    if (color !== backgroundColor) bridge.post({ type: 'setAppearance', backgroundColor: color });
  }
  function commitBackground() {
    if (validBackground(backgroundInput)) changeBackground(backgroundInput);
    else { setBackgroundInput(backgroundColor); announce('背景颜色须为 #RRGGBB 格式，例如 #ffffff'); }
  }
  function resizeTarget(axis: ResizeAxis, headerIndex?: number) {
    const start = axis === 'row' ? range.r1 : range.c1, end = axis === 'row' ? range.r2 : range.c2;
    return headerIndex === undefined || (headerIndex >= start && headerIndex <= end)
      ? { index: start, count: end - start + 1 } : { index: headerIndex, count: 1 };
  }
  function resizeDialog(axis: ResizeAxis, headerIndex?: number) {
    if (!sheet) return;
    commitEditing();
    const target = resizeTarget(axis, headerIndex);
    const size = (axis === 'row' ? sheet.rowHeights : sheet.columnWidths)[headerIndex ?? target.index] ?? (axis === 'row' ? ROW : COL);
    setDialog({
      title: axis === 'row' ? '设置行高' : '设置列宽', value: String(Math.round(size * 100) / 100), numeric: true,
      hint: `应用于所选 ${target.count} ${axis === 'row' ? '行' : '列'}，单位为像素，可输入 20–1000。`,
      action: value => dispatch({ type: 'resize', sheetId: sheet.id, axis, ...target, size: Number(value) }),
    });
  }
  function selectHeader(axis: ResizeAxis, index: number, extend: boolean) {
    commitEditing();
    setSelection(s => axis === 'row'
      ? { r1: extend ? s.r1 : index, r2: index, c1: 0, c2: used.col }
      : { r1: 0, r2: used.row, c1: extend ? s.c1 : index, c2: index });
    viewport.current?.focus();
  }
  function startResize(event: React.PointerEvent, axis: ResizeAxis, headerIndex: number) {
    if (!sheet || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); commitEditing(); setMenu(null); dragging.current = false;
    resizeCleanup.current?.();
    const target = resizeTarget(axis, headerIndex), pointerId = event.pointerId;
    const initial = (axis === 'row' ? sheet.rowHeights : sheet.columnWidths)[headerIndex] ?? (axis === 'row' ? ROW : COL);
    const start = axis === 'row' ? event.clientY : event.clientX;
    const sizeAt = (pointer: PointerEvent) => Math.max(20, Math.min(1000, Math.round(initial + ((axis === 'row' ? pointer.clientY : pointer.clientX) - start) / (zoom / 100))));
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      setResizePreview({ axis, ...target, size: sizeAt(pointer), x: pointer.clientX, y: pointer.clientY });
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape); resizeCleanup.current = null; setResizePreview(null);
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      if (Math.abs((axis === 'row' ? pointer.clientY : pointer.clientX) - start) < 2) return;
      dispatch({ type: 'resize', sheetId: sheet.id, axis, ...target, size: sizeAt(pointer) });
      viewport.current?.focus();
    };
    const cancel = () => { cleanup(); };
    const escape = (keyEvent: KeyboardEvent) => { if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); keyEvent.stopPropagation(); cleanup(); } };
    resizeCleanup.current = cleanup;
    setResizePreview({ axis, ...target, size: initial, x: event.clientX, y: event.clientY });
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
  }
  function resizeKey(event: React.KeyboardEvent, axis: ResizeAxis, index: number) {
    if (!sheet) return;
    const decrease = axis === 'row' ? 'ArrowUp' : 'ArrowLeft', increase = axis === 'row' ? 'ArrowDown' : 'ArrowRight';
    if (![decrease, increase, 'Enter'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Enter') { resizeDialog(axis, index); return; }
    const current = (axis === 'row' ? sheet.rowHeights : sheet.columnWidths)[index] ?? (axis === 'row' ? ROW : COL);
    dispatch({ type: 'resize', sheetId: sheet.id, axis, ...resizeTarget(axis, index), size: Math.max(20, Math.min(1000, current + (event.key === decrease ? -1 : 1) * (event.shiftKey ? 10 : 1))) });
  }

  function commitEditing(nextRow?: number, nextCol?: number) {
    const edit = editRef.current;
    if (edit && sheet) {
      const old = sheet.cells[key(edit.row, edit.col)];
      if (edit.value !== rawCell(old)) dispatch({ type: 'cells', sheetId: sheet.id, changes: [{ row: edit.row, col: edit.col, cell: inputCell(edit.value, old) }] });
      setEditing(null); editRef.current = null;
    }
    if (nextRow !== undefined && nextCol !== undefined) jump(Math.max(0, Math.min((sheet?.rowCount ?? 100) - 1, nextRow)), Math.max(0, Math.min((sheet?.columnCount ?? 26) - 1, nextCol)));
  }
  function startEditing(value?: string) {
    if (!sheet) return;
    setEditing({ row: selection.r1, col: selection.c1, value: value ?? rawCell(activeCell), selectAll: value === undefined });
  }
  function commitFormula() {
    if (formulaCancelled.current) { formulaCancelled.current = false; return; }
    const current = bookRef.current?.sheets.find(s => s.id === activeSheetRef.current);
    if (!current || !formula.current) return;
    const old = current.cells[key(selection.r1, selection.c1)];
    const text = formula.current.value;
    if (text !== rawCell(old)) dispatch({ type: 'cells', sheetId: current.id, changes: [{ row: selection.r1, col: selection.c1, cell: inputCell(text, old) }] });
  }
  function setStyle(style: CellStyle) { commitEditing(); dispatch({ type: 'style', sheetId: currentSheetId, range, style }); }
  function sortRows(descending: boolean) {
    if (!sheet || !calc) return;
    const values: Record<number, Scalar> = {};
    for (const k of Object.keys(sheet.cells)) {
      const [r, c] = coordinates(k);
      if (c !== selection.c1) continue;
      const value = calc.evaluate(sheet.id, r, c);
      if (value.error && !value.cached) { announce('排序列存在无法计算的公式'); return; }
      values[r] = value.value;
    }
    dispatch({ type: 'sort', sheetId: sheet.id, column: selection.c1, descending, header: true, values });
  }
  function sheetName(base = 'Sheet') {
    let i = 1; while (workbook?.sheets.some(s => s.name === `${base}${i}`)) i++; return `${base}${i}`;
  }
  function newSheet() {
    const id = uid(); dispatch({ type: 'addSheet', id, name: sheetName() }); setSheetId(id); setSelection(selectionAt(0, 0));
  }
  function renameSheet() {
    if (!sheet) return;
    setDialog({ title: '重命名工作表', value: sheet.name, action: name => dispatch({ type: 'renameSheet', sheetId: sheet.id, name }) });
  }
  function changeSheet(id: string) {
    commitEditing(); setSheetId(id); setSelection(selectionAt(0, 0)); setFilterText(''); setEditing(null);
    if (viewport.current) { viewport.current.scrollTop = 0; viewport.current.scrollLeft = 0; }
  }
  function clearCells() {
    if (!sheet) return;
    const changes = Object.keys(sheet.cells).flatMap(address => {
      const [row, col] = coordinates(address);
      if (row < range.r1 || row > range.r2 || col < range.c1 || col > range.c2) return [];
      const old = sheet.cells[address]; return [{ row, col, cell: old.style ? { value: null, style: old.style } as Cell : null }];
    });
    if (changes.length) dispatch({ type: 'cells', sheetId: currentSheetId, changes, label: '清空单元格' });
  }
  const display = useCallback((row: number, col: number) => sheet && calc ? displayCell(sheet.cells[key(row, col)], calc.evaluate(sheet.id, row, col)) : '', [sheet, calc]);
  const used = useMemo(() => {
    let row = 0, col = 0;
    for (const k of Object.keys(sheet?.cells ?? {})) { const [r, c] = coordinates(k); row = Math.max(row, r); col = Math.max(col, c); }
    return { row, col };
  }, [sheet?.cells]);
  const visibleRowIds = useMemo(() => {
    if (!sheet || !filterText) return null;
    const byRow = new Map<number, string[]>();
    for (const k of Object.keys(sheet.cells)) {
      const [r, c] = coordinates(k);
      if (!r || (filterColumn >= 0 && c !== filterColumn)) continue;
      const values = byRow.get(r) ?? []; values.push(display(r, c)); byRow.set(r, values);
    }
    return [0, ...[...byRow].filter(([, values]) => values.some(v => v.toLocaleLowerCase().includes(filterText.toLocaleLowerCase()))).map(([r]) => r).sort((a, b) => a - b)];
  }, [sheet, filterText, filterColumn, display]);
  const rowCount = visibleRowIds?.length ?? sheet?.rowCount ?? 100;
  const rowHeights = useMemo(() => {
    if (resizePreview?.axis !== 'row') return sheet?.rowHeights ?? {};
    const sizes = { ...sheet?.rowHeights };
    for (let i = resizePreview.index; i < resizePreview.index + resizePreview.count; i++) sizes[i] = resizePreview.size;
    return sizes;
  }, [sheet?.rowHeights, resizePreview]);
  const columnWidths = useMemo(() => {
    if (resizePreview?.axis !== 'column') return sheet?.columnWidths ?? {};
    const sizes = { ...sheet?.columnWidths };
    for (let i = resizePreview.index; i < resizePreview.index + resizePreview.count; i++) sizes[i] = resizePreview.size;
    return sizes;
  }, [sheet?.columnWidths, resizePreview]);
  const ys = useMemo(() => offsets(rowCount, visibleRowIds ? Object.fromEntries(visibleRowIds.map((r, i) => [i, rowHeights[r] ?? ROW])) : rowHeights, ROW), [rowCount, rowHeights, visibleRowIds]);
  const xs = useMemo(() => offsets(sheet?.columnCount ?? 26, columnWidths, COL), [sheet?.columnCount, columnWidths]);
  const firstRow = Math.max(0, findOffset(ys, scroll.top) - 2);
  const lastRow = Math.min(rowCount - 1, findOffset(ys, scroll.top + scroll.height) + 3);
  const firstCol = Math.max(0, findOffset(xs, scroll.left) - 1);
  const lastCol = Math.min((sheet?.columnCount ?? 26) - 1, findOffset(xs, scroll.left + scroll.width) + 2);
  const frozenRows = Math.min(sheet?.frozenRows ?? 0, rowCount, 20);
  const frozenCols = Math.min(sheet?.frozenColumns ?? 0, sheet?.columnCount ?? 26, 10);
  const visibleMerges = filterText ? [] : (sheet?.merges ?? []).filter(m => m.r2 >= firstRow && m.r1 <= lastRow && m.c2 >= firstCol && m.c1 <= lastCol);
  const rowIndices = [...new Set([...Array.from({ length: frozenRows }, (_, i) => i), ...visibleMerges.map(m => m.r1), ...Array.from({ length: Math.max(0, lastRow - firstRow + 1) }, (_, i) => firstRow + i)])];
  const colIndices = [...new Set([...Array.from({ length: frozenCols }, (_, i) => i), ...visibleMerges.map(m => m.c1), ...Array.from({ length: Math.max(0, lastCol - firstCol + 1) }, (_, i) => firstCol + i)])];
  const searchPattern = useMemo(() => {
    if (!query) return { expression: null, error: '' };
    try { return { expression: new RegExp(whole ? `^(?:${regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$` : regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi'), error: '' }; }
    catch { return { expression: null, error: '正则表达式无效' }; }
  }, [query, regex, matchCase, whole]);
  const hits = useMemo(() => {
    const result: Hit[] = [];
    if (!workbook || !calc || !searchPattern.expression) return result;
    for (const s of workbook.sheets) {
      if (!allSheets && s.id !== currentSheetId) continue;
      for (const [address, cell] of Object.entries(s.cells)) {
        if (result.length >= 2000) break;
        const [row, col] = coordinates(address);
        const text = searchFormulas ? rawCell(cell) : displayCell(cell, calc.evaluate(s.id, row, col));
        searchPattern.expression.lastIndex = 0;
        if (searchPattern.expression.test(text)) result.push({ sheetId: s.id, row, col, text, address: `${allSheets ? s.name + '!' : ''}${cellAddress(row, col)}` });
      }
    }
    return result.sort((a, b) => workbook.sheets.findIndex(s => s.id === a.sheetId) - workbook.sheets.findIndex(s => s.id === b.sheetId) || a.row - b.row || a.col - b.col);
  }, [workbook, calc, searchPattern, allSheets, currentSheetId, searchFormulas]);
  function revealHit(index: number) {
    const hit = hits[(index + hits.length) % hits.length]; if (!hit) return;
    setHitIndex((index + hits.length) % hits.length); setSheetId(hit.sheetId); setFilterText('');
    setTimeout(() => jump(hit.row, hit.col), 20);
  }
  function replaceMatches(all: boolean) {
    if (!searchPattern.expression || !workbook) return;
    const targets = all ? hits : [hits[hitIndex]].filter(Boolean);
    const operations = new Map<string, { row: number; col: number; cell: Cell | null }[]>();
    for (const hit of targets) {
      const s = workbook.sheets.find(s => s.id === hit.sheetId)!;
      const cell = s.cells[key(hit.row, hit.col)];
      if (cell.formula && !searchFormulas) continue;
      const raw = rawCell(cell), next = raw.replace(searchPattern.expression, replacement);
      if (next === raw) continue;
      const changes = operations.get(s.id) ?? [];
      changes.push({ row: hit.row, col: hit.col, cell: inputCell(next, cell) }); operations.set(s.id, changes);
    }
    for (const [id, changes] of operations) dispatch({ type: 'cells', sheetId: id, changes, label: '查找替换' });
    announce(`已替换 ${[...operations.values()].reduce((n, values) => n + values.length, 0)} 个单元格${targets.some(h => workbook.sheets.find(s => s.id === h.sheetId)?.cells[key(h.row, h.col)]?.formula) && !searchFormulas ? '，公式结果已跳过；勾选“搜索公式”可替换公式文本' : ''}`);
  }
  function fill(direction: 'down' | 'right') {
    if (!sheet) return;
    if ((range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1) > 250000) { announce('选择区域过大'); return; }
    const changes = [];
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
      if (direction === 'down' ? r === range.r1 : c === range.c1) continue;
      const sr = direction === 'down' ? range.r1 : r, sc = direction === 'right' ? range.c1 : c;
      const source = sheet.cells[key(sr, sc)];
      changes.push({ row: r, col: c, cell: source ? { ...source, ...(source.formula ? { formula: translateFormula(source.formula, r - sr, c - sc), cached: undefined } : {}) } : null });
    }
    dispatch({ type: 'cells', sheetId: sheet.id, changes, label: direction === 'down' ? '向下填充' : '向右填充' });
  }
  function copy(event: React.ClipboardEvent, cut = false) {
    if (!sheet || editing || (event.target as HTMLElement).tagName === 'INPUT') return;
    if ((range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1) > 250000) { announce('复制区域过大'); return; }
    const cells: (Cell | null)[][] = [], values: string[][] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const row: (Cell | null)[] = [], text: string[] = [];
      for (let c = range.c1; c <= range.c2; c++) { row.push(sheet.cells[key(r, c)] ?? null); text.push(display(r, c)); }
      cells.push(row); values.push(text);
    }
    const text = Papa.unparse(values, { delimiter: '\t', newline: '\n' });
    copied.current = { cells, text, range, sheetId: sheet.id };
    event.clipboardData.setData('text/plain', text);
    event.clipboardData.setData('application/x-sheet-studio', JSON.stringify({ cells, range, sheetId: sheet.id, cut }));
    event.preventDefault(); if (cut) { clearCells(); copied.current = null; }
    else announce(`已复制 ${cells.length} 行 × ${cells[0]?.length ?? 0} 列`);
  }
  function paste(event: React.ClipboardEvent) {
    if (!sheet || editing || (event.target as HTMLElement).tagName === 'INPUT') return;
    const text = event.clipboardData.getData('text/plain');
    let internal = copied.current?.text === text ? copied.current : null;
    try { const data = event.clipboardData.getData('application/x-sheet-studio'); if (data) internal = JSON.parse(data); } catch { /* external clipboard */ }
    if (!text && !internal) return;
    event.preventDefault();
    const rows = internal && !text ? [['']] : Papa.parse<string[]>(text, { delimiter: '\t', skipEmptyLines: false }).data;
    if (rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === '' && /\n$/.test(text)) rows.pop();
    const width = rows.reduce((n, row) => Math.max(n, row.length), 0);
    if (rows.length * width > 250000) { announce('单次粘贴最多 250,000 个单元格'); return; }
    const changes: { row: number; col: number; cell: Cell | null }[] = [];
    rows.forEach((values, r) => values.forEach((value, c) => {
      const row = range.r1 + r, col = range.c1 + c;
      if (row >= MAX_ROWS || col >= MAX_COLUMNS) return;
      const source = internal?.cells[r]?.[c];
      let cell: Cell | null;
      if (internal) cell = source ? { ...source, ...(source.formula ? { formula: internal.cut ? source.formula : translateFormula(source.formula, row - (internal.range.r1 + r), col - (internal.range.c1 + c)), cached: undefined } : {}) } : null;
      else cell = inputCell(value, sheet.cells[key(row, col)]);
      changes.push({ row, col, cell });
    }));
    dispatch({ type: 'cells', sheetId: sheet.id, changes, label: '粘贴单元格' });
    setSelection({ r1: range.r1, c1: range.c1, r2: Math.min(MAX_ROWS - 1, range.r1 + rows.length - 1), c2: Math.min(MAX_COLUMNS - 1, range.c1 + width - 1) });
  }
  function save() {
    commitEditing();
    if (document.activeElement === formula.current) { commitFormula(); formula.current?.blur(); }
    bridge.post({ type: 'save' });
  }
  function onKeyDown(event: React.KeyboardEvent) {
    if (resizeCleanup.current) { if (event.key === 'Escape') resizeCleanup.current(); return; }
    const command = event.ctrlKey || event.metaKey;
    const target = event.target as HTMLElement;
    const input = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    if (command && event.key.toLowerCase() === 's') { event.preventDefault(); save(); return; }
    if (command && ['f', 'h'].includes(event.key.toLowerCase())) {
      event.preventDefault(); setSearchOpen(true); setReplaceOpen(event.key.toLowerCase() === 'h');
      setTimeout(() => document.getElementById('search-query')?.focus(), 20); return;
    }
    if (input) return;
    if (event.key === 'Escape') { setSearchOpen(false); setMenu(null); return; }
    if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); bridge.post({ type: event.shiftKey ? 'redo' : 'undo' }); return; }
    if (command && event.key.toLowerCase() === 'y') { event.preventDefault(); bridge.post({ type: 'redo' }); return; }
    if (command && event.key.toLowerCase() === 'a') {
      event.preventDefault(); setSelection({ r1: 0, c1: 0, r2: used.row, c2: used.col }); return;
    }
    if (command && ['d', 'r'].includes(event.key.toLowerCase())) { event.preventDefault(); fill(event.key.toLowerCase() === 'd' ? 'down' : 'right'); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); clearCells(); return; }
    if (event.key === 'F2') { event.preventDefault(); startEditing(); return; }
    if (event.key === 'Process' || event.nativeEvent.keyCode === 229) { startEditing(''); return; }
    const directions: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, event.shiftKey ? -1 : 1], Enter: [event.shiftKey ? -1 : 1, 0], PageDown: [Math.max(1, Math.floor(scroll.height / ROW) - 2), 0], PageUp: [-Math.max(1, Math.floor(scroll.height / ROW) - 2), 0] };
    if (directions[event.key]) {
      event.preventDefault();
      const [dr, dc] = directions[event.key];
      const r = Math.max(0, Math.min((sheet?.rowCount ?? 100) - 1, (event.shiftKey && event.key.startsWith('Arrow') ? selection.r2 : selection.r1) + dr));
      const c = Math.max(0, Math.min((sheet?.columnCount ?? 26) - 1, (event.shiftKey && event.key.startsWith('Arrow') ? selection.c2 : selection.c1) + dc));
      if (event.shiftKey && event.key.startsWith('Arrow')) setSelection(s => ({ ...s, r2: r, c2: c })); else jump(r, c);
      return;
    }
    if (event.key === 'Home') { event.preventDefault(); jump(command ? 0 : selection.r1, 0); return; }
    if (event.key === 'End' && command) { event.preventDefault(); jump(used.row, used.col); return; }
    if (!command && !event.altKey && event.key.length === 1) { event.preventDefault(); startEditing(event.key); }
  }
  const statistics = useMemo(() => {
    let count = 0, numeric = 0, sum = 0;
    if (sheet && calc) for (const [address, cell] of Object.entries(sheet.cells)) {
      const [r, c] = coordinates(address);
      if (r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2 || (cell.value === null && !cell.formula)) continue;
      count++;
      const value = calc.evaluate(sheet.id, r, c).value;
      const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() && /^[-+]?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
      if (number !== null) { numeric++; sum += number; }
    }
    return { count, numeric, sum };
  }, [sheet, calc, range.r1, range.r2, range.c1, range.c2]);
  if (!workbook || !sheet) return <div className="app loading" style={appearanceStyle} data-theme={isDarkBackground(backgroundColor) ? 'dark' : 'light'}><Icon name="grid" size={36}/><p>正在读取工作簿…</p></div>;

  function tool(name: string, label: string, action: () => void, active = false, text?: string) {
    return <button className={`tool ${active ? 'active' : ''}`} title={label} aria-label={label} onMouseDown={e => e.preventDefault()} onClick={action}><Icon name={name}/>{text && <span>{text}</span>}</button>;
  }
  function structural(axis: 'row' | 'column', remove = false) {
    dispatch({ type: 'structure', sheetId: currentSheetId, axis, index: axis === 'row' ? range.r1 : range.c1, count: axis === 'row' ? range.r2 - range.r1 + 1 : range.c2 - range.c1 + 1, remove });
  }
  const menuAction = (label: string, icon: string, action: () => void, shortcut?: string, danger = false) =>
    <button className={danger ? 'danger' : ''} onClick={() => { action(); setMenu(null); }}><Icon name={icon}/><span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}</button>;
  const zoomStyle = { zoom: zoom / 100 } as React.CSSProperties;
  return <main className="app" style={appearanceStyle} data-theme={isDarkBackground(backgroundColor) ? 'dark' : 'light'} data-resizing={resizePreview?.axis} onKeyDown={onKeyDown} onCopy={e => copy(e)} onCut={e => copy(e, true)} onPaste={paste}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Icon name="grid" size={21}/></span><span>Sheet Studio</span><span className="brand-divider"/><span className="filename">{workbook.name}</span><span className="format-badge">{workbook.format.toUpperCase()}</span></div>
      <div className="header-actions"><button className="search-trigger" onClick={() => { setSearchOpen(s => !s); setTimeout(() => document.getElementById('search-query')?.focus(), 30); }}><Icon name="search"/><span>搜索表格</span><kbd>Ctrl F</kbd></button>
        <button className="subtle icon-button" title="打开表格" aria-label="打开表格" onClick={() => bridge.post({ type: 'open' })}><Icon name="folder"/></button>
        <button className="save-button" onClick={save}><Icon name="save" size={16}/><span>保存</span></button>
        <button className="export-button" onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 190, y: r.bottom + 5, kind: 'export' }); }}>导出<Icon name="chevron" size={14}/></button>
      </div>
    </header>
    <nav className="ribbon-tabs"><div className="ribbon-nav">{['开始', '数据', '视图'].map(t => <button key={t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>{t}</button>)}</div><span className={`save-state ${saved ? '' : 'modified'}`}><span/>{saved ? '已保存到本地' : '有未保存的更改'}{isPreview && <span className="preview-label"> · 界面预览</span>}</span></nav>
    <section className="ribbon" aria-label="表格工具栏">
      <div className="tool-group">{tool('undo', '撤销 (Ctrl+Z)', () => bridge.post({ type: 'undo' }))}{tool('redo', '重做 (Ctrl+Y)', () => bridge.post({ type: 'redo' }))}</div>
      {tab === '开始' && <>
        <div className="tool-group"><select className="format-select" title="数字格式" aria-label="数字格式" value={activeCell?.style?.numberFormat ?? ''} onChange={e => setStyle({ numberFormat: e.target.value })}><option value="">常规</option><option value="#,##0.00">数字 · 两位小数</option><option value="#,##0">整数 · 千分位</option><option value="0.00%">百分比</option><option value={'"¥"#,##0.00'}>人民币</option><option value={'"$"#,##0.00'}>美元</option><option value="@">文本</option><option value="yyyy-mm-dd">日期</option></select><select className="size-select" title="字号" aria-label="字号" value={activeCell?.style?.fontSize ?? 11} onChange={e => setStyle({ fontSize: Number(e.target.value) })}>{[9, 10, 11, 12, 14, 16, 18, 24, 32].map(s => <option key={s}>{s}</option>)}</select></div>
        <div className="tool-group">{tool('bold', '加粗', () => setStyle({ bold: !activeCell?.style?.bold }), activeCell?.style?.bold)}{tool('italic', '斜体', () => setStyle({ italic: !activeCell?.style?.italic }), activeCell?.style?.italic)}
          <label className="color-tool" title="文字颜色"><span className="text-color">A</span><span className="color-line" style={{ background: activeCell?.style?.color ?? '#385a49' }}/><input aria-label="文字颜色" type="color" value={activeCell?.style?.color ?? '#385a49'} onChange={e => setStyle({ color: e.target.value })}/></label>
          <label className="color-tool" title="填充颜色"><span className="fill-symbol">◩</span><span className="color-line" style={{ background: activeCell?.style?.background ?? '#dceddf' }}/><input aria-label="填充颜色" type="color" value={activeCell?.style?.background ?? '#dceddf'} onChange={e => setStyle({ background: e.target.value })}/></label>
        </div>
        <div className="tool-group">{tool('alignLeft', '左对齐', () => setStyle({ align: 'left' }), activeCell?.style?.align === 'left')}{tool('alignCenter', '居中', () => setStyle({ align: 'center' }), activeCell?.style?.align === 'center')}{tool('alignRight', '右对齐', () => setStyle({ align: 'right' }), activeCell?.style?.align === 'right')}{tool('wrap', '自动换行', () => setStyle({ wrap: !activeCell?.style?.wrap }), activeCell?.style?.wrap)}</div>
        <div className="tool-group" role="group" aria-label="垂直对齐">{tool('alignTop', '顶端对齐', () => setStyle({ verticalAlign: 'top' }), activeCell?.style?.verticalAlign === 'top')}{tool('alignMiddle', '垂直居中', () => setStyle({ verticalAlign: 'middle' }), activeCell?.style?.verticalAlign === 'middle')}{tool('alignBottom', '底端对齐', () => setStyle({ verticalAlign: 'bottom' }), (activeCell?.style?.verticalAlign ?? 'bottom') === 'bottom')}</div>
        <div className="tool-group">{tool('merge', '合并单元格', () => dispatch({ type: 'merge', sheetId: sheet.id, range }), false, '合并')}{tool('formula', '自动求和', () => {
          const c = selection.c1, r = selection.r1;
          if (!r) { announce('请选择数据下方的空单元格'); return; }
          let start = r - 1; while (start > 0 && sheet.cells[key(start - 1, c)] && typeof calc?.evaluate(sheet.id, start - 1, c).value === 'number') start--;
          dispatch({ type: 'cells', sheetId: sheet.id, changes: [{ row: r, col: c, cell: { value: null, formula: `SUM(${cellAddress(start, c)}:${cellAddress(r - 1, c)})`, style: activeCell?.style } }] });
        }, false, '求和')}</div>
        <div className="tool-group">{tool('filter', '筛选', () => setFilterOpen(v => !v), filterOpen, '筛选')}</div>
      </>}
      {tab === '数据' && <>
        <div className="tool-group">{tool('sort', '升序排序（保留首行）', () => sortRows(false), false, '升序')}{tool('sort', '降序排序（保留首行）', () => sortRows(true), false, '降序')}{tool('filter', '筛选', () => setFilterOpen(v => !v), filterOpen, '筛选')}</div>
        <div className="tool-group">{tool('plus', '插入行', () => structural('row'), false, '插入行')}{tool('plus', '插入列', () => structural('column'), false, '插入列')}{tool('trash', '删除行', () => structural('row', true), false, '删除行')}{tool('trash', '删除列', () => structural('column', true), false, '删除列')}</div>
        <div className="tool-group">{tool('arrowLeft', '向下填充 (Ctrl+D)', () => fill('down'), false, '向下填充')}{tool('arrowRight', '向右填充 (Ctrl+R)', () => fill('right'), false, '向右填充')}</div>
        <div className="tool-group">{tool('search', '工作区检索', () => bridge.post({ type: 'workspaceSearch' }), false, '检索工作区')}</div>
      </>}
      {tab === '视图' && <>
        <div className="tool-group"><button className="tool" onClick={() => resizeDialog('row')}>行高…</button><button className="tool" onClick={() => resizeDialog('column')}>列宽…</button></div>
        <div className="tool-group appearance-tools"><span>背景颜色</span><select className="background-select" aria-label="背景预设" value={BACKGROUND_PRESETS.some(p => p.color === backgroundColor) ? backgroundColor : 'custom'} onChange={e => changeBackground(e.target.value)}>{BACKGROUND_PRESETS.map(p => <option key={p.color} value={p.color}>{p.name}</option>)}<option value="custom" disabled>自定义</option></select><input className="background-picker" type="color" aria-label="背景颜色" title="选择编辑器背景颜色" value={backgroundColor} onChange={e => changeBackground(e.target.value)}/><input className="background-hex" aria-label="背景色值" title="输入 #RRGGBB，按 Enter 应用" maxLength={7} spellCheck={false} value={backgroundInput} onChange={e => setBackgroundInput(e.target.value)} onBlur={commitBackground} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitBackground(); } if (e.key === 'Escape') { e.stopPropagation(); setBackgroundInput(backgroundColor); } }}/><button className="tool" title="恢复默认白色背景" onClick={() => changeBackground(DEFAULT_BACKGROUND)}>重置</button></div>
        <div className="tool-group">{tool('freeze', '冻结首行', () => dispatch({ type: 'freeze', sheetId: sheet.id, rows: sheet.frozenRows ? 0 : 1, columns: sheet.frozenColumns }), !!sheet.frozenRows, '冻结首行')}{tool('freeze', '冻结首列', () => dispatch({ type: 'freeze', sheetId: sheet.id, rows: sheet.frozenRows, columns: sheet.frozenColumns ? 0 : 1 }), !!sheet.frozenColumns, '冻结首列')}</div>
        <div className="tool-group">{tool('formula', '显示公式', () => setShowFormulas(v => !v), showFormulas, '显示公式')}{tool('merge', '取消合并', () => dispatch({ type: 'merge', sheetId: sheet.id, range, unmerge: true }), false, '取消合并')}</div>
        <div className="tool-group"><button className="tool" onClick={() => setZoom(100)}>重置缩放</button><button className="tool" onClick={() => bridge.post({ type: 'new' })}><Icon name="plus"/>新建工作簿</button></div>
      </>}
    </section>
    {workbook.warnings.length > 0 && <div className="warning-banner"><span>兼容模式</span>{workbook.warnings[0]}</div>}
    {filterOpen && <div className="filter-bar"><Icon name="filter"/><span>筛选</span><select aria-label="筛选列" value={filterColumn} onChange={e => setFilterColumn(Number(e.target.value))}><option value={-1}>所有列</option>{Array.from({ length: Math.min(used.col + 1, 100) }, (_, c) => <option key={c} value={c}>{columnName(c)} · {display(0, c) || columnName(c)}</option>)}</select><input aria-label="筛选内容" placeholder="输入需要包含的内容…" value={filterText} onChange={e => setFilterText(e.target.value)}/><span className="muted">{filterText ? `${Math.max(0, rowCount - 1)} 行匹配` : '保留首行作为表头'}</span><button className="text-button" onClick={() => setFilterText('')}>清除</button><button className="icon-button" aria-label="关闭筛选" onClick={() => { setFilterOpen(false); setFilterText(''); }}><Icon name="close" size={14}/></button></div>}
    <div className="formula-bar"><input className="name-box" aria-label="单元格地址" value={addressText} onChange={e => setAddressText(e.target.value)} onKeyDown={e => {
      if (e.key !== 'Enter') return;
      e.stopPropagation(); const parts = e.currentTarget.value.split(':'), first = parseAddress(parts[0]), last = parts[1] ? parseAddress(parts[1]) : first;
      if (first && last) {
        if (last[0] >= sheet.rowCount || last[1] >= sheet.columnCount) dispatch({ type: 'cells', sheetId: sheet.id, changes: [{ row: last[0], col: last[1], cell: sheet.cells[key(last[0], last[1])] ?? null }] });
        jump(...first); setSelection({ r1: first[0], c1: first[1], r2: last[0], c2: last[1] });
      } else announce('请输入有效地址，例如 A1 或 A1:D20');
    }}/><span className="formula-divider"/><span className="fx">ƒx</span><input ref={formula} className="formula-input" aria-label="公式栏" placeholder="输入内容或公式，例如 =SUM(A1:A10)" value={formulaText} onChange={e => setFormulaText(e.target.value)} onBlur={commitFormula} onKeyDown={e => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); formula.current?.blur(); viewport.current?.focus(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); formulaCancelled.current = true; setFormulaText(rawCell(activeCell)); viewport.current?.focus(); }
    }}/><span className="formula-hint">{activeCell?.formula ? '公式' : typeof activeCell?.value === 'number' ? '数值' : '文本'}</span></div>
    <div className="workspace">
      <div className="grid-area" style={zoomStyle}>
        <div className="grid-viewport" ref={viewport} tabIndex={0} role="grid" aria-label={sheet.name} aria-rowcount={sheet.rowCount} aria-colcount={sheet.columnCount} onScroll={e => { const el = e.currentTarget; setScroll({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight }); }} onCompositionStart={() => { if (!editing) startEditing(''); }}>
          <div className="grid-canvas" style={{ width: xs[xs.length - 1] + GUTTER, height: ys[ys.length - 1] + HEADER }}>
            <div className="corner header-cell" style={{ top: scroll.top, left: scroll.left }} onPointerDown={() => setSelection({ r1: 0, c1: 0, r2: used.row, c2: used.col })}><span className="corner-triangle"/></div>
            {colIndices.map(c => <div key={`h${c}`} role="columnheader" aria-label={columnName(c)} className={`column-header header-cell ${c >= range.c1 && c <= range.c2 ? 'header-selected' : ''}`} style={{ top: scroll.top, left: GUTTER + xs[c] + (c < frozenCols ? scroll.left : 0), width: xs[c + 1] - xs[c], zIndex: c < frozenCols ? 16 : 12 }} onPointerDown={e => { if (e.button === 0) selectHeader('column', c, e.shiftKey); }} onContextMenu={e => { e.preventDefault(); if (c < range.c1 || c > range.c2) selectHeader('column', c, false); setMenu({ x: e.clientX, y: e.clientY, kind: 'cell' }); }}>{columnName(c)}<span className="column-resize" role="separator" tabIndex={0} aria-label={`调整 ${columnName(c)} 列列宽`} aria-orientation="vertical" aria-valuemin={20} aria-valuemax={1000} aria-valuenow={columnWidths[c] ?? COL} title="拖动调整列宽，双击自动适配；Enter 输入尺寸" onKeyDown={e => resizeKey(e, 'column', c)} onDoubleClick={e => {
              e.stopPropagation(); let length = 8; for (const address of Object.keys(sheet.cells)) { const [r, cc] = coordinates(address); if (cc === c) length = Math.max(length, [...display(r, c)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)); }
              dispatch({ type: 'resize', sheetId: sheet.id, axis: 'column', ...resizeTarget('column', c), size: Math.min(600, Math.max(60, length * 8 + 24)) });
            }} onPointerDown={e => startResize(e, 'column', c)}/></div>)}
            {rowIndices.map(visualRow => {
              const r = visibleRowIds?.[visualRow] ?? visualRow;
              const rowTop = HEADER + ys[visualRow] + (visualRow < frozenRows ? scroll.top : 0);
              const rowHeight = ys[visualRow + 1] - ys[visualRow];
              return <React.Fragment key={`r${r}`}>
                <div role="rowheader" aria-label={String(r + 1)} className={`row-header header-cell ${r >= range.r1 && r <= range.r2 ? 'header-selected' : ''}`} style={{ top: rowTop, left: scroll.left, height: rowHeight, zIndex: visualRow < frozenRows ? 15 : 11 }} onPointerDown={e => { if (e.button === 0) selectHeader('row', r, e.shiftKey); }} onContextMenu={e => { e.preventDefault(); if (r < range.r1 || r > range.r2) selectHeader('row', r, false); setMenu({ x: e.clientX, y: e.clientY, kind: 'cell' }); }}>{r + 1}<span className="row-resize" role="separator" tabIndex={0} aria-label={`调整第 ${r + 1} 行行高`} aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={1000} aria-valuenow={rowHeights[r] ?? ROW} title="拖动调整行高；Enter 输入尺寸" onPointerDown={e => startResize(e, 'row', r)} onKeyDown={e => resizeKey(e, 'row', r)}/></div>
                {colIndices.map(c => {
                  const cell = sheet.cells[key(r, c)];
                  const merge = !filterText ? sheet.merges.find(m => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) : undefined;
                  if (merge && (r !== merge.r1 || c !== merge.c1)) return null;
                  const selected = r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
                  const active = r === selection.r1 && c === selection.c1;
                  const evaluation = calc!.evaluate(sheet.id, r, c);
                  const value = showFormulas && cell?.formula ? '=' + cell.formula : displayCell(cell, evaluation);
                  const style: React.CSSProperties = {
                    left: GUTTER + xs[c] + (c < frozenCols ? scroll.left : 0), top: rowTop,
                    width: xs[Math.min(xs.length - 1, (merge?.c2 ?? c) + 1)] - xs[c],
                    height: ys[Math.min(ys.length - 1, (merge?.r2 ?? visualRow) + 1)] - ys[visualRow],
                    zIndex: visualRow < frozenRows || c < frozenCols ? active ? 9 : visualRow < frozenRows && c < frozenCols ? 7 : 6 : active ? 4 : 1,
                    backgroundColor: cell?.style?.background,
                    color: cell?.style?.color ?? backgroundText(cell?.style?.background),
                    fontWeight: cell?.style?.bold ? 600 : undefined, fontStyle: cell?.style?.italic ? 'italic' : undefined,
                    textDecoration: cell?.style?.underline ? 'underline' : undefined,
                    fontSize: cell?.style?.fontSize ? cell.style.fontSize * 96 / 72 : undefined,
                    textAlign: cell?.style?.align ?? (typeof evaluation.value === 'number' ? 'right' : 'left'),
                    justifyContent: cell?.style?.verticalAlign === 'top' ? 'flex-start' : cell?.style?.verticalAlign === 'middle' ? 'center' : 'flex-end',
                    whiteSpace: cell?.style?.wrap ? 'pre-wrap' : 'nowrap',
                  };
                  return <div key={c} role="gridcell" aria-label={`${cellAddress(r, c)}${value ? ' ' + value : ''}`} aria-selected={selected} data-address={cellAddress(r, c)} className={`cell ${selected ? 'selected-cell' : ''} ${active ? 'active-cell' : ''} ${evaluation.error && !evaluation.cached ? 'error-cell' : ''} ${visualRow === frozenRows - 1 && frozenRows ? 'freeze-bottom' : ''} ${c === frozenCols - 1 && frozenCols ? 'freeze-right' : ''}`} style={style} title={evaluation.cached ? `显示文件中的缓存值，本次未计算：${evaluation.error}\n${rawCell(cell)}` : cell?.formula ? `=${cell.formula}\n${value}` : value} onPointerDown={e => {
                    if (e.button !== 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
                    commitEditing(); e.preventDefault(); dragging.current = true;
                    setSelection(s => e.shiftKey ? { ...s, r2: r, c2: c } : selectionAt(r, c)); viewport.current?.focus();
                  }} onPointerEnter={() => { if (dragging.current) setSelection(s => ({ ...s, r2: r, c2: c })); }} onDoubleClick={() => { setSelection(selectionAt(r, c)); setEditing({ row: r, col: c, value: rawCell(cell), selectAll: true }); }} onContextMenu={e => {
                    e.preventDefault(); if (!selected) setSelection(selectionAt(r, c)); setMenu({ x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 350), kind: 'cell' });
                  }}>
                    {editing?.row === r && editing.col === c ? <input ref={editor} className="cell-editor" aria-label={`编辑 ${cellAddress(r, c)}`} value={editing.value} onChange={e => { const next = { ...editing, value: e.target.value }; editRef.current = next; setEditing(next); setFormulaText(e.target.value); }} onBlur={() => commitEditing()} onKeyDown={e => {
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); commitEditing(r + (e.key === 'Enter' ? e.shiftKey ? -1 : 1 : 0), c + (e.key === 'Tab' ? e.shiftKey ? -1 : 1 : 0)); }
                      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); editRef.current = null; viewport.current?.focus(); }
                    }}/> : <><span className="cell-value">{value}</span>{cell?.formula && <span className={`formula-marker ${evaluation.cached ? 'cached-marker' : ''}`}/>}</>}
                    {active && !editing && <span className="selection-handle"/>}
                  </div>;
                })}
              </React.Fragment>;
            })}
          </div>
        </div>
      </div>
      {searchOpen && <aside className="search-panel"><div className="panel-title"><span><Icon name="search"/>查找与替换</span><button className="icon-button" aria-label="关闭查找" onClick={() => setSearchOpen(false)}><Icon name="close"/></button></div><div className="search-fields"><div className="search-input-wrap"><input id="search-query" aria-label="查找内容" placeholder="查找内容…" value={query} onChange={e => { setQuery(e.target.value); setHitIndex(0); }} onKeyDown={e => { if (e.key === 'Enter') revealHit(hitIndex + (e.shiftKey ? -1 : 1)); }}/><button title="区分大小写" aria-label="区分大小写" className={matchCase ? 'enabled' : ''} onClick={() => setMatchCase(v => !v)}>Aa</button><button title="整个单元格匹配" aria-label="整个单元格匹配" className={whole ? 'enabled' : ''} onClick={() => setWhole(v => !v)}>ab</button><button title="正则表达式" aria-label="正则表达式" className={regex ? 'enabled' : ''} onClick={() => setRegex(v => !v)}>.*</button></div>
        <button className="replace-toggle text-button" onClick={() => setReplaceOpen(v => !v)}><Icon name="chevron" size={13}/>{replaceOpen ? '收起替换' : '展开替换'}</button>
        {replaceOpen && <><input className="replace-input" aria-label="替换为" placeholder="替换为…" value={replacement} onChange={e => setReplacement(e.target.value)}/><div className="replace-actions"><button onClick={() => replaceMatches(false)}>替换当前</button><button onClick={() => replaceMatches(true)}>全部替换</button></div></>}
        <label className="checkbox-label"><input type="checkbox" checked={allSheets} onChange={e => setAllSheets(e.target.checked)}/>搜索所有工作表</label><label className="checkbox-label"><input type="checkbox" checked={searchFormulas} onChange={e => setSearchFormulas(e.target.checked)}/>搜索原始内容与公式</label>
      </div><div className="search-result-heading"><span>{searchPattern.error || (query ? `${hits.length}${hits.length >= 2000 ? '+' : ''} 处匹配` : '输入内容开始查找')}</span><div><button className="icon-button" aria-label="上一处匹配" disabled={!hits.length} onClick={() => revealHit(hitIndex - 1)}><Icon name="arrowLeft" size={15}/></button><button className="icon-button" aria-label="下一处匹配" disabled={!hits.length} onClick={() => revealHit(hitIndex + 1)}><Icon name="arrowRight" size={15}/></button></div></div><div className="search-results">{hits.map((hit, index) => <button key={`${hit.sheetId}:${hit.address}`} className={`search-hit ${index === hitIndex ? 'current-hit' : ''}`} onClick={() => revealHit(index)}><span className="hit-address">{hit.address}</span><span className="hit-text">{hit.text}</span></button>)}{query && !hits.length && <div className="empty-search"><Icon name="search" size={28}/><p>没有找到匹配的单元格</p><span>尝试其他关键字或搜索所有工作表</span></div>}</div></aside>}
    </div>
    <footer className="sheet-footer"><div className="sheet-nav"><button className="icon-button" title="上一工作表" onClick={() => { const i = workbook.sheets.findIndex(s => s.id === sheet.id); if (i > 0) changeSheet(workbook.sheets[i - 1].id); }}><Icon name="arrowLeft" size={14}/></button><button className="icon-button" title="下一工作表" onClick={() => { const i = workbook.sheets.findIndex(s => s.id === sheet.id); if (i < workbook.sheets.length - 1) changeSheet(workbook.sheets[i + 1].id); }}><Icon name="arrowRight" size={14}/></button></div><div className="sheet-tabs">{workbook.sheets.map(s => <button key={s.id} className={`sheet-tab ${s.id === sheet.id ? 'active-sheet' : ''}`} title={s.hidden ? '隐藏的工作表（可在此查看）' : '双击重命名，右键更多操作'} onClick={() => changeSheet(s.id)} onDoubleClick={renameSheet} onContextMenu={e => { e.preventDefault(); setSheetId(s.id); setMenu({ x: e.clientX, y: e.clientY - 140, kind: 'sheet' }); }}><Icon name="grid" size={14}/>{s.name}{s.hidden && <span>（隐藏）</span>}</button>)}</div><button className="add-sheet icon-button" aria-label="新增工作表" title="新增工作表" disabled={!!workbook.text} onClick={newSheet}><Icon name="plus" size={17}/></button><span className="sheets-count">{workbook.sheets.length} 个工作表</span></footer>
    <div className="statusbar"><div className="status-left"><span className="status-dot"/><span>{filterText ? '筛选中' : '就绪'}</span><span className="status-separator"/><span>{used.row + 1} 行 × {used.col + 1} 列</span>{workbook.text && <><span className="status-separator"/><span>{workbook.text.encoding.toUpperCase()} · {workbook.text.delimiter === '\t' ? 'Tab 分隔' : `${workbook.text.delimiter} 分隔`}</span></>}</div><div className="status-right">{statistics.count > 1 && <div className="selection-stats"><span>计数 <b>{statistics.count}</b></span>{statistics.numeric > 0 && <><span>平均值 <b>{(statistics.sum / statistics.numeric).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b></span><span>求和 <b>{statistics.sum.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b></span></>}</div>}<span className="zoom-controls"><button onClick={() => setZoom(z => Math.max(60, z - 10))}>−</button><input aria-label="缩放" type="range" min={60} max={160} step={10} value={zoom} onChange={e => setZoom(Number(e.target.value))}/><button onClick={() => setZoom(z => Math.min(160, z + 10))}>+</button><span>{zoom}%</span></span></div></div>
    {notice && <div className="toast" role="status"><Icon name="check" size={16}/>{notice}<button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><Icon name="close" size={14}/></button></div>}
    {resizePreview && <div className="resize-tooltip" role="status" style={{ left: Math.max(8, Math.min(resizePreview.x + 16, window.innerWidth - 180)), top: Math.max(8, Math.min(resizePreview.y + 16, window.innerHeight - 42)) }}>{resizePreview.axis === 'row' ? '行高' : '列宽'} {resizePreview.size} px{resizePreview.count > 1 && ` · ${resizePreview.count} ${resizePreview.axis === 'row' ? '行' : '列'}`}</div>}
    {menu && <div className="context-menu" style={{ left: Math.max(4, Math.min(menu.x, window.innerWidth - 242)), top: Math.max(4, Math.min(menu.y, window.innerHeight - 490)) }} onClick={e => e.stopPropagation()}>
      {menu.kind === 'export' ? <>
        {menuAction('Excel 工作簿 (.xlsx)', 'grid', () => { commitEditing(); bridge.post({ type: 'export', format: 'xlsx', sheetId: sheet.id }); })}
        {menuAction('当前工作表 (.csv)', 'download', () => { commitEditing(); bridge.post({ type: 'export', format: 'csv', sheetId: sheet.id }); })}
        {menuAction('当前工作表 (.tsv)', 'download', () => { commitEditing(); bridge.post({ type: 'export', format: 'tsv', sheetId: sheet.id }); })}
      </> : menu.kind === 'sheet' ? <>
        {menuAction('重命名', 'grid', renameSheet)}{menuAction('复制工作表', 'copy', () => dispatch({ type: 'duplicateSheet', sheetId: sheet.id, id: uid(), name: sheetName('副本') }))}
        <div className="menu-divider"/>{menuAction('删除工作表', 'trash', () => setDialog({ title: `输入“${sheet.name}”以删除此工作表`, value: '', action: value => { if (value === sheet.name) dispatch({ type: 'deleteSheet', sheetId: sheet.id }); else announce('名称不匹配，未删除工作表'); } }), undefined, true)}
      </> : <>
        {menuAction('编辑单元格', 'grid', () => startEditing(), 'F2')}
        {menuAction('向下填充', 'arrowLeft', () => fill('down'), 'Ctrl D')}{menuAction('向右填充', 'arrowRight', () => fill('right'), 'Ctrl R')}
        <div className="menu-divider"/>
        {menuAction('行高…', 'grid', () => resizeDialog('row'))}{menuAction('列宽…', 'grid', () => resizeDialog('column'))}
        {menuAction('在上方插入行', 'plus', () => structural('row'))}{menuAction('在左侧插入列', 'plus', () => structural('column'))}
        {menuAction('升序排序（保留首行）', 'sort', () => sortRows(false))}
        {menuAction('降序排序（保留首行）', 'sort', () => sortRows(true))}
        <div className="menu-divider"/>{menuAction('取消合并', 'merge', () => dispatch({ type: 'merge', sheetId: sheet.id, range, unmerge: true }))}
        {menuAction('清空内容', 'trash', clearCells, 'Delete')}{menuAction('删除所选行', 'trash', () => structural('row', true), undefined, true)}{menuAction('删除所选列', 'trash', () => structural('column', true), undefined, true)}
      </>}
    </div>}
    {dialog && <div className="dialog-overlay" onClick={() => setDialog(null)}><form className="dialog" role="dialog" aria-modal="true" aria-label={dialog.title} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); setDialog(null); viewport.current?.focus(); } }} onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); dialog.action(dialog.value); setDialog(null); viewport.current?.focus(); }}><h3>{dialog.title}</h3>{dialog.hint && <p className="dialog-hint">{dialog.hint}</p>}<input aria-label={dialog.title} type={dialog.numeric ? 'number' : 'text'} min={dialog.numeric ? 20 : undefined} max={dialog.numeric ? 1000 : undefined} step={dialog.numeric ? 'any' : undefined} required={dialog.numeric} autoFocus value={dialog.value} onFocus={e => e.target.select()} onChange={e => setDialog({ ...dialog, value: e.target.value })}/><div><button type="button" onClick={() => setDialog(null)}>取消</button><button className="save-button" type="submit">确定</button></div></form></div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
