import * as vscode from 'vscode';
import { randomUUID, randomBytes } from 'node:crypto';
import { basename, extname } from 'node:path';
import { deflateSync, inflateSync } from 'fflate';
import Papa from 'papaparse';
import { SqliteClient, type SqliteResponse } from './sqlite-client';
import { RemoteDriver } from './remote';
import { applyRowChanges, browse } from './service';
import { isSqliteFile } from './sqlite';
import { validateProfile, validateUserSql } from './sql';
import {
  SQLITE_EXTENSIONS,
  type ConnectionProfile,
  type DatabaseState,
  type DbDriver,
  type DbObject,
  type QueryResult,
  type SqlHistory,
} from './types';
import { normalizeBackground, validBackground } from '../appearance';
import { exportQueryResult } from './export';

export const databaseViewType = 'sheetStudio.database';
async function checkSidecars(uri: vscode.Uri) {
  for (const suffix of ['-wal', '-journal']) {
    const sidecar = uri.with({ path: uri.path + suffix });
    let size = 0;
    try {
      size = (await vscode.workspace.fs.stat(sidecar)).size;
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') throw error;
    }
    if (size > 0)
      throw new Error(
        `检测到 ${basename(uri.path)}${suffix}。请先用原数据库程序关闭连接并完成 checkpoint，再打开或保存此文件，避免遗漏日志中的数据。`,
      );
  }
}
class DatabaseDocument implements vscode.CustomDocument {
  readonly panels = new Set<vscode.WebviewPanel>();
  private disposal = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposal.event;
  queue: Promise<unknown> = Promise.resolve();
  revision = randomUUID();
  savedRevision = this.revision;
  objects: DbObject[] = [];
  constructor(
    readonly uri: vscode.Uri,
    readonly client: SqliteClient,
    public original: Uint8Array,
  ) {}
  get dirty() {
    return this.revision !== this.savedRevision;
  }
  dispose() {
    void this.client.close();
    this.disposal.fire();
    this.disposal.dispose();
    this.panels.clear();
  }
}
interface RemotePanel {
  panel: vscode.WebviewPanel;
  driver?: DbDriver;
  profile?: ConnectionProfile;
  transaction: boolean;
  queue: Promise<unknown>;
  objects: DbObject[];
  disposed?: boolean;
}
interface Request {
  id: string;
  action: string;
  args?: any;
}

