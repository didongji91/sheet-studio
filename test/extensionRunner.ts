import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SqliteClient } from '../src/database/sqlite-client';

export async function run() {
  const extension = vscode.extensions.getExtension('local-tools.sheet-studio');
  assert.ok(extension, 'extension must be discovered by VS Code');
  const { provider, databaseProvider } = await extension.activate();
  const folder = resolve(extension.extensionPath, 'output/extension-test/fixtures');
  await mkdir(folder, { recursive: true });
  const uri = vscode.Uri.file(resolve(folder, 'lifecycle.csv'));
  await writeFile(uri.fsPath, '编号,金额\r\n00123,100\r\n');
  await vscode.commands.executeCommand('vscode.openWith', uri, 'sheetStudio.editor');
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
  const document = provider.documents.get(uri.toString());
  assert.ok(document, 'registered provider should own the opened document');
  const id = document.model.sheets[0].id;
  let latest: vscode.CustomDocumentEditEvent<any> | undefined;
  const listener = provider.onDidChangeCustomDocument((event: vscode.CustomDocumentEditEvent<any>) => { latest = event; });
  await provider.handleMessage(document, {}, { type: 'edit', sequence: 1, clientId: 'test', operation: { type: 'cells', sheetId: id, changes: [{ row: 1, col: 1, cell: { value: 250 } }] } });
  assert.equal(document.model.sheets[0].cells['1,1'].value, 250);
  assert.ok(latest, 'VS Code must receive an undoable edit event');
  await latest.undo();
  assert.equal(document.model.sheets[0].cells['1,1'].value, 100);
  await latest.redo();
  assert.equal(document.model.sheets[0].cells['1,1'].value, 250);
  await vscode.commands.executeCommand('workbench.action.files.save');
  const disk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  assert.ok(disk.includes('00123,250'), 'native save command should persist the edited CSV');
  console.log('PASS actual custom editor open, native save and undo/redo event callbacks');

  const configuration = vscode.workspace.getConfiguration('sheetStudio');
  const originalBackground = configuration.inspect<string>('backgroundColor')?.globalValue;
  const messages: any[][] = [[], []];
  const observers = messages.map(inbox => ({ webview: { postMessage: (message: any) => { inbox.push(message); return Promise.resolve(true); } } }));
  const appearanceUri = vscode.Uri.file(resolve(folder, 'appearance.csv'));
  await writeFile(appearanceUri.fsPath, '名称,值\r\n外观,1\r\n');
  const otherDocument = await provider.openCustomDocument(appearanceUri, {});
  document.panels.add(observers[0]); otherDocument.panels.add(observers[1]);
  const unchangedModel = document.model, unchangedEdit = latest;
  try {
    await provider.handleMessage(document, {}, { type: 'setAppearance', backgroundColor: '#F3EADA' });
    assert.equal(vscode.workspace.getConfiguration('sheetStudio').get('backgroundColor'), '#f3eada');
    for (const inbox of messages) assert.ok(inbox.some(m => m.type === 'appearance' && m.backgroundColor === '#f3eada'), 'appearance must reach all open documents');
    assert.equal(document.model, unchangedModel);
    assert.equal(document.model, document.saved, 'appearance must not dirty the workbook');
    assert.equal(latest, unchangedEdit, 'appearance must not create a spreadsheet undo entry');
    messages[0].length = 0;
    await provider.handleMessage(document, {}, { type: 'ready' });
    assert.ok(messages[0].some(m => m.type === 'appearance' && m.backgroundColor === '#f3eada'), 'new editor instances must receive the persisted color');
    await assert.rejects(() => provider.handleMessage(document, {}, { type: 'setAppearance', backgroundColor: 'red; color: black' }), /背景颜色/);
    assert.equal(vscode.workspace.getConfiguration('sheetStudio').get('backgroundColor'), '#f3eada');
    console.log('PASS background preference persists, broadcasts to other documents and leaves workbook and undo history untouched');
  } finally {
    document.panels.delete(observers[0]); otherDocument.panels.delete(observers[1]);
    otherDocument.dispose();
    await configuration.update('backgroundColor', originalBackground, vscode.ConfigurationTarget.Global);
  }

  await provider.handleMessage(document, {}, { type: 'edit', sequence: 2, clientId: 'test', operation: { type: 'cells', sheetId: id, changes: [{ row: 1, col: 1, cell: { value: 350 } }] } });
  const destination = vscode.Uri.file(resolve(folder, 'hot-exit-backup.json'));
  const token = new vscode.CancellationTokenSource();
  const backup = await provider.backupCustomDocument(document, { destination }, token.token);
  const restored = await provider.openCustomDocument(uri, { backupId: backup.id });
  assert.equal(restored.model.sheets[0].cells['1,1'].value, 350);
  restored.dispose(); backup.delete();
  console.log('PASS unsaved edits survive backup and restore');

  await vscode.workspace.fs.writeFile(uri, Buffer.from('编号,金额\r\n00123,999\r\n'));
  await assert.rejects(() => provider.saveCustomDocument(document, token.token), /外部程序修改/);
  assert.ok(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').includes('999'));
  console.log('PASS external file changes are protected against overwrite');

  const exported = vscode.Uri.file(resolve(folder, 'saved-as.xlsx'));
  await provider.saveCustomDocumentAs(document, exported, token.token);
  const nativeDocument = await provider.openCustomDocument(exported, {});
  assert.equal(nativeDocument.model.sheets[0].cells['1,1'].value, 350);
  nativeDocument.dispose();
  console.log('PASS save-as converts CSV edits to a readable XLSX workbook');
  await vscode.commands.executeCommand('vscode.openWith', exported, 'sheetStudio.editor');
  const sizedDocument = provider.documents.get(exported.toString()), sizedId = sizedDocument.model.sheets[0].id;
  await provider.handleMessage(sizedDocument, {}, { type: 'edit', sequence: 3, clientId: 'test', operation: { type: 'resize', sheetId: sizedId, axis: 'row', index: 4, count: 3, size: 52.5 } });
  const resizeEdit = latest!;
  assert.equal(sizedDocument.model.sheets[0].rowHeights[6], 52.5);
  await resizeEdit.undo();
  assert.equal(sizedDocument.model.sheets[0].rowHeights[4], undefined);
  assert.equal(sizedDocument.model.sheets[0].rowHeights[6], undefined, 'one undo must restore the entire batch');
  await resizeEdit.redo();
  await provider.handleMessage(sizedDocument, {}, { type: 'edit', sequence: 4, clientId: 'test', operation: { type: 'resize', sheetId: sizedId, axis: 'column', index: 3, count: 2, size: 178.25 } });
  await vscode.commands.executeCommand('workbench.action.files.save');
  await provider.revertCustomDocument(sizedDocument);
  assert.equal(sizedDocument.model.sheets[0].rowHeights[4], 52.5);
  assert.equal(sizedDocument.model.sheets[0].rowHeights[6], 52.5);
  assert.equal(sizedDocument.model.sheets[0].columnWidths[3], 178.25);
  assert.equal(sizedDocument.model.sheets[0].columnWidths[4], 178.25);
  console.log('PASS batch row and column dimensions undo together and survive native XLSX save and reload');
  listener.dispose(); token.dispose();
  await provider.revertCustomDocument(document);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await checkDatabaseExtension(extension.extensionPath, databaseProvider, folder);
  console.log('Sheet Studio VS Code integration checks passed.');
}
async function checkDatabaseExtension(root: string, provider: any, folder: string) {
  const uri = vscode.Uri.file(resolve(folder, 'database-lifecycle.sqlite3'));
  const builder = new SqliteClient(resolve(root, 'dist'), new Uint8Array());
  await builder.call('execute', { sql: "CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, balance INTEGER DEFAULT 0); INSERT INTO customers VALUES(1,'原始客户',100);" });
  await vscode.workspace.fs.writeFile(uri, (await builder.call<Uint8Array>('image')).result);
  await builder.close();
  await vscode.commands.executeCommand('vscode.openWith', uri, 'sheetStudio.database');
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
  const document = provider.documents.get(uri.toString());
  assert.ok(document, 'SQLite file association must activate the database provider');
  let edit: vscode.CustomDocumentEditEvent<any> | undefined;
  const listener = provider.onDidChangeCustomDocument((event: vscode.CustomDocumentEditEvent<any>) => { edit = event; });
  const object = { schema: 'main', name: 'customers', type: 'table' };
  const query = async () => (await document.client.call('page', { object })).result;
  await provider.handleFile(document, {}, { id: 'db-1', action: 'execute', args: { sql: "UPDATE customers SET name='已修改',balance=250 WHERE id=1;" } });
  assert.equal((await query()).rows[0][1], '已修改'); assert.ok(document.dirty); assert.ok(edit);
  await edit!.undo(); assert.equal((await query()).rows[0][1], '原始客户');
  await edit!.redo(); assert.equal((await query()).rows[0][2], 250);
  await vscode.commands.executeCommand('workbench.action.files.save');
  assert.equal(document.dirty, false);
  const disk = new SqliteClient(resolve(root, 'dist'), await vscode.workspace.fs.readFile(uri));
  assert.equal((await disk.call<any>('page', { object })).result.rows[0][1], '已修改'); await disk.close();
  const backupUri = uri.with({ path: uri.path + '.sheet-studio.bak' });
  const previous = new SqliteClient(resolve(root, 'dist'), await vscode.workspace.fs.readFile(backupUri));
  assert.equal((await previous.call<any>('page', { object })).result.rows[0][1], '原始客户'); await previous.close();
  console.log('PASS actual SQLite file association, SQL edit, native undo/redo, native save and original-image backup');

  await provider.handleFile(document, {}, { id: 'db-2', action: 'execute', args: { sql: "UPDATE customers SET balance=350 WHERE id=1;" } });
  const token = new vscode.CancellationTokenSource(), destination = vscode.Uri.file(resolve(folder, 'database-hot-exit.json'));
  const saveAs = vscode.Uri.file(resolve(folder, 'database-save-as.db'));
  await provider.saveCustomDocumentAs(document, saveAs, token.token);
  const savedAs = await provider.openCustomDocument(saveAs, {});
  assert.equal((await savedAs.client.call('page', { object })).result.rows[0][2], 350);
  savedAs.dispose();
  assert.equal(document.dirty, true, 'saving a copy must keep the original document dirty');
  console.log('PASS SQLite save-as produces a readable database copy and preserves unsaved original edits');
  const backup = await provider.backupCustomDocument(document, { destination }, token.token);
  const restoredUri = vscode.Uri.file(resolve(folder, 'database-restored.sqlite3'));
  await vscode.workspace.fs.writeFile(restoredUri, await vscode.workspace.fs.readFile(uri));
  const restored = await provider.openCustomDocument(restoredUri, { backupId: backup.id });
  assert.equal((await restored.client.call('page', { object })).result.rows[0][2], 350);
  assert.equal(restored.dirty, true); restored.dispose(); backup.delete();
  console.log('PASS SQLite unsaved SQL changes survive hot-exit backup and restore');

  const wal = uri.with({ path: uri.path + '-wal' });
  await vscode.workspace.fs.writeFile(wal, Buffer.from('active journal'));
  await assert.rejects(() => provider.saveCustomDocument(document, token.token), /checkpoint/);
  await assert.rejects(() => provider.openCustomDocument(uri, {}), /checkpoint/);
  await vscode.workspace.fs.delete(wal);
  const diskBefore = await vscode.workspace.fs.readFile(uri);
  const external = new SqliteClient(resolve(root, 'dist'), diskBefore);
  await external.call('execute', { sql: "UPDATE customers SET balance=999 WHERE id=1;" });
  await vscode.workspace.fs.writeFile(uri, (await external.call<Uint8Array>('image')).result); await external.close();
  await assert.rejects(() => provider.saveCustomDocument(document, token.token), /外部程序修改/);
  let revertedDocument: unknown;
  let revertTask: Promise<void> | undefined;
  const revertDocument = provider.revertCustomDocument.bind(provider);
  provider.revertCustomDocument = (target: unknown) => {
    revertedDocument = target;
    return revertTask = revertDocument(target);
  };
  await vscode.commands.executeCommand('workbench.action.files.revert');
  assert.equal(revertedDocument, document, 'native revert must reach the active custom document');
  assert.ok(revertTask);
  await revertTask;
  provider.revertCustomDocument = revertDocument;
  assert.equal((await query()).rows[0][2], 999);
  console.log('PASS SQLite active WAL and external file changes prevent overwrite; native revert reloads current data');

  const fakePanel = { webview: { postMessage: () => Promise.resolve(true) } };
  const session = { panel: fakePanel, transaction: false, objects: [], queue: Promise.resolve() };
  const profile = { id: 'integration-test-profile', name: '测试 PostgreSQL', kind: 'postgres', host: 'localhost', port: 5432, database: 'test', username: 'tester', ssl: 'verify', password: 'must be stripped' };
  const password = 'test-secret-not-in-settings';
  await provider.handleRemote(session, { id: 'p1', action: 'saveConnection', args: { profile, password } });
  const profiles = provider.profiles();
  assert.ok(profiles.some((p: any) => p.id === profile.id));
  assert.equal(JSON.stringify(profiles).includes(password), false);
  assert.equal(JSON.stringify(profiles).includes('must be stripped'), false);
  assert.equal(await provider.context.secrets.get('database.password.' + profile.id), password);
  await provider.handleRemote(session, { id: 'p2', action: 'deleteConnection', args: { id: profile.id } });
  assert.equal(await provider.context.secrets.get('database.password.' + profile.id), undefined);
  console.log('PASS connection profiles exclude passwords and use actual VS Code SecretStorage with deletion cleanup');
  await Promise.all(['postgres', 'mysql', 'mariadb', 'mssql'].map(kind =>
    assert.rejects(() => provider.handleRemote(session, {
      id: `driver-${kind}`, action: 'testConnection',
      args: { profile: { ...profile, kind, host: '127.0.0.1', port: 1 }, password },
    }), (error: unknown) => {
      assert.doesNotMatch(String(error), /Cannot find module|MODULE_NOT_FOUND|is not a function|test-secret-not-in-settings/);
      return true;
    }),
  ));
  console.log('PASS all four bundled server drivers load inside the actual extension host and report unavailable servers');
  listener.dispose(); token.dispose();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}
