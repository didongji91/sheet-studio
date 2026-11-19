import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { basename, extname, dirname } from 'node:path';
import { readWorkbook, writeWorkbook, type LoadedFile } from './files';
import { applyOperation, blankWorkbook, cellAddress, coordinates, rawCell, type Workbook, type Operation } from './model';
import { DEFAULT_BACKGROUND, normalizeBackground, validBackground } from './appearance';
import { DatabaseProvider, databaseViewType } from './database/provider';

const viewType = 'sheetStudio.editor';
const formats = ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods'];
const equalBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
function settings(): { encoding: string; delimiter: string; maxBytes: number } {
  const config = vscode.workspace.getConfiguration('sheetStudio');
  return { encoding: config.get('csvEncoding', 'auto'), delimiter: config.get('csvDelimiter', 'auto'), maxBytes: config.get('maxFileSizeMB', 40) * 1024 * 1024 };
}
async function load(uri: vscode.Uri) {
  const config = settings();
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > config.maxBytes) throw new Error('文件超过大小限制，可在设置 sheetStudio.maxFileSizeMB 中调整。');
  return readWorkbook(await vscode.workspace.fs.readFile(uri), uri.path, config);
}

class SheetDocument implements vscode.CustomDocument {
  readonly panels = new Set<vscode.WebviewPanel>();
  readonly disposeEvent = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEvent.event;
  saved: Workbook;
  queue: Promise<void> = Promise.resolve();
  constructor(readonly uri: vscode.Uri, public source: LoadedFile, public model = source.model) { this.saved = source.model; }
  dispose() { this.disposeEvent.fire(); this.disposeEvent.dispose(); this.panels.clear(); }
  broadcast(extra: Record<string, unknown> = {}) {
    for (const panel of this.panels) void panel.webview.postMessage({ type: 'state', workbook: this.model, dirty: this.model !== this.saved, ...extra });
  }
}
export class SheetEditorProvider implements vscode.CustomEditorProvider<SheetDocument> {
  private change = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SheetDocument>>();
  readonly onDidChangeCustomDocument = this.change.event;
  private reveals = new Map<string, { sheetId: string; row: number; col: number }>();
  private documents = new Map<string, SheetDocument>();
  constructor(private context: vscode.ExtensionContext) { context.subscriptions.push(this.change); }
  refreshAppearance() {
    const backgroundColor = normalizeBackground(vscode.workspace.getConfiguration('sheetStudio').get('backgroundColor', DEFAULT_BACKGROUND));
    for (const document of this.documents.values()) for (const panel of document.panels)
      void panel.webview.postMessage({ type: 'appearance', backgroundColor });
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<SheetDocument> {
    let source: LoadedFile, model: Workbook | undefined;
    if (openContext.backupId) {
      const backup = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId))).toString('utf8'));
      source = await readWorkbook(Buffer.from(backup.original, 'base64'), uri.path, settings());
      model = backup.model;
    } else source = await load(uri);
    const document = new SheetDocument(uri, source, model);
    this.documents.set(uri.toString(), document);
    document.onDidDispose(() => this.documents.delete(uri.toString()));
    return document;
  }
  async resolveCustomEditor(document: SheetDocument, panel: vscode.WebviewPanel): Promise<void> {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const nonce = randomBytes(20).toString('hex');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource} data:; font-src ${panel.webview.cspSource}; connect-src 'none';">
      <meta name="viewport" content="width=device-width, initial-scale=1.0"><link href="${style}" rel="stylesheet"><title>Sheet Studio</title></head>
      <body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    document.panels.add(panel);
    const subscriptions: vscode.Disposable[] = [];
    subscriptions.push(panel.webview.onDidReceiveMessage(message => {
      document.queue = document.queue.then(async () => {
        try { await this.handleMessage(document, panel, message); }
        catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          void panel.webview.postMessage({ type: 'error', message: text, workbook: document.model, ack: message?.sequence });
          void vscode.window.showErrorMessage(`Sheet Studio: ${text}`);
        }
      });
    }));
    subscriptions.push(panel.onDidDispose(() => { document.panels.delete(panel); for (const sub of subscriptions) sub.dispose(); }));
  }
  private async handleMessage(document: SheetDocument, panel: vscode.WebviewPanel, message: any) {
    switch (message?.type) {
      case 'ready': {
        document.broadcast();
        this.refreshAppearance();
        const reveal = this.reveals.get(document.uri.toString());
        if (reveal) { void panel.webview.postMessage({ type: 'reveal', ...reveal }); this.reveals.delete(document.uri.toString()); }
        break;
      }
      case 'setAppearance': {
        if (!validBackground(message.backgroundColor)) throw new Error('背景颜色须为 #RRGGBB 格式。');
        await vscode.workspace.getConfiguration('sheetStudio').update('backgroundColor', message.backgroundColor.toLowerCase(), vscode.ConfigurationTarget.Global);
        this.refreshAppearance();
        break;
      }
      case 'edit': {
        const operation = message.operation as Operation;
        if (!operation || typeof operation.type !== 'string') throw new Error('编辑操作无效。');
        const before = document.model;
        const after = applyOperation(before, operation);
        document.model = after;
        this.change.fire({
          document, label: 'label' in operation && operation.label ? operation.label : operation.type === 'cells' ? '编辑单元格' : '编辑表格',
          undo: async () => { document.model = before; document.broadcast(); },
          redo: async () => { document.model = after; document.broadcast(); },
        });
        document.broadcast({ ack: message.sequence, clientId: message.clientId });
        break;
      }
      case 'save': await vscode.commands.executeCommand('workbench.action.files.save'); break;
      case 'undo': await vscode.commands.executeCommand('undo'); break;
      case 'redo': await vscode.commands.executeCommand('redo'); break;
      case 'open': await vscode.commands.executeCommand('sheetStudio.open'); break;
      case 'new': await vscode.commands.executeCommand('sheetStudio.create'); break;
      case 'workspaceSearch': await vscode.commands.executeCommand('sheetStudio.searchWorkspace'); break;
      case 'export': await this.export(document, message.format, message.sheetId); break;
    }
  }
  async saveCustomDocument(document: SheetDocument, cancellation: vscode.CancellationToken) {
    if (document.source.fidelityRisk) throw new Error('此文件需要兼容转换。请点击编辑器右上角“导出”，保存为新的 XLSX 文件。');
    const disk = await vscode.workspace.fs.readFile(document.uri);
    if (!equalBytes(disk, document.source.original)) throw new Error('文件已被外部程序修改。请先导出当前编辑为副本，再重新打开原文件。');
    const snapshot = document.model;
    const bytes = await writeWorkbook(snapshot, snapshot.format as 'xlsx' | 'csv' | 'tsv', document.source);
    if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
    await vscode.workspace.fs.writeFile(document.uri, bytes);
    document.source = { ...document.source, original: bytes, model: snapshot };
    document.saved = snapshot;
    void document.broadcast({ saved: true });
  }
  async saveCustomDocumentAs(document: SheetDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken) {
    if (destination.toString() === document.uri.toString()) return this.saveCustomDocument(document, cancellation);
    const format = extname(destination.path).slice(1).toLowerCase();
    if (!['xlsx', 'csv', 'tsv'].includes(format)) throw new Error('请另存为 .xlsx、.csv 或 .tsv。');
    if (destination.toString() === document.uri.toString() && document.source.fidelityRisk) throw new Error('兼容模式请保存到新文件。');
    if (format !== 'xlsx' && document.model.sheets.length > 1) throw new Error('多工作表请另存为 XLSX，或使用“导出”保存当前工作表。');
    const bytes = await writeWorkbook(document.model, format as 'xlsx' | 'csv' | 'tsv', document.source);
    if (!cancellation.isCancellationRequested) await vscode.workspace.fs.writeFile(destination, bytes);
    else throw new vscode.CancellationError();
  }
  async revertCustomDocument(document: SheetDocument) {
    document.source = await load(document.uri); document.model = document.source.model; document.saved = document.model; document.broadcast();
  }
  async backupCustomDocument(document: SheetDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    const data = Buffer.from(JSON.stringify({ model: document.model, original: Buffer.from(document.source.original).toString('base64') }));
    if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
    await vscode.workspace.fs.writeFile(context.destination, data);
    return { id: context.destination.toString(), delete: () => { void vscode.workspace.fs.delete(context.destination).then(undefined, () => {}); } };
  }
  async reveal(uri: vscode.Uri, sheetId: string, row: number, col: number) {
    this.reveals.set(uri.toString(), { sheetId, row, col });
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
    const document = this.documents.get(uri.toString());
    if (document?.panels.size) {
      for (const panel of document.panels) void panel.webview.postMessage({ type: 'reveal', sheetId, row, col });
    }
  }
  private async export(document: SheetDocument, requested: string, sheetId?: string) {
    if (!['xlsx', 'csv', 'tsv'].includes(requested)) throw new Error('不支持此导出格式。');
    const format = requested as 'xlsx' | 'csv' | 'tsv';
    const stem = basename(document.uri.path, extname(document.uri.path));
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(document.uri, '..', `${stem}-export.${format}`),
      filters: { [format.toUpperCase()]: [format] }, saveLabel: '导出表格',
    });
    if (!destination) return;
    if (extname(destination.path).slice(1).toLowerCase() !== format) throw new Error(`导出文件名须以 .${format} 结尾。`);
    if (destination.toString() === document.uri.toString()) throw new Error('导出请使用新文件名；保存当前文件请使用 Ctrl+S。');
    const bytes = await writeWorkbook(document.model, format, document.source, sheetId);
    await vscode.workspace.fs.writeFile(destination, bytes);
    const action = await vscode.window.showInformationMessage(`已导出 ${basename(destination.path)}${format === 'xlsx' ? '' : '（仅当前工作表的值）'}`, '打开');
    if (action) await vscode.commands.executeCommand('vscode.openWith', destination, viewType);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new SheetEditorProvider(context);
  const databaseProvider = new DatabaseProvider(context);
  context.subscriptions.push(
    databaseProvider,
    vscode.window.registerCustomEditorProvider(databaseViewType, databaseProvider, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('sheetStudio.openDatabase', (resource?: vscode.Uri) => databaseProvider.openFile(resource)),
    vscode.commands.registerCommand('sheetStudio.createDatabase', () => databaseProvider.createFile()),
    vscode.commands.registerCommand('sheetStudio.databaseManager', () => databaseProvider.openManager()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('sheetStudio.backgroundColor')) { provider.refreshAppearance(); databaseProvider.refreshAppearance(); }
    }),
    vscode.window.registerCustomEditorProvider(viewType, provider, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('sheetStudio.open', async (resource?: vscode.Uri) => {
      const uri = resource instanceof vscode.Uri ? resource : (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { '表格文件': formats } }))?.[0];
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
    }),
    vscode.commands.registerCommand('sheetStudio.create', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const uri = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, '工作簿.xlsx') : undefined, filters: { 'Excel 工作簿': ['xlsx'] } });
      if (!uri) return;
      if (extname(uri.path).toLowerCase() !== '.xlsx') throw new Error('新工作簿请使用 .xlsx 文件名。');
      await vscode.workspace.fs.writeFile(uri, await writeWorkbook(blankWorkbook(basename(uri.path)), 'xlsx'));
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
    }),
    vscode.commands.registerCommand('sheetStudio.searchWorkspace', () => searchWorkspace(provider)),
  );
  return { provider, databaseProvider };
}
async function searchWorkspace(provider: SheetEditorProvider) {
  if (!vscode.workspace.workspaceFolders?.length) { void vscode.window.showInformationMessage('请先打开一个文件夹，再检索工作区表格。'); return; }
  const query = await vscode.window.showInputBox({ title: '检索工作区中的表格', prompt: '搜索单元格文本、公式或缓存结果（不区分大小写）', placeHolder: '输入关键字' });
  if (!query) return;
  const limit = vscode.workspace.getConfiguration('sheetStudio').get('searchFileLimit', 100);
  const found: (vscode.QuickPickItem & { uri: vscode.Uri; sheetId: string; row: number; col: number })[] = [];
  let skipped = 0, scanned = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Sheet Studio 正在检索表格', cancellable: true }, async (progress, token) => {
    const files = await vscode.workspace.findFiles('**/*.{xlsx,xls,xlsm,xlsb,csv,tsv,ods,XLSX,XLS,CSV,TSV,ODS}', '**/{node_modules,.git,.vscode-test}/**', limit, token);
    for (const uri of files) {
      if (token.isCancellationRequested || found.length >= 500) break;
      if (basename(uri.path).startsWith('~$')) continue;
      progress.report({ message: vscode.workspace.asRelativePath(uri), increment: 100 / files.length });
      try {
        const { model } = await load(uri);
        scanned++;
        for (const sheet of model.sheets) for (const [address, cell] of Object.entries(sheet.cells)) {
          if (found.length >= 500) break;
          const text = `${rawCell(cell)}\n${cell.cached ?? ''}`;
          if (!text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
          const [row, col] = coordinates(address);
          found.push({ label: `${sheet.name}!${cellAddress(row, col)}`, description: vscode.workspace.asRelativePath(uri), detail: rawCell(cell).replace(/\r?\n/g, ' ').slice(0, 160), uri, sheetId: sheet.id, row, col });
        }
      } catch { skipped++; }
    }
  });
  if (!found.length) { void vscode.window.showInformationMessage(`未找到“${query}”。已检索 ${scanned} 个文件${skipped ? `，跳过 ${skipped} 个无法读取的文件` : ''}。`); return; }
  const selected = await vscode.window.showQuickPick(found, { title: `找到 ${found.length}${found.length >= 500 ? '+' : ''} 处匹配 · 已检索 ${scanned} 个文件${skipped ? ` · 跳过 ${skipped}` : ''}`, matchOnDescription: true, matchOnDetail: true, placeHolder: '选择结果，跳转到单元格' });
  if (selected) await provider.reveal(selected.uri, selected.sheetId, selected.row, selected.col);
}
export function deactivate() {}
