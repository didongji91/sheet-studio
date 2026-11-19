import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import { format } from 'sql-formatter';
import { appearanceVariables, BACKGROUND_PRESETS, isDarkBackground, normalizeBackground } from '../src/appearance';
import {
  DATABASE_LABELS,
  DEFAULT_PORTS,
  type ConnectionProfile,
  type DatabaseState,
  type DbObject,
  type DbValue,
  type QueryResult,
  type RowChange,
  type SqlHistory,
  type TableDetail,
  type TablePage,
} from '../src/database/types';
import { dbBridge } from './db-bridge';
import { Icon } from './icons';
import { SqlEditor, type SqlEditorHandle } from './sql-editor';

const textValue = (value: DbValue | undefined) =>
  value === null ? 'NULL' : value === undefined ? '' : typeof value === 'object' ? '0x' + value.hex : String(value);
const objectKey = (object?: DbObject) => (object ? object.schema + '\0' + object.name : '');
type Pending = Record<number, RowChange>;
function DatabaseApp() {
  const remembered = useRef(dbBridge.state() ?? {});
  const [state, setState] = useState<DatabaseState | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [objectsQuery, setObjectsQuery] = useState('');
  const [selected, setSelected] = useState<DbObject>();
  const [page, setPage] = useState<TablePage>();
  const [detail, setDetail] = useState<TableDetail>();
  const [tab, setTab] = useState<'data' | 'structure' | 'sql'>('data');
  const [sqlText, setSqlText] = useState<string>(
    remembered.current.sql ?? '-- 输入 SQL，按 Ctrl+Enter 执行；选中部分文本可仅执行选中内容。\n',
  );
  const sqlEditor = useRef<SqlEditorHandle>(null);
  const [results, setResults] = useState<QueryResult[]>([]);
  const [resultIndex, setResultIndex] = useState(0);
  const [history, setHistory] = useState<SqlHistory[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [filterColumn, setFilterColumn] = useState('');
  const [filterOperator, setFilterOperator] = useState('contains');
  const [sort, setSort] = useState({ column: '', descending: false });
  const [limit, setLimit] = useState(100);
  const [pending, setPending] = useState<Pending>({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const [background, setBackground] = useState(normalizeBackground(remembered.current.background));
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [connection, setConnection] = useState<{ profile: ConnectionProfile; password: string }>();
  const [cellDialog, setCellDialog] = useState<{
    row: number;
    col: number;
    mode: 'text' | 'number' | 'null' | 'blob';
    text: string;
  }>();
  const [insertDialog, setInsertDialog] = useState<Record<string, { enabled: boolean; text: string; null: boolean }>>();
  const [confirm, setConfirm] = useState<{ title: string; message: string; action: () => void }>();
  const [sizes, setSizes] = useState<Record<string, number>>(remembered.current.sizes ?? {});
  const [rowHeight, setRowHeight] = useState(Math.max(24, Math.min(120, remembered.current.rowHeight || 32)));
  const [gridScroll, setGridScroll] = useState({ top: 0, left: 0, height: 500, width: 1000 });
  const grid = useRef<HTMLDivElement>(null),
    refreshRef = useRef<(next?: DatabaseState) => void>(() => {});
  const operationRef = useRef(0);
  const busyCount = useRef(0);
  const [sidebarWidth, setSidebarWidth] = useState(remembered.current.sidebarWidth ?? 240);
  const [editorHeight, setEditorHeight] = useState(remembered.current.editorHeight ?? 260);
  const style = useMemo(
    () =>
      ({
        ...appearanceVariables(background),
        colorScheme: isDarkBackground(background) ? 'dark' : 'light',
      }) as React.CSSProperties,
    [background],
  );
  const run = useCallback(async <T,>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
    busyCount.current++;
    setBusy(label);
    setError('');
    try {
      return await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      if (--busyCount.current === 0) setBusy('');
    }
  }, []);
  const initialize = (data: any) => {
    setState(data.state);
    setProfiles(data.profiles ?? []);
    setHistory(data.history ?? []);
    if (data.backgroundColor) setBackground(normalizeBackground(data.backgroundColor));
  };
  useEffect(() => {
    const dispose = dbBridge.subscribe((message) => {
      if (message.type === 'dbAppearance') setBackground(normalizeBackground(message.backgroundColor));
      if (message.type === 'dbState') {
        setState(message.state);
        if (message.changed) {
          if (Object.keys(pendingRef.current).length) setStale(true);
          else refreshRef.current(message.state);
        }
      }
    });
    void run('正在打开数据库…', async () => {
      const data = await dbBridge.request('ready');
      initialize(data);
      const objects: DbObject[] = data.state.objects;
      setSelected(objects.find((o) => objectKey(o) === remembered.current.selected) ?? objects[0]);
    });
    return dispose;
  }, []);
  useEffect(() => {
    dbBridge.remember({
      sql: sqlText,
      selected: objectKey(selected),
      background,
      sizes,
      rowHeight,
      sidebarWidth,
      editorHeight,
    });
  }, [sqlText, selected, background, sizes, rowHeight, sidebarWidth, editorHeight]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(''), 4500);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  useEffect(() => {
    const target = grid.current;
    if (!target) return;
    const observer = new ResizeObserver(() =>
      setGridScroll((s) => ({ ...s, height: target.clientHeight, width: target.clientWidth })),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [tab, !!page, !!results.length]);
  const loadPage = async (object = selected, offset = 0) => {
    if (!object || !state?.connected) return;
    const operation = ++operationRef.current;
    const data = await dbBridge.request<TablePage>('page', {
      object,
      options: {
        offset,
        limit,
        search: filter,
        filterColumn,
        filterOperator,
        sortColumn: sort.column,
        descending: sort.descending,
      },
    });
    if (operation !== operationRef.current) return;
    setPage(data);
    setDetail(data.detail);
    setPending({});
    setChecked(new Set());
    setStale(false);
    setActive({ row: 0, col: 0 });
    if (grid.current) grid.current.scrollTop = 0;
  };
  refreshRef.current = (next = state ?? undefined) => {
    if (!next?.connected) return;
    if (selected && next.objects.some((object) => objectKey(object) === objectKey(selected)))
      void run('刷新数据…', () => loadPage(selected, page?.offset ?? 0));
    else {
      setSelected(next.objects[0]);
      setPage(undefined);
      setDetail(undefined);
    }
  };
  useEffect(() => {
    if (selected && state?.connected) void run('读取表数据…', () => loadPage(selected));
  }, [objectKey(selected), !!state?.connected, limit, sort.column, sort.descending]);
  const protect = (action: () => void) => {
    if (Object.keys(pending).length)
      setConfirm({
        title: '放弃待提交的修改？',
        message: '当前网格有待提交的记录。继续后会放弃这些网格修改。',
        action,
      });
    else action();
  };
  const chooseObject = (object: DbObject) => {
    if (objectKey(object) === objectKey(selected)) {
      setTab('data');
      if (!page && !busyCount.current) void run('读取表数据…', () => loadPage(object));
      return;
    }
    protect(() => {
      ++operationRef.current;
      setSelected(object);
      setPending({});
      setChecked(new Set());
      setFilter('');
      setFilterColumn('');
      setSort({ column: '', descending: false });
      setTab('data');
      setPage(undefined);
      setDetail(undefined);
      setStale(false);
    });
  };
  const selectTab = (next: typeof tab) => {
    if (next === 'sql' && !sqlText.trim().replace(/^--[^\n]*\n?/, '')) setSqlText(selectSql());
    setTab(next);
  };
  const quoted = (name: string) =>
    state?.kind === 'mysql' || state?.kind === 'mariadb'
      ? '`' + name.replaceAll('`', '``') + '`'
      : state?.kind === 'mssql'
        ? '[' + name.replaceAll(']', ']]') + ']'
        : '"' + name.replaceAll('"', '""') + '"';
  const selectSql = () => {
    if (!selected) return 'SELECT 1 AS result;';
    const name = (selected.schema ? quoted(selected.schema) + '.' : '') + quoted(selected.name);
    return state?.kind === 'mssql' ? `SELECT TOP (500) *\nFROM ${name};` : `SELECT *\nFROM ${name}\nLIMIT 500;`;
  };
  const execute = () => {
    if (busyCount.current || !state?.connected) return;
    void run('正在执行 SQL…', async () => {
      const sql = sqlEditor.current?.selected() ?? sqlText;
      const data = await dbBridge.request<{ results: QueryResult[]; history: SqlHistory[] }>('execute', {
        sql,
        limit: 1000,
      });
      setResults(data.results);
      setResultIndex(0);
      setHistory(data.history);
      setTab('sql');
      setNotice(`执行完成 · ${data.results.reduce((n, r) => n + r.affectedRows, 0)} 行受影响`);
    });
  };
  const saveFile = () => {
    if (busyCount.current) return;
    if (Object.keys(pendingRef.current).length) {
      setError('当前还有待提交的网格修改，请先点击“应用修改”，再保存数据库。');
      return;
    }
    void run('保存数据库…', () => dbBridge.request('save'));
  };
  const stageValue = (row: number, col: number, value: DbValue) => {
    if (
      !page?.rows[row] ||
      col < 0 ||
      col >= page.columns.length ||
      !page.detail.identityColumns.length ||
      page.detail.object.type !== 'table' ||
      page.detail.columns[col].generated
    )
      return;
    setPending((current) => ({
      ...current,
      [row]: {
        type: 'update',
        identity: page.identities[row],
        original: page.rows[row],
        values: { ...current[row]?.values, [page.columns[col]]: value },
      },
    }));
  };
  const shownValue = (row: number, col: number): DbValue => {
    const values = pending[row]?.values,
      name = page?.columns[col] ?? '';
    return values && Object.prototype.hasOwnProperty.call(values, name)
      ? values[name]
      : (page?.rows[row]?.[col] ?? null);
  };
  const editCell = (row: number, col: number) => {
    if (busyCount.current || !page?.rows[row] || col < 0 || col >= page.columns.length) return;
    if (!page.detail.identityColumns.length || page.detail.object.type !== 'table') {
      setNotice('此结果只读：编辑需要基础表及主键（SQLite 表可使用 rowid）。');
      return;
    }
    if (page.detail.columns[col].generated || pending[row]?.type === 'delete') return;
    const value = shownValue(row, col);
    setCellDialog({
      row,
      col,
      mode:
        value === null ? 'null' : typeof value === 'object' ? 'blob' : typeof value === 'number' ? 'number' : 'text',
      text: value === null ? '' : typeof value === 'object' ? value.hex : String(value),
    });
  };
  const applyPending = () =>
    void run('提交记录修改…', async () => {
      const changes = Object.values(pending);
      const response = await dbBridge.request('changes', { object: selected, changes });
      setPending({});
      setStale(false);
      await loadPage(selected, page?.offset ?? 0);
      setNotice(
        `已应用 ${response.affectedRows} 行修改${state?.local ? '，按 Ctrl+S 保存文件' : state?.transaction ? '，等待提交事务' : ''}`,
      );
    });
  const deleteRows = () => {
    if (!page || !checked.size) return;
    setConfirm({
      title: `标记删除 ${checked.size} 行？`,
      message: '记录会先标记为待删除，点击“应用修改”后执行。',
      action: () => {
        setPending((current) => {
          const next = { ...current };
          for (const row of checked)
            next[row] = { type: 'delete', identity: page.identities[row], original: page.rows[row] };
          return next;
        });
        setChecked(new Set());
      },
    });
  };
  const refresh = () =>
    protect(
      () =>
        void run('刷新数据库…', async () => {
          const next = await dbBridge.request<DatabaseState>('refresh');
          setState(next);
          if (selected && next.objects.some((o) => objectKey(o) === objectKey(selected)))
            await loadPage(selected, page?.offset ?? 0);
          else {
            setSelected(next.objects[0]);
            setPage(undefined);
          }
        }),
    );
  const newConnection = (profile?: ConnectionProfile) =>
    setConnection({
      profile: profile ?? {
        id: crypto.randomUUID(),
        name: '',
        kind: 'postgres',
        host: 'localhost',
        port: 5432,
        database: '',
        username: '',
        ssl: 'off',
      },
      password: '',
    });
  const connect = (id: string) => {
    const action = () =>
      void run('正在连接数据库…', async () => {
        const data = await dbBridge.request('connect', { id });
        initialize(data);
        setProfileId(id);
        setSelected(data.state.objects[0]);
        setPage(undefined);
        setPending({});
        setResults([]);
      });
    if (state?.transaction)
      setConfirm({
        title: '切换连接并回滚事务？',
        message: '当前连接存在未提交事务。切换连接会回滚事务，并放弃尚未应用的网格修改。',
        action,
      });
    else protect(action);
  };
  const activeResult = tab === 'sql' ? results[resultIndex] : page;
  const canEdit = tab === 'data' && !!page?.detail.identityColumns.length && page.detail.object.type === 'table';
  const pendingCount = Object.keys(pending).length;
  const filteredObjects =
    state?.objects.filter((o) => (o.schema + '.' + o.name).toLowerCase().includes(objectsQuery.toLowerCase())) ?? [];
  const grouped = [...new Set(filteredObjects.map((o) => o.schema))];
  const columns = activeResult?.columns ?? [];
  const x = [46];
  columns.forEach((name, col) => x.push(x[col] + (sizes[name] ?? 170)));
  const firstRow = Math.max(0, Math.floor(Math.max(0, gridScroll.top - 34) / rowHeight) - 2);
  const lastRow = Math.min(
    activeResult?.rows.length ?? 0,
    Math.ceil((gridScroll.top + gridScroll.height) / rowHeight) + 3,
  );
  const visibleColumns = columns
    .map((_, i) => i)
    .filter((i) => x[i + 1] >= gridScroll.left && x[i] <= gridScroll.left + gridScroll.width + 180);
  const resizeRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => resizeRef.current?.(), []);
  const dragSize = (
    event: React.PointerEvent,
    initial: number,
    min: number,
    max: number,
    axis: 'x' | 'y',
    update: (value: number) => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current?.();
    const start = axis === 'x' ? event.clientX : event.clientY;
    const move = (pointer: PointerEvent) =>
      update(Math.min(max, Math.max(min, initial + (axis === 'x' ? pointer.clientX : pointer.clientY) - start)));
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      resizeRef.current = undefined;
    };
    resizeRef.current = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const exportResult = (format: string) => {
    if (activeResult)
      void run('导出查询结果…', async () => {
        await dbBridge.request('exportResults', { result: activeResult, format });
        setNotice('导出已完成');
      });
  };
  const cellNumber = (text: string): DbValue => {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) || !Number.isFinite(Number(text)))
      throw new Error('请输入有效数字。');
    const n = Number(text);
    return Number.isInteger(n) && !Number.isSafeInteger(n) ? text.trim() : n;
  };
  function gridCopy(event: React.ClipboardEvent) {
    if (!grid.current?.contains(event.target as Node) || !activeResult?.rows.length) return;
    const rows =
      tab === 'data' && checked.size
        ? [...checked]
            .sort((a, b) => a - b)
            .map((row) => page!.columns.map((_, col) => textValue(shownValue(row, col))))
        : [
            [
              textValue(
                tab === 'data' ? shownValue(active.row, active.col) : activeResult.rows[active.row]?.[active.col],
              ),
            ],
          ];
    event.preventDefault();
    event.clipboardData.setData('text/plain', Papa.unparse(rows, { delimiter: '\t', newline: '\n' }));
  }
  function gridPaste(event: React.ClipboardEvent) {
    if (!grid.current?.contains(event.target as Node) || busyCount.current || !canEdit || !page) return;
    event.preventDefault();
    const rows = Papa.parse<string[]>(event.clipboardData.getData('text/plain'), {
      delimiter: '\t',
      skipEmptyLines: false,
    }).data;
    if (rows.length * (rows[0]?.length ?? 0) > 10000) {
      setError('一次最多粘贴 10000 个单元格。');
      return;
    }
    rows.forEach((values, r) =>
      values.forEach((value, c) => {
        if (active.row + r < page.rows.length && active.col + c < page.columns.length)
          stageValue(active.row + r, active.col + c, value);
      }),
    );
  }
  if (!state)
    return (
      <main className="app loading" style={style}>
        <Icon name="database" size={34} />
        <span>{error || '正在打开数据库…'}</span>
      </main>
    );
  return (
    <main
      className="app database-app"
      style={style}
      data-theme={isDarkBackground(background) ? 'dark' : 'light'}
      onCopy={gridCopy}
      onPaste={gridPaste}
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 's' &&
          state.local &&
          !cellDialog &&
          !insertDialog
        ) {
          event.preventDefault();
          saveFile();
        }
      }}
    >
      <header className="db-topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="database" size={21} />
          </span>
          <span>Sheet Studio</span>
          <span className="brand-divider" />
          <span className="filename">{state.name}</span>
          <span className="format-badge">{DATABASE_LABELS[state.kind]}</span>
        </div>
        <div className="header-actions">
          <button className="export-button" onClick={() => void run('打开数据库…', () => dbBridge.request('openFile'))}>
            <Icon name="folder" size={15} />
            打开文件
          </button>
          <button
            className="icon-button"
            aria-label="外观设置"
            title="背景和网格尺寸"
            onClick={() => setAppearanceOpen((v) => !v)}
          >
            <Icon name="palette" />
          </button>
          {state.local ? (
            <>
              <button
                className="icon-button"
                aria-label="撤销数据库修改"
                disabled={!!busy}
                onClick={() => protect(() => void run('撤销…', () => dbBridge.request('undo')))}
              >
                <Icon name="undo" />
              </button>
              <button
                className="icon-button"
                aria-label="重做数据库修改"
                disabled={!!busy}
                onClick={() => protect(() => void run('重做…', () => dbBridge.request('redo')))}
              >
                <Icon name="redo" />
              </button>
              <button className="save-button" disabled={!!busy} onClick={saveFile}>
                <Icon name="save" size={15} />
                保存
              </button>
            </>
          ) : (
            state.connected && (
              <button
                className="export-button"
                onClick={() => {
                  const action = () =>
                    void run('断开连接…', async () => {
                      setState(await dbBridge.request('disconnect'));
                      setSelected(undefined);
                      setPage(undefined);
                      setResults([]);
                    });
                  if (state.transaction)
                    setConfirm({
                      title: '断开连接并回滚事务？',
                      message: '当前事务尚未提交。断开连接后，事务中的修改会回滚。',
                      action,
                    });
                  else protect(action);
                }}
              >
                断开连接
              </button>
            )
          )}
        </div>
      </header>
      {appearanceOpen && (
        <div className="db-appearance">
          <span>背景颜色</span>
          <select
            aria-label="数据库背景预设"
            value={BACKGROUND_PRESETS.some((p) => p.color === background) ? background : 'custom'}
            onChange={(e) => {
              setBackground(e.target.value);
              void dbBridge.request('appearance', { color: e.target.value }).catch((e) => setError(e.message));
            }}
          >
            {BACKGROUND_PRESETS.map((p) => (
              <option value={p.color} key={p.color}>
                {p.name}
              </option>
            ))}
            <option value="custom" disabled>
              自定义
            </option>
          </select>
          <input
            type="color"
            aria-label="数据库背景颜色"
            value={background}
            onChange={(e) => {
              setBackground(e.target.value);
              void dbBridge.request('appearance', { color: e.target.value }).catch((e) => setError(e.message));
            }}
          />
          <label>
            行高{' '}
            <input
              type="number"
              aria-label="数据库网格行高"
              min={24}
              max={120}
              value={rowHeight}
              onChange={(e) => setRowHeight(Math.max(24, Math.min(120, Number(e.target.value) || 32)))}
            />
            px
          </label>
          <span className="muted">拖动列标题边缘调整列宽</span>
          <button className="icon-button" aria-label="关闭外观设置" onClick={() => setAppearanceOpen(false)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <div className="db-body">
        <aside className="db-sidebar" style={{ width: sidebarWidth }}>
          <div className="db-sidebar-heading">
            <span>数据库导航</span>
            <button
              className="icon-button"
              aria-label="新建连接"
              onClick={() => (state.local ? void dbBridge.request('openManager') : newConnection())}
            >
              <Icon name="plus" size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="刷新对象"
              onClick={refresh}
              disabled={!state.connected || !!busy}
            >
              <Icon name="refresh" size={15} />
            </button>
          </div>
          {!state.local && (
            <div className="connection-selector">
              <select aria-label="选择数据库连接" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                <option value="">选择已保存的连接</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {DATABASE_LABELS[p.kind]}
                  </option>
                ))}
              </select>
              <button className="db-primary-small" disabled={!profileId || !!busy} onClick={() => connect(profileId)}>
                连接
              </button>
              <button
                className="icon-button"
                aria-label="编辑连接"
                disabled={!profileId}
                onClick={() => newConnection(profiles.find((p) => p.id === profileId))}
              >
                <Icon name="settings" size={15} />
              </button>
            </div>
          )}
          <div className="db-source">
            <Icon name="database" size={16} />
            <span>{state.local ? state.name : state.connected ? `${state.name}` : '尚未连接'}</span>
            <span className={`db-indicator ${state.connected ? 'connected' : ''}`} />
          </div>
          <div className="db-object-search">
            <Icon name="search" size={14} />
            <input
              aria-label="检索表和视图"
              placeholder="检索表、视图…"
              value={objectsQuery}
              onChange={(e) => setObjectsQuery(e.target.value)}
            />
          </div>
          <div className="db-object-list">
            {grouped.map((schema) => (
              <section key={schema}>
                <h3>
                  <Icon name="chevron" size={12} />
                  {schema || '数据库'}
                </h3>
                {(['table', 'view'] as const).map((type) => {
                  const objects = filteredObjects.filter((o) => o.schema === schema && o.type === type);
                  return objects.length ? (
                    <div key={type}>
                      <div className="db-object-group">
                        {type === 'table' ? '表' : '视图'}
                        <span>{objects.length}</span>
                      </div>
                      {objects.map((object) => (
                        <button
                          key={objectKey(object)}
                          className={`db-object ${objectKey(selected) === objectKey(object) ? 'current-object' : ''}`}
                          title={object.schema + '.' + object.name}
                          onClick={() => chooseObject(object)}
                          onDoubleClick={() => {
                            setSqlText(
                              state.kind === 'mssql'
                                ? `SELECT TOP (500) * FROM ${quoted(object.schema)}.${quoted(object.name)};`
                                : `SELECT * FROM ${quoted(object.schema)}.${quoted(object.name)} LIMIT 500;`,
                            );
                            setTab('sql');
                          }}
                        >
                          <Icon name={type === 'view' ? 'view' : 'grid'} size={15} />
                          <span>{object.name}</span>
                        </button>
                      ))}
                    </div>
                  ) : null;
                })}
              </section>
            ))}
            {!filteredObjects.length && (
              <div className="db-empty-navigation">
                {state.connected ? '没有匹配的表或视图' : '添加连接以浏览服务器数据库'}
              </div>
            )}
          </div>
          <div className="db-sidebar-bottom">
            <button onClick={() => void dbBridge.request('createFile')}>
              <Icon name="plus" size={14} />
              新建 SQLite 文件
            </button>
            {state.local && (
              <button onClick={() => void dbBridge.request('openManager')}>
                <Icon name="plug" size={14} />
                服务器连接管理
              </button>
            )}
          </div>
        </aside>
        <div
          className="db-divider"
          role="separator"
          aria-label="调整数据库导航宽度"
          onPointerDown={(e) => dragSize(e, sidebarWidth, 180, 460, 'x', setSidebarWidth)}
        />
        <section className="db-main">
          <nav className="db-tabs">
            <div className="db-object-title">
              <Icon name={selected?.type === 'view' ? 'view' : 'grid'} size={15} />
              {selected ? `${selected.schema}.${selected.name}` : '工作台'}
            </div>
            <button className={tab === 'data' ? 'selected' : ''} onClick={() => selectTab('data')}>
              数据
            </button>
            <button className={tab === 'structure' ? 'selected' : ''} onClick={() => selectTab('structure')}>
              结构
            </button>
            <button className={tab === 'sql' ? 'selected' : ''} onClick={() => selectTab('sql')}>
              SQL 编辑器
            </button>
            <span className="db-transaction-state">
              {state.local
                ? state.dirty
                  ? '文件有未保存的修改'
                  : '文件已保存'
                : state.transaction
                  ? '事务待提交'
                  : state.connected
                    ? '自动提交'
                    : '未连接'}
            </span>
          </nav>
          {!state.connected ? (
            <div className="db-welcome">
              <span className="db-welcome-icon">
                <Icon name="database" size={36} />
              </span>
              <h1>连接数据，开始查询</h1>
              <p>浏览表结构、编辑记录、执行 SQL，让数据库工作留在 VS Code。</p>
              <div className="engine-badges">
                {['PostgreSQL', 'MySQL', 'MariaDB', 'SQL Server', 'SQLite'].map((name) => (
                  <span key={name}>{name}</span>
                ))}
              </div>
              <div>
                <button className="save-button" onClick={() => newConnection()}>
                  <Icon name="plus" size={16} />
                  新建数据库连接
                </button>
                <button className="export-button" onClick={() => void dbBridge.request('openFile')}>
                  打开 SQLite 文件
                </button>
              </div>
              <span className="muted">服务器连接密码保存在 VS Code SecretStorage</span>
            </div>
          ) : tab === 'structure' ? (
            detail ? (
              <div className="db-structure">
                <div className="db-section-heading">
                  <h2>
                    字段 <span>{detail.columns.length}</span>
                  </h2>
                  <button
                    className="tool"
                    onClick={() => {
                      setSqlText(detail.ddl);
                      setTab('sql');
                    }}
                  >
                    DDL 发送到编辑器
                  </button>
                  <button
                    className="tool"
                    onClick={() => void navigator.clipboard.writeText(detail.ddl).then(() => setNotice('已复制 DDL'))}
                  >
                    <Icon name="copy" size={14} />
                    复制 DDL
                  </button>
                </div>
                <table className="metadata-table">
                  <thead>
                    <tr>
                      <th>字段名</th>
                      <th>数据类型</th>
                      <th>主键</th>
                      <th>非空</th>
                      <th>默认值 / 生成</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.columns.map((c) => (
                      <tr key={c.name}>
                        <td className="db-mono">
                          {c.primaryKey ? '⌑ ' : ''}
                          {c.name}
                        </td>
                        <td className="db-type">{c.type}</td>
                        <td>{c.primaryKey || '—'}</td>
                        <td>{c.notNull ? '是' : '否'}</td>
                        <td className="db-mono">{c.generated ? '数据库自动生成' : (c.defaultValue ?? '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h2>
                  索引 <span>{detail.indexes.length}</span>
                </h2>
                {detail.indexes.length ? (
                  <table className="metadata-table">
                    <thead>
                      <tr>
                        <th>名称</th>
                        <th>唯一</th>
                        <th>字段 / 定义</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.indexes.map((i) => (
                        <tr key={i.name}>
                          <td className="db-mono">{i.name}</td>
                          <td>{i.unique ? '是' : '否'}</td>
                          <td className="db-mono">{i.columns.join(', ') || i.definition}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted">没有索引</p>
                )}
                <h2>
                  外键 <span>{detail.foreignKeys.length}</span>
                </h2>
                {detail.foreignKeys.length ? (
                  <table className="metadata-table">
                    <thead>
                      <tr>
                        <th>名称</th>
                        <th>当前列</th>
                        <th>引用表</th>
                        <th>引用列</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.foreignKeys.map((f, i) => (
                        <tr key={i}>
                          <td>{f.name}</td>
                          <td>{f.column}</td>
                          <td>{f.target}</td>
                          <td>{f.targetColumn}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted">没有外键</p>
                )}
                <h2>DDL</h2>
                <pre className="db-ddl">{detail.ddl}</pre>
              </div>
            ) : (
              <div className="db-empty-content">选择左侧表或视图以查看结构</div>
            )
          ) : (
            <>
              {tab === 'sql' && (
                <>
                  <div className="sql-toolbar">
                    <button className="save-button" disabled={!!busy} onClick={execute}>
                      <Icon name="play" size={15} />
                      执行 SQL<kbd>Ctrl ↵</kbd>
                    </button>
                    <button
                      className="tool"
                      disabled={!busy}
                      onClick={() => void dbBridge.request('cancel').catch((e) => setError(e.message))}
                    >
                      <Icon name="stop" size={13} />
                      取消
                    </button>
                    <span className="tool-divider" />
                    <button
                      className="tool"
                      onClick={() => {
                        try {
                          setSqlText(
                            format(sqlText, {
                              language:
                                state.kind === 'postgres'
                                  ? 'postgresql'
                                  : state.kind === 'mssql'
                                    ? 'transactsql'
                                    : state.kind,
                              keywordCase: 'upper',
                            }),
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      格式化
                    </button>
                    <button className="tool" onClick={() => setSqlText(selectSql())}>
                      SELECT 模板
                    </button>
                    <button className="tool" onClick={() => setHistoryOpen((v) => !v)}>
                      <Icon name="history" size={14} />
                      历史 {history.length}
                    </button>
                    {!state.local && (
                      <div className="db-transaction-tools">
                        <button
                          disabled={state.transaction || !!busy}
                          onClick={() =>
                            void run('开启事务…', async () =>
                              setState(await dbBridge.request('transaction', { command: 'begin' })),
                            )
                          }
                        >
                          开启事务
                        </button>
                        <button
                          disabled={!state.transaction || !!busy}
                          onClick={() =>
                            void run('提交事务…', async () => {
                              setState(await dbBridge.request('transaction', { command: 'commit' }));
                              setNotice('事务已提交');
                            })
                          }
                        >
                          提交
                        </button>
                        <button
                          disabled={!state.transaction || !!busy}
                          onClick={() =>
                            setConfirm({
                              title: '回滚当前事务？',
                              message: '本事务中尚未提交的修改将撤销。',
                              action: () =>
                                void run('回滚事务…', async () => {
                                  setState(await dbBridge.request('transaction', { command: 'rollback' }));
                                  await loadPage();
                                }),
                            })
                          }
                        >
                          回滚
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="sql-editor-layout" style={{ height: editorHeight }}>
                    <SqlEditor
                      ref={sqlEditor}
                      value={sqlText}
                      kind={state.kind}
                      objects={state.objects}
                      detail={detail}
                      onChange={setSqlText}
                      onRun={execute}
                    />
                    {historyOpen && (
                      <aside className="sql-history">
                        <h3>
                          SQL 执行历史
                          <button
                            className="icon-button"
                            aria-label="关闭 SQL 历史"
                            onClick={() => setHistoryOpen(false)}
                          >
                            <Icon name="close" size={13} />
                          </button>
                        </h3>
                        {history.map((h, i) => (
                          <button
                            key={i}
                            className={h.success ? '' : 'failed-history'}
                            title={h.sql}
                            onClick={() => {
                              setSqlText(h.sql);
                              sqlEditor.current?.focus();
                            }}
                          >
                            <span>
                              {h.success ? '✓' : '×'} {new Date(h.time).toLocaleTimeString()} ·{' '}
                              {Math.round(h.elapsedMs)} ms
                            </span>
                            <code>{h.sql}</code>
                          </button>
                        ))}
                        {!history.length && <p className="muted">执行的 SQL 会记录在这里</p>}
                      </aside>
                    )}
                  </div>
                  <div
                    className="db-horizontal-divider"
                    role="separator"
                    aria-label="调整 SQL 编辑器高度"
                    onPointerDown={(e) =>
                      dragSize(e, editorHeight, 120, Math.max(160, window.innerHeight - 320), 'y', setEditorHeight)
                    }
                  />
                  <div className="result-tabs">
                    {results.length ? (
                      results.map((r, i) => (
                        <button
                          key={i}
                          className={i === resultIndex ? 'active-result' : ''}
                          onClick={() => {
                            setResultIndex(i);
                            setActive({ row: 0, col: 0 });
                          }}
                        >
                          结果 {i + 1}
                          <span>
                            {r.columns.length
                              ? `${r.rows.length} 行${r.truncated ? '+' : ''}`
                              : `${r.affectedRows} 行受影响`}
                          </span>
                        </button>
                      ))
                    ) : (
                      <span>查询结果</span>
                    )}
                    <span className="muted result-hint">
                      {state.local
                        ? '修改在内存中执行，Ctrl+S 保存到文件'
                        : state.transaction
                          ? '当前在手动事务中'
                          : 'SQL 写入会自动提交；需要回滚时请先开启事务'}
                    </span>
                  </div>
                </>
              )}
              {tab === 'data' && (
                <>
                  <div className="db-data-toolbar">
                    <button className="tool" disabled={!page || !!busy} onClick={refresh}>
                      <Icon name="refresh" size={15} />
                      刷新
                    </button>
                    <button
                      className="tool"
                      disabled={!page || selected?.type !== 'table' || !!busy}
                      onClick={() =>
                        protect(() => {
                          setPending({});
                          setStale(false);
                          setInsertDialog(
                            Object.fromEntries(
                              page!.detail.columns
                                .filter((c) => !c.generated)
                                .map((c) => [c.name, { enabled: false, text: '', null: false }]),
                            ),
                          );
                        })
                      }
                    >
                      <Icon name="plus" size={15} />
                      新增行
                    </button>
                    <button
                      className="tool db-danger"
                      disabled={!canEdit || !checked.size || !!busy}
                      onClick={deleteRows}
                    >
                      <Icon name="trash" size={14} />
                      删除所选
                    </button>
                    <span className="tool-divider" />
                    <button className="db-primary-small" disabled={!pendingCount || !!busy} onClick={applyPending}>
                      应用修改{pendingCount ? ` (${pendingCount})` : ''}
                    </button>
                    <button
                      className="tool"
                      disabled={!pendingCount}
                      onClick={() => {
                        setPending({});
                        setStale(false);
                      }}
                    >
                      撤回待提交
                    </button>
                    <span className="db-toolbar-spacer" />
                    <button
                      className="tool"
                      disabled={!page || selected?.type !== 'table' || !!busy}
                      onClick={() =>
                        protect(
                          () =>
                            void run('导入 CSV…', async () => {
                              const response = await dbBridge.request('importCsv', { object: selected });
                              if (response) {
                                await loadPage();
                                setNotice(`已导入 ${response.affectedRows} 行${state.local ? '，请保存文件' : ''}`);
                              }
                            }),
                        )
                      }
                    >
                      导入 CSV
                    </button>
                  </div>
                  <form
                    className="db-filter-bar"
                    onSubmit={(event) => {
                      event.preventDefault();
                      protect(() => void run('筛选数据…', () => loadPage(selected)));
                    }}
                  >
                    <Icon name="filter" size={14} />
                    <select
                      aria-label="数据库筛选列"
                      value={filterColumn}
                      onChange={(e) => setFilterColumn(e.target.value)}
                    >
                      <option value="">所有文本列</option>
                      {page?.columns.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                    <select
                      aria-label="数据库筛选方式"
                      value={filterOperator}
                      onChange={(e) => setFilterOperator(e.target.value)}
                    >
                      <option value="contains">包含</option>
                      <option value="equals">等于</option>
                      <option value="isNull">IS NULL</option>
                      <option value="notNull">IS NOT NULL</option>
                    </select>
                    <input
                      aria-label="数据库筛选内容"
                      placeholder="输入内容，按 Enter 筛选…"
                      value={filter}
                      disabled={filterOperator === 'isNull' || filterOperator === 'notNull'}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                    <button type="submit" className="db-primary-small" disabled={!selected || !!busy}>
                      筛选
                    </button>
                    <span className="muted">双击编辑 · Ctrl+C / V</span>
                  </form>
                </>
              )}
              {stale && (
                <div className="db-stale">数据库已变化；请先撤回待提交记录并刷新，或应用修改以检查记录冲突。</div>
              )}
              <div className="db-result-toolbar">
                <span>
                  {tab === 'sql'
                    ? activeResult
                      ? `${activeResult.rows.length}${activeResult.truncated ? '+' : ''} 行 · ${Math.round(activeResult.elapsedMs)} ms${activeResult.affectedRows ? ` · ${activeResult.affectedRows} 行受影响` : ''}`
                      : '执行 SQL 后显示结果'
                    : page
                      ? `共 ${page.total.toLocaleString()} 行 · ${canEdit ? '可编辑' : '只读'}${pendingCount ? ' · 待提交 ' + pendingCount + ' 行' : ''}`
                      : '选择表以浏览数据'}
                </span>
                <div>
                  <span className="muted">导出{tab === 'data' ? '当前页' : '当前结果'}</span>
                  {['csv', 'json', 'xlsx'].map((f) => (
                    <button key={f} disabled={!activeResult || !!busy} onClick={() => exportResult(f)}>
                      {f.toUpperCase()}
                    </button>
                  ))}
                  {state.local && (
                    <select
                      aria-label="导出数据库"
                      value=""
                      onChange={(e) => {
                        const format = e.target.value;
                        if (format) void run('导出数据库…', () => dbBridge.request('exportDatabase', { format }));
                      }}
                    >
                      <option value="">数据库副本 / SQL…</option>
                      <option value="db">SQLite 副本</option>
                      <option value="sql">完整 SQL 脚本</option>
                    </select>
                  )}
                </div>
              </div>
              <div
                className="db-grid"
                ref={grid}
                tabIndex={0}
                role="grid"
                aria-label={tab === 'sql' ? 'SQL 查询结果' : selected ? `${selected.name} 数据` : '数据库数据'}
                aria-rowcount={activeResult?.rows.length ?? 0}
                aria-colcount={columns.length}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  setGridScroll({
                    top: el.scrollTop,
                    left: el.scrollLeft,
                    height: el.clientHeight,
                    width: el.clientWidth,
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'F2' && tab === 'data') {
                    e.preventDefault();
                    editCell(active.row, active.col);
                  }
                  if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
                    e.preventDefault();
                    setActive((a) => ({
                      row: Math.max(
                        0,
                        Math.min(
                          (activeResult?.rows.length ?? 1) - 1,
                          a.row + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0),
                        ),
                      ),
                      col: Math.max(
                        0,
                        Math.min(
                          columns.length - 1,
                          a.col + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0),
                        ),
                      ),
                    }));
                  }
                }}
              >
                <div
                  className="db-grid-canvas"
                  style={{
                    minWidth: '100%',
                    width: x[x.length - 1],
                    height: Math.max(100, 34 + (activeResult?.rows.length ?? 0) * rowHeight),
                  }}
                >
                  <div className="db-grid-corner" style={{ top: gridScroll.top, left: gridScroll.left }}>
                    {tab === 'data' && canEdit ? (
                      <input
                        type="checkbox"
                        aria-label="选择当前页全部记录"
                        checked={!!page?.rows.length && checked.size === page.rows.length}
                        onChange={(e) =>
                          setChecked(e.target.checked ? new Set(page!.rows.map((_, i) => i)) : new Set())
                        }
                      />
                    ) : (
                      '#'
                    )}
                  </div>
                  {visibleColumns.map((c) => (
                    <div
                      key={'h' + c}
                      className="db-grid-header"
                      role="columnheader"
                      aria-label={columns[c]}
                      title={
                        tab === 'data' ? `${columns[c]} · ${page?.detail.columns[c]?.type} · 点击排序` : columns[c]
                      }
                      style={{ left: x[c], width: x[c + 1] - x[c], top: gridScroll.top }}
                      onClick={() => {
                        if (tab === 'data')
                          protect(() =>
                            setSort((s) => ({
                              column: columns[c],
                              descending: s.column === columns[c] ? !s.descending : false,
                            })),
                          );
                      }}
                    >
                      <span>
                        {tab === 'data' && page?.detail.columns[c]?.primaryKey ? (
                          <Icon name="key" size={12} />
                        ) : (
                          <span className="db-column-type">
                            {tab === 'data' ? page?.detail.columns[c]?.type.slice(0, 3) : 'col'}
                          </span>
                        )}
                        {columns[c]}
                      </span>
                      {sort.column === columns[c] && tab === 'data' && <span>{sort.descending ? '↓' : '↑'}</span>}
                      <span
                        className="db-column-resize"
                        role="separator"
                        aria-label={`调整 ${columns[c]} 列宽`}
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) =>
                          dragSize(e, x[c + 1] - x[c], 60, 800, 'x', (value) =>
                            setSizes((s) => ({ ...s, [columns[c]]: value })),
                          )
                        }
                      />
                    </div>
                  ))}
                  {Array.from({ length: Math.max(0, lastRow - firstRow) }, (_, i) => firstRow + i).map((r) => (
                    <React.Fragment key={r}>
                      <div
                        className={`db-grid-row-number ${checked.has(r) ? 'checked-row-number' : ''}`}
                        style={{ top: 34 + r * rowHeight, left: gridScroll.left, height: rowHeight }}
                      >
                        {tab === 'data' && canEdit ? (
                          <input
                            type="checkbox"
                            aria-label={`选择第 ${r + 1} 条记录`}
                            checked={checked.has(r)}
                            onChange={(e) =>
                              setChecked((current) => {
                                const next = new Set(current);
                                if (e.target.checked) next.add(r);
                                else next.delete(r);
                                return next;
                              })
                            }
                          />
                        ) : (
                          r + 1
                        )}
                      </div>
                      {visibleColumns.map((c) => {
                        const value = tab === 'data' ? shownValue(r, c) : activeResult!.rows[r][c],
                          changed =
                            tab === 'data' &&
                            !!pending[r]?.values &&
                            Object.prototype.hasOwnProperty.call(pending[r].values, columns[c]);
                        return (
                          <div
                            key={c}
                            role="gridcell"
                            aria-label={`第 ${r + 1} 行 ${columns[c]} ${textValue(value)}`}
                            aria-selected={active.row === r && active.col === c}
                            className={`db-grid-cell ${value === null ? 'db-null' : typeof value === 'number' ? 'db-numeric' : typeof value === 'object' ? 'db-blob' : ''} ${active.row === r && active.col === c ? 'db-active-cell' : ''} ${changed ? 'db-changed-cell' : ''} ${tab === 'data' && pending[r]?.type === 'delete' ? 'db-deleted-row' : ''} ${checked.has(r) && tab === 'data' ? 'db-checked-cell' : ''}`}
                            style={{ left: x[c], top: 34 + r * rowHeight, width: x[c + 1] - x[c], height: rowHeight }}
                            title={textValue(value)}
                            onClick={() => {
                              setActive({ row: r, col: c });
                              grid.current?.focus();
                            }}
                            onDoubleClick={() => {
                              if (tab === 'data') editCell(r, c);
                            }}
                          >
                            <span>
                              {typeof value === 'object' && value !== null
                                ? `BLOB · ${value.hex.length / 2} bytes`
                                : textValue(value)}
                            </span>
                            {changed && <span className="db-edit-dot" />}
                          </div>
                        );
                      })}
                    </React.Fragment>
                  ))}
                  {!activeResult?.rows.length && (
                    <div
                      className="db-no-rows"
                      style={{ left: gridScroll.left, top: gridScroll.top + 70, width: gridScroll.width }}
                    >
                      <Icon name={tab === 'sql' ? 'terminal' : 'grid'} size={27} />
                      <span>
                        {busy ||
                          (activeResult
                            ? columns.length
                              ? '没有匹配的记录'
                              : `执行成功，${activeResult.affectedRows} 行受影响`
                            : tab === 'sql'
                              ? '编写 SQL 并执行，结果将显示在这里'
                              : '从左侧选择一个表或视图')}
                      </span>
                      {!selected && state.connected && (
                        <button
                          className="text-button"
                          onClick={() => {
                            setTab('sql');
                            setSqlText('CREATE TABLE example (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n);');
                          }}
                        >
                          在 SQL 编辑器中新建表
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {tab === 'data' && (
                <div className="db-pagination">
                  <span>
                    {page && page.total
                      ? `${page.offset + 1}–${Math.min(page.offset + page.rows.length, page.total)} / ${page.total.toLocaleString()}`
                      : '0 条记录'}
                  </span>
                  <label>
                    每页{' '}
                    <select
                      aria-label="数据库每页行数"
                      value={limit}
                      onChange={(e) => protect(() => setLimit(Number(e.target.value)))}
                    >
                      {[50, 100, 200, 500, 1000].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>{' '}
                    行
                  </label>
                  <button
                    className="icon-button"
                    aria-label="数据库上一页"
                    disabled={!page?.offset || !!busy}
                    onClick={() =>
                      protect(() => void run('上一页…', () => loadPage(selected, Math.max(0, page!.offset - limit))))
                    }
                  >
                    <Icon name="arrowLeft" size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="数据库下一页"
                    disabled={!page || page.offset + page.rows.length >= page.total || !!busy}
                    onClick={() => protect(() => void run('下一页…', () => loadPage(selected, page!.offset + limit)))}
                  >
                    <Icon name="arrowRight" size={15} />
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      {error && (
        <div className="db-error" role="alert">
          <Icon name="warning" size={16} />
          <span>{error}</span>
          <button className="icon-button" aria-label="关闭数据库错误" onClick={() => setError('')}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <footer className="db-status">
        <span className={`db-indicator ${state.connected ? 'connected' : ''}`} />
        <span>{busy || '就绪'}</span>
        <span className="status-separator" />
        <span>{DATABASE_LABELS[state.kind]}</span>
        <span>{state.local ? '本地文件' : state.connected ? '服务器连接' : '未连接'}</span>
        <span className="db-toolbar-spacer" />
        {state.local && <span>Ctrl+S 保存 · 自动保留 .sheet-studio.bak 副本</span>}
        {dbBridge.preview && <span>· 本地演示数据库</span>}
      </footer>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={15} />
          {notice}
          <button className="icon-button" aria-label="关闭数据库提示" onClick={() => setNotice('')}>
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
      {cellDialog && (
        <div className="dialog-overlay">
          <form
            className="dialog db-cell-dialog"
            role="dialog"
            aria-label="编辑数据库单元格"
            aria-modal="true"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCellDialog(undefined);
            }}
            onSubmit={(e) => {
              e.preventDefault();
              try {
                let value: DbValue = cellDialog.text;
                if (cellDialog.mode === 'null') value = null;
                if (cellDialog.mode === 'number') value = cellNumber(cellDialog.text);
                if (cellDialog.mode === 'blob') {
                  if (!/^(?:[\da-f]{2})*$/i.test(cellDialog.text)) throw new Error('BLOB 请填写偶数位十六进制。');
                  value = { type: 'blob', hex: cellDialog.text.toLowerCase() };
                }
                stageValue(cellDialog.row, cellDialog.col, value);
                setCellDialog(undefined);
              } catch (error) {
                setError((error as Error).message);
              }
            }}
          >
            <h3>
              编辑 {page!.columns[cellDialog.col]}
              <span>第 {cellDialog.row + 1 + (page?.offset ?? 0)} 行</span>
            </h3>
            <label className="db-field">
              值类型
              <select
                aria-label="数据库单元格值类型"
                value={cellDialog.mode}
                onChange={(e) => setCellDialog({ ...cellDialog, mode: e.target.value as any })}
              >
                <option value="text">文本</option>
                <option value="number">数值（保留长整数精度）</option>
                <option value="null">NULL</option>
                <option value="blob">BLOB 十六进制</option>
              </select>
            </label>
            <textarea
              autoFocus
              aria-label="数据库单元格内容"
              disabled={cellDialog.mode === 'null'}
              value={cellDialog.text}
              onChange={(e) => setCellDialog({ ...cellDialog, text: e.target.value })}
            />
            <p className="dialog-hint">
              先加入待提交记录，再点击“应用修改”。{state.local && '应用后按 Ctrl+S 写入文件。'}
            </p>
            <div>
              <button type="button" onClick={() => setCellDialog(undefined)}>
                取消
              </button>
              <button type="submit" className="save-button">
                加入修改
              </button>
            </div>
          </form>
        </div>
      )}
      {insertDialog && (
        <div className="dialog-overlay">
          <form
            className="dialog db-insert-dialog"
            role="dialog"
            aria-label="新增数据库记录"
            aria-modal="true"
            onSubmit={(event) => {
              event.preventDefault();
              const values: Record<string, DbValue> = {};
              for (const [name, field] of Object.entries(insertDialog))
                if (field.enabled) values[name] = field.null ? null : field.text;
              void run('新增记录…', async () => {
                const response = await dbBridge.request('changes', {
                  object: selected,
                  changes: [{ type: 'insert', values }],
                });
                setInsertDialog(undefined);
                await loadPage(selected, page?.offset ?? 0);
                setNotice(`已新增 ${response.affectedRows} 行${state.local ? '，请保存文件' : ''}`);
              });
            }}
          >
            <h3>新增 {selected?.name} 记录</h3>
            <p className="dialog-hint">勾选需要填写的字段，未勾选的字段使用数据库默认值。</p>
            <div className="db-insert-fields">
              {Object.entries(insertDialog).map(([name, field]) => (
                <div key={name} className="db-insert-field">
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`填写 ${name}`}
                      checked={field.enabled}
                      onChange={(e) =>
                        setInsertDialog({ ...insertDialog, [name]: { ...field, enabled: e.target.checked } })
                      }
                    />
                    <span>
                      {name}
                      <small>{page?.detail.columns.find((c) => c.name === name)?.type}</small>
                    </span>
                  </label>
                  <input
                    aria-label={`新增字段 ${name}`}
                    value={field.text}
                    disabled={!field.enabled || field.null}
                    onChange={(e) => setInsertDialog({ ...insertDialog, [name]: { ...field, text: e.target.value } })}
                  />
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`${name} 设为 NULL`}
                      checked={field.null}
                      disabled={!field.enabled}
                      onChange={(e) =>
                        setInsertDialog({ ...insertDialog, [name]: { ...field, null: e.target.checked } })
                      }
                    />
                    NULL
                  </label>
                </div>
              ))}
            </div>
            <div>
              <button type="button" onClick={() => setInsertDialog(undefined)}>
                取消
              </button>
              <button type="submit" className="save-button" disabled={!!busy}>
                插入记录
              </button>
            </div>
          </form>
        </div>
      )}
      {connection && (
        <div className="dialog-overlay">
          <form
            className="dialog db-connection-dialog"
            role="dialog"
            aria-label="数据库连接配置"
            aria-modal="true"
            onSubmit={(event) => {
              event.preventDefault();
              void run('保存连接配置…', async () => {
                setProfiles(await dbBridge.request('saveConnection', connection));
                setProfileId(connection.profile.id);
                setConnection(undefined);
                setNotice('连接配置已保存，点击“连接”打开数据库。');
              });
            }}
          >
            <h3>
              <Icon name="plug" size={17} />
              数据库连接
            </h3>
            <div className="db-connection-fields">
              <label className="db-field db-full">
                连接名称
                <input
                  aria-label="数据库连接名称"
                  required
                  value={connection.profile.name}
                  onChange={(e) =>
                    setConnection({ ...connection, profile: { ...connection.profile, name: e.target.value } })
                  }
                />
              </label>
              <label className="db-field db-full">
                数据库类型
                <select
                  aria-label="数据库类型"
                  value={connection.profile.kind}
                  onChange={(e) => {
                    const kind = e.target.value as ConnectionProfile['kind'];
                    setConnection({
                      ...connection,
                      profile: { ...connection.profile, kind, port: DEFAULT_PORTS[kind] },
                    });
                  }}
                >
                  {(['postgres', 'mysql', 'mariadb', 'mssql'] as const).map((kind) => (
                    <option key={kind} value={kind}>
                      {DATABASE_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="db-field">
                主机
                <input
                  aria-label="数据库主机"
                  required
                  value={connection.profile.host}
                  onChange={(e) =>
                    setConnection({ ...connection, profile: { ...connection.profile, host: e.target.value } })
                  }
                />
              </label>
              <label className="db-field">
                端口
                <input
                  aria-label="数据库端口"
                  type="number"
                  required
                  min={1}
                  max={65535}
                  value={connection.profile.port}
                  onChange={(e) =>
                    setConnection({ ...connection, profile: { ...connection.profile, port: Number(e.target.value) } })
                  }
                />
              </label>
              <label className="db-field db-full">
                数据库
                <input
                  aria-label="数据库名称"
                  required
                  value={connection.profile.database}
                  onChange={(e) =>
                    setConnection({ ...connection, profile: { ...connection.profile, database: e.target.value } })
                  }
                />
              </label>
              <label className="db-field">
                用户名
                <input
                  aria-label="数据库用户名"
                  required
                  autoComplete="off"
                  value={connection.profile.username}
                  onChange={(e) =>
                    setConnection({ ...connection, profile: { ...connection.profile, username: e.target.value } })
                  }
                />
              </label>
              <label className="db-field">
                密码
                <input
                  aria-label="数据库密码"
                  type="password"
                  autoComplete="new-password"
                  placeholder="留空沿用已保存密码"
                  value={connection.password}
                  onChange={(e) => setConnection({ ...connection, password: e.target.value })}
                />
              </label>
              <label className="db-field db-full">
                TLS 加密
                <select
                  aria-label="数据库 TLS"
                  value={connection.profile.ssl}
                  onChange={(e) =>
                    setConnection({ ...connection, profile: { ...connection.profile, ssl: e.target.value as any } })
                  }
                >
                  <option value="off">关闭 TLS</option>
                  <option value="verify">启用并校验证书</option>
                  <option value="insecure">启用，接受自签名证书</option>
                </select>
              </label>
            </div>
            <div className="db-connection-actions">
              {profiles.some((p) => p.id === connection.profile.id) && (
                <button
                  type="button"
                  className="db-danger"
                  onClick={() =>
                    setConfirm({
                      title: '删除此连接配置？',
                      message: '已保存的连接配置和密码将删除，不会删除服务器上的数据库。',
                      action: () =>
                        void run('删除连接配置…', async () => {
                          setProfiles(await dbBridge.request('deleteConnection', { id: connection.profile.id }));
                          setConnection(undefined);
                          setProfileId('');
                        }),
                    })
                  }
                >
                  删除连接
                </button>
              )}
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void run('测试数据库连接…', async () => {
                    await dbBridge.request('testConnection', connection);
                    setNotice('连接测试成功');
                  })
                }
              >
                测试连接
              </button>
              <button type="button" onClick={() => setConnection(undefined)}>
                取消
              </button>
              <button className="save-button" disabled={!!busy} type="submit">
                保存连接
              </button>
            </div>
          </form>
        </div>
      )}
      {confirm && (
        <div className="dialog-overlay db-confirm-overlay">
          <div className="dialog" role="dialog" aria-label={confirm.title} aria-modal="true">
            <h3>{confirm.title}</h3>
            <p className="db-confirm-message">{confirm.message}</p>
            <div>
              <button onClick={() => setConfirm(undefined)}>取消</button>
              <button
                className="save-button"
                onClick={() => {
                  confirm.action();
                  setConfirm(undefined);
                }}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<DatabaseApp />);
