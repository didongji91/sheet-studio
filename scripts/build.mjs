import { build, context } from 'esbuild';
import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await mkdir('dist', { recursive: true });
const shared = { bundle: true, sourcemap: true, logLevel: 'info', legalComments: 'eof', metafile: true };
const configurations = [
  { ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'] },
  { ...shared, entryPoints: ['webview/main.tsx'], outfile: 'dist/webview.js', platform: 'browser', target: 'chrome120', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, minify: true },
  { ...shared, entryPoints: ['src/database/sqlite-worker.ts'], outfile: 'dist/sqlite-worker.cjs', platform: 'node', target: 'node20', format: 'cjs' },
  { ...shared, entryPoints: ['webview/database.tsx'], outfile: 'dist/database.js', platform: 'browser', target: 'chrome120', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, minify: true },
  { ...shared, entryPoints: ['scripts/database-preview.ts'], outfile: 'output/database-preview.cjs', platform: 'node', target: 'node20', format: 'cjs' },
];
if (process.argv.includes('--watch')) {
  for (const config of configurations) await (await context(config)).watch();
} else {
  const results = await Promise.all(configurations.map(config => build(config)));
  const directories = new Set();
  for (const result of results) for (const input of Object.keys(result.metafile.inputs)) {
    const normalized = input.replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('node_modules/');
    if (marker < 0) continue;
    const parts = normalized.slice(marker + 13).split('/');
    const packageName = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    directories.add(normalized.slice(0, marker) + 'node_modules/' + packageName);
  }
  const notices = ['Third-party software notices', 'The following packages are included in the bundled extension and webview.'];
  for (const directory of [...directories].sort()) {
    const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    notices.push(`\n${'='.repeat(72)}\n${manifest.name} ${manifest.version}\nLicense: ${typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? manifest.licenses ?? 'See license below')}`);
    const files = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name));
    for (const file of files) {
      try { notices.push(`\n--- ${file} ---\n${await readFile(resolve(directory, file), 'utf8')}`); } catch { /* Some projects use a LICENSE directory. */ }
    }
  }
  await writeFile('THIRD_PARTY_NOTICES.txt', notices.join('\n'), 'utf8');
}
await copyFile('webview/styles.css', 'dist/webview.css');
await writeFile('dist/database.css', (await readFile('webview/styles.css', 'utf8')) + '\n' + (await readFile('webview/database.css', 'utf8')));
await copyFile('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm');