export class DatabaseProvider implements vscode.CustomEditorProvider<DatabaseDocument>, vscode.Disposable {
  private changes = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DatabaseDocument>>();
  readonly onDidChangeCustomDocument = this.changes.event;
  private documents = new Map<string, DatabaseDocument>();
  private managers = new Set<RemotePanel>();
  constructor(private context: vscode.ExtensionContext) {}
  dispose() {
    for (const document of this.documents.values()) document.dispose();
    for (const session of this.managers) {
      session.disposed = true;
      void session.driver?.close();
    }
    this.changes.dispose();
  }
  private directory() {
    return vscode.Uri.joinPath(this.context.extensionUri, 'dist').fsPath;
  }
  private profiles() {
    return this.context.globalState.get<ConnectionProfile[]>('database.connections', []);
  }
  private history(key: string) {
    return this.context.workspaceState.get<SqlHistory[]>('database.history.' + key, []);
  }
  private async addHistory(key: string, sql: string, start: number, success: boolean, sets: QueryResult[] = []) {
    const item = {
      sql: sql.slice(0, 20000),
      time: new Date().toISOString(),
      elapsedMs: performance.now() - start,
      success,
      rows: sets.reduce((n, s) => n + s.rows.length + s.affectedRows, 0),
    };
    await this.context.workspaceState.update('database.history.' + key, [item, ...this.history(key)].slice(0, 80));
  }
  refreshAppearance() {
    const color = normalizeBackground(vscode.workspace.getConfiguration('sheetStudio').get('backgroundColor'));
    for (const document of this.documents.values())
      for (const panel of document.panels)
        void panel.webview.postMessage({ type: 'dbAppearance', backgroundColor: color });
    for (const session of this.managers)
      void session.panel.webview.postMessage({ type: 'dbAppearance', backgroundColor: color });
  }
  private html(panel: vscode.WebviewPanel) {
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      nonce = randomBytes(18).toString('hex');
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    panel.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource} data:; connect-src 'none';"><link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'database.css'))}"></head><body><div id="root"></div><script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'database.js'))}"></script></body></html>`;
  }
  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<DatabaseDocument> {
    await checkSidecars(uri);
    const max = vscode.workspace.getConfiguration('sheetStudio').get('databaseMaxFileSizeMB', 128) * 1024 * 1024;
    if ((await vscode.workspace.fs.stat(uri)).size > max)
      throw new Error('数据库超过文件模式大小限制，请调整 sheetStudio.databaseMaxFileSizeMB 或使用原生数据库工具。');
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (!isSqliteFile(bytes))
      throw new Error('此文件不是 SQLite 3 数据库或已加密。Access、DuckDB、Berkeley DB 等同名 .db 格式需要各自驱动。');
    let image = bytes,
      backup: any;
    if (openContext.backupId) {
      backup = JSON.parse(
        Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId))).toString('utf8'),
      );
      image = Buffer.from(backup.image, 'base64');
    }
    const document = new DatabaseDocument(
      uri,
      new SqliteClient(
        this.directory(),
        image,
        vscode.workspace.getConfiguration('sheetStudio').get('databaseQueryTimeoutSeconds', 30) * 1000,
      ),
      backup ? Buffer.from(backup.original, 'base64') : bytes,
    );
    if (backup) document.revision = randomUUID();
    document.objects = (await document.client.call<DbObject[]>('catalog')).result;
    this.documents.set(uri.toString(), document);
    document.onDidDispose(() => {
      if (this.documents.get(uri.toString()) === document) this.documents.delete(uri.toString());
    });
    return document;
  }
  private fileState(document: DatabaseDocument): DatabaseState {
    return {
      name: basename(document.uri.path),
      kind: 'sqlite',
      objects: document.objects,
      local: true,
      connected: true,
      dirty: document.dirty,
      transaction: false,
    };
  }
  private remoteState(session: RemotePanel): DatabaseState {
    return {
      name: session.profile?.name ?? '数据库管理器',
      kind: session.profile?.kind ?? 'postgres',
      objects: session.objects,
      connected: !!session.driver,
      local: false,
      dirty: false,
      transaction: session.transaction,
    };
  }
  private async broadcast(document: DatabaseDocument, changed = false) {
    document.objects = (await document.client.call<DbObject[]>('catalog')).result;
    for (const panel of document.panels)
      void panel.webview.postMessage({ type: 'dbState', state: this.fileState(document), changed });
  }
  private record(document: DatabaseDocument, response: SqliteResponse<unknown>, label: string) {
    if (!response.change) return;
    const before = deflateSync(response.change.before, { level: 1 }),
      after = deflateSync(response.change.after, { level: 1 });
    const beforeId = document.revision,
      afterId = randomUUID();
    document.revision = afterId;
    this.changes.fire({
      document,
      label,
      undo: async () => {
        await document.queue.catch(() => {});
        await document.client.call('restore', { bytes: inflateSync(before) });
        document.revision = beforeId;
        await this.broadcast(document, true);
      },
      redo: async () => {
        await document.queue.catch(() => {});
        await document.client.call('restore', { bytes: inflateSync(after) });
        document.revision = afterId;
        await this.broadcast(document, true);
      },
    });
  }
  async resolveCustomEditor(document: DatabaseDocument, panel: vscode.WebviewPanel) {
    this.html(panel);
    document.panels.add(panel);
    const listener = panel.webview.onDidReceiveMessage((request: Request) => {
      if (request.action === 'cancel') {
        void document.client.cancel().then(() => this.reply(panel, request, true));
        return;
      }
      if (['save', 'undo', 'redo'].includes(request.action)) {
        const command = request.action === 'save' ? 'workbench.action.files.save' : request.action;
        void vscode.commands.executeCommand(command).then(
          () => this.reply(panel, request, true),
          (error) => this.reply(panel, request, undefined, error),
        );
        return;
      }
      document.queue = document.queue
        .catch(() => {})
        .then(async () => {
          try {
            this.reply(panel, request, await this.handleFile(document, panel, request));
          } catch (error) {
            this.reply(panel, request, undefined, error);
          }
        });
    });
    panel.onDidDispose(() => {
      listener.dispose();
      document.panels.delete(panel);
    });
  }
  private reply(panel: vscode.WebviewPanel, request: Request, data?: unknown, error?: unknown) {
    void panel.webview.postMessage({
      type: 'dbResponse',
      id: request.id,
      data,
      error: error ? (error instanceof Error ? error.message : String(error)) : undefined,
    });
  }
  private async common(panel: vscode.WebviewPanel, request: Request): Promise<{ handled: boolean; data?: unknown }> {
    const args = request.args ?? {};
    if (request.action === 'appearance') {
      if (!validBackground(args.color)) throw new Error('颜色须为 #RRGGBB。');
      await vscode.workspace
        .getConfiguration('sheetStudio')
        .update('backgroundColor', args.color.toLowerCase(), vscode.ConfigurationTarget.Global);
      this.refreshAppearance();
      return { handled: true, data: true };
    }
    if (request.action === 'openFile') {
      await this.openFile();
      return { handled: true, data: true };
    }
    if (request.action === 'openManager') {
      this.openManager();
      return { handled: true, data: true };
    }
    if (request.action === 'createFile') {
      await this.createFile();
      return { handled: true, data: true };
    }
    if (request.action === 'exportResults') {
      await this.exportResults(args.result, args.format);
      return { handled: true, data: true };
    }
    return { handled: false };
  }
  private initial(state: DatabaseState, key: string) {
    return {
      state,
      profiles: this.profiles(),
      history: this.history(key),
      backgroundColor: normalizeBackground(vscode.workspace.getConfiguration('sheetStudio').get('backgroundColor')),
    };
  }
  private async handleFile(document: DatabaseDocument, panel: vscode.WebviewPanel, request: Request): Promise<unknown> {
    const args = request.args ?? {},
      common = await this.common(panel, request);
    if (common.handled) return common.data;
    const key = document.uri.toString();
    if (request.action === 'ready') return this.initial(this.fileState(document), key);
    if (request.action === 'refresh') {
      await this.broadcast(document);
      return this.fileState(document);
    }
    if (request.action === 'page') return (await document.client.call('page', args)).result;
    if (request.action === 'describe') return (await document.client.call('describe', args)).result;
    if (request.action === 'execute') {
      const start = performance.now();
      try {
        const response = await document.client.call<QueryResult[]>('execute', {
          sql: args.sql,
          limit: Math.min(1000, Math.max(1, Number(args.limit) || 500)),
        });
        this.record(document, response, '执行 SQLite SQL');
        await this.addHistory(key, args.sql, start, true, response.result);
        await this.broadcast(document, !!response.change);
        return { results: response.result, history: this.history(key) };
      } catch (error) {
        await this.addHistory(key, String(args.sql), start, false);
        throw error;
      }
    }
    if (request.action === 'changes') {
      const response = await document.client.call<number>('changes', args);
      this.record(document, response, '编辑数据库记录');
      await this.broadcast(document, !!response.change);
      return { affectedRows: response.result };
    }
    if (request.action === 'importCsv') {
      const changes = await this.readCsv(args.object);
      if (!changes) return false;
      const response = await document.client.call<number>('changes', { object: args.object, changes });
      this.record(document, response, '导入 CSV');
      await this.broadcast(document, !!response.change);
      return { affectedRows: response.result };
    }
    if (request.action === 'exportDatabase') {
      const sql = args.format === 'sql';
      const destination = await vscode.window.showSaveDialog({
        defaultUri: document.uri.with({
          path: document.uri.path.replace(/\.[^.]+$/, '') + (sql ? '-export.sql' : '-copy.db'),
        }),
        filters: sql ? { SQL: ['sql'] } : { SQLite: ['db', 'sqlite', 'sqlite3'] },
      });
      if (!destination) return false;
      if (destination.toString() === document.uri.toString())
        throw new Error('导出副本请使用其他文件名；保存当前文件请使用 Ctrl+S。');
      const content = sql
        ? Buffer.from((await document.client.call<string>('dump')).result, 'utf8')
        : (await document.client.call<Uint8Array>('image')).result;
      await vscode.workspace.fs.writeFile(destination, content);
      return true;
    }
    throw new Error('不支持此数据库操作。');
  }
  async saveCustomDocument(document: DatabaseDocument, token: vscode.CancellationToken) {
    await document.queue.catch(() => {});
    await checkSidecars(document.uri);
    const disk = await vscode.workspace.fs.readFile(document.uri);
    if (!Buffer.from(disk).equals(Buffer.from(document.original)))
      throw new Error('数据库已被外部程序修改，拒绝覆盖。请导出数据库副本后重新打开。');
    const revision = document.revision,
      image = (await document.client.call<Uint8Array>('image')).result;
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const backup = document.uri.with({ path: document.uri.path + '.sheet-studio.bak' });
    await vscode.workspace.fs.writeFile(backup, disk);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    await checkSidecars(document.uri);
    if (!Buffer.from(await vscode.workspace.fs.readFile(document.uri)).equals(Buffer.from(document.original)))
      throw new Error('保存过程中检测到外部修改，拒绝覆盖。');
    // Replacing the URI with a rename makes VS Code dispose the custom document and its undo stack.
    // The previous image is retained above so failures can be recovered without replacing the open resource.
    await vscode.workspace.fs.writeFile(document.uri, image);
    document.original = image;
    document.savedRevision = revision;
    await this.broadcast(document);
  }
  async saveCustomDocumentAs(document: DatabaseDocument, destination: vscode.Uri, token: vscode.CancellationToken) {
    if (destination.toString() === document.uri.toString()) return this.saveCustomDocument(document, token);
    if (!SQLITE_EXTENSIONS.includes(extname(destination.path).slice(1).toLowerCase()))
      throw new Error('请另存为 .db、.sqlite 或 .sqlite3 等 SQLite 文件。');
    await document.queue.catch(() => {});
    const image = (await document.client.call<Uint8Array>('image')).result;
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    await vscode.workspace.fs.writeFile(destination, image);
  }
  async revertCustomDocument(document: DatabaseDocument) {
    await document.queue.catch(() => {});
    await checkSidecars(document.uri);
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    await document.client.call('restore', { bytes });
    document.original = bytes;
    document.revision = randomUUID();
    document.savedRevision = document.revision;
    await this.broadcast(document, true);
  }
  async backupCustomDocument(
    document: DatabaseDocument,
    context: vscode.CustomDocumentBackupContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    await document.queue.catch(() => {});
    const image = (await document.client.call<Uint8Array>('image')).result;
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    await vscode.workspace.fs.writeFile(
      context.destination,
      Buffer.from(
        JSON.stringify({
          image: Buffer.from(image).toString('base64'),
          original: Buffer.from(document.original).toString('base64'),
        }),
      ),
    );
    return {
      id: context.destination.toString(),
      delete: () => {
        void vscode.workspace.fs.delete(context.destination).then(undefined, () => {});
      },
    };
  }
  async openFile(resource?: vscode.Uri) {
    const uri =
      resource ??
      (await vscode.window.showOpenDialog({ filters: { SQLite: SQLITE_EXTENSIONS }, canSelectMany: false }))?.[0];
    if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, databaseViewType);
  }
  async createFile() {
    const uri = await vscode.window.showSaveDialog({
      filters: { SQLite: ['db', 'sqlite', 'sqlite3'] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'database.db')
        : undefined,
    });
    if (!uri) return;
    if (!SQLITE_EXTENSIONS.includes(extname(uri.path).slice(1).toLowerCase()))
      throw new Error('新建数据库请使用 .db、.sqlite 或 .sqlite3 等 SQLite 扩展名。');
    const client = new SqliteClient(this.directory(), new Uint8Array());
    try {
      await vscode.workspace.fs.writeFile(uri, (await client.call<Uint8Array>('image')).result);
    } finally {
      await client.close();
    }
    await this.openFile(uri);
  }
  openManager() {
    const existing = [...this.managers][0];
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'sheetStudio.connections',
      'Sheet Studio 数据库',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.html(panel);
    const session: RemotePanel = { panel, queue: Promise.resolve(), objects: [], transaction: false };
    this.managers.add(session);
    const listener = panel.webview.onDidReceiveMessage((request: Request) => {
      if (request.action === 'cancel') {
        void (async () => {
          try {
            const driver = session.driver;
            session.driver = undefined;
            session.objects = [];
            session.transaction = false;
            if (driver?.cancel) await driver.cancel();
            else await driver?.close();
            this.reply(panel, request, true);
          } catch (error) {
            this.reply(panel, request, undefined, error);
          } finally {
            void panel.webview.postMessage({ type: 'dbState', state: this.remoteState(session) });
          }
        })();
        return;
      }
      session.queue = session.queue
        .catch(() => {})
        .then(async () => {
          try {
            this.reply(panel, request, await this.handleRemote(session, request));
          } catch (error) {
            this.reply(panel, request, undefined, error);
          }
        });
    });
    panel.onDidDispose(() => {
      listener.dispose();
      session.disposed = true;
      this.managers.delete(session);
      void session.driver?.close();
    });
  }
  private async handleRemote(session: RemotePanel, request: Request): Promise<unknown> {
    if (session.disposed) throw new Error('数据库管理器已关闭。');
    const args = request.args ?? {},
      common = await this.common(session.panel, request);
    if (common.handled) return common.data;
    if (request.action === 'ready') return this.initial(this.remoteState(session), session.profile?.id ?? 'manager');
    if (request.action === 'saveConnection') {
      const profile = validateProfile(args.profile),
        profiles = this.profiles().filter((p) => p.id !== profile.id);
      await this.context.globalState.update('database.connections', [...profiles, profile]);
      if (
        typeof args.password === 'string' &&
        (args.password.length || !(await this.context.secrets.get('database.password.' + profile.id)))
      )
        await this.context.secrets.store('database.password.' + profile.id, args.password);
      return this.profiles();
    }
    if (request.action === 'deleteConnection') {
      await this.context.globalState.update(
        'database.connections',
        this.profiles().filter((p) => p.id !== args.id),
      );
      await this.context.secrets.delete('database.password.' + args.id);
      return this.profiles();
    }
    if (request.action === 'connect' || request.action === 'testConnection') {
      const profile = args.profile ? validateProfile(args.profile) : this.profiles().find((p) => p.id === args.id);
      if (!profile) throw new Error('连接配置不存在。');
      const password =
        typeof args.password === 'string' && args.password.length
          ? args.password
          : ((await this.context.secrets.get('database.password.' + profile.id)) ?? '');
      const next = await RemoteDriver.connect(profile, password);
      if (session.disposed) {
        await next.close();
        throw new Error('数据库管理器已关闭。');
      }
      if (request.action === 'testConnection') {
        await next.close();
        return true;
      }
      let objects: DbObject[];
      try {
        objects = await next.catalog();
        if (session.disposed) throw new Error('数据库管理器已关闭。');
      } catch (error) {
        await next.close();
        throw error;
      }
      await session.driver?.close();
      session.driver = next;
      session.profile = profile;
      session.objects = objects;
      session.transaction = false;
      const state = this.remoteState(session);
      void session.panel.webview.postMessage({ type: 'dbState', state, changed: true });
      return this.initial(state, profile.id);
    }
    if (request.action === 'disconnect') {
      await session.driver?.close();
      session.driver = undefined;
      session.objects = [];
      session.transaction = false;
      return this.remoteState(session);
    }
    const driver = session.driver;
    if (!driver) throw new Error('请先选择一个连接并连接数据库。');
    if (request.action === 'page') return browse(driver, args.object, args.options);
    if (request.action === 'describe') return driver.describe(args.object);
    if (request.action === 'refresh') {
      session.objects = await driver.catalog();
      return this.remoteState(session);
    }
    if (request.action === 'execute') {
      validateUserSql(args.sql);
      const start = performance.now(),
        key = session.profile!.id;
      try {
        const results = await driver.query(args.sql, [], Math.min(1000, Math.max(1, Number(args.limit) || 500)));
        await this.addHistory(key, args.sql, start, true, results);
        session.objects = await driver.catalog();
        void session.panel.webview.postMessage({ type: 'dbState', state: this.remoteState(session) });
        return { results, history: this.history(key) };
      } catch (error) {
        await this.addHistory(key, args.sql, start, false);
        throw error;
      }
    }
    if (request.action === 'changes' || request.action === 'importCsv') {
      const changes = request.action === 'importCsv' ? await this.readCsv(args.object) : args.changes;
      if (!changes) return false;
      return { affectedRows: await applyRowChanges(driver, args.object, changes, session.transaction) };
    }
    if (request.action === 'transaction') {
      if (args.command === 'begin') {
        if (session.transaction) throw new Error('事务已开启。');
        await driver.begin();
        session.transaction = true;
      } else if (args.command === 'commit') {
        await driver.commit();
        session.transaction = false;
      } else if (args.command === 'rollback') {
        await driver.rollback();
        session.transaction = false;
      } else throw new Error('事务命令无效。');
      return this.remoteState(session);
    }
    throw new Error('不支持此数据库操作。');
  }
  private async readCsv(_object: DbObject) {
    const uri = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ['csv', 'tsv'] } }))?.[0];
    if (!uri) return;
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.length > 10 * 1024 * 1024) throw new Error('导入 CSV 文件最多 10 MB，请分批导入。');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      delimiter: extname(uri.path).toLowerCase() === '.tsv' ? '\t' : '',
      skipEmptyLines: 'greedy',
    });
    if (parsed.errors.length) throw new Error('CSV 解析失败：' + parsed.errors[0].message);
    if (!parsed.data.length || parsed.data.length > 5000)
      throw new Error('单次 CSV 导入须为 1–5000 行，首行须是数据库列名。');
    return parsed.data.map((values) => ({ type: 'insert' as const, values }));
  }
  private async exportResults(result: QueryResult, format: string) {
    const bytes = await exportQueryResult(result, format);
    const uri = await vscode.window.showSaveDialog({
      filters: { [format.toUpperCase()]: [format] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `result.${format}`)
        : undefined,
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, bytes);
  }
}
