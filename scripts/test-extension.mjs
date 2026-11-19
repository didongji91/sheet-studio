import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = process.cwd();
await mkdir('output/extension-test', { recursive: true });
await build({ entryPoints: ['test/extensionRunner.ts'], outfile: 'output/extension-test/suite.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });
await runTests({
  ...(process.env.SHEET_STUDIO_VSCODE ? { vscodeExecutablePath: resolve(process.env.SHEET_STUDIO_VSCODE) } : {}),
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve('output/extension-test/suite.cjs'),
  launchArgs: [
    '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    `--user-data-dir=${resolve('output/extension-test/profile')}`,
    `--extensions-dir=${resolve('output/extension-test/extensions')}`,
  ],
});
