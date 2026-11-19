import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { databasePreview, closeDatabasePreview } from '../output/database-preview.cjs';
const port = Number(process.env.SHEET_STUDIO_PORT ?? 5173);
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/webview.css"><title>Sheet Studio 预览</title></head><body><div id="root"></div><script src="/webview.js"></script></body></html>';
const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/api/database') && req.method === 'POST') {
    try {
      let body = '';
      for await (const part of req) { body += part.toString(); if (body.length > 2_000_000) throw new Error('Request too large'); }
      const response = await databasePreview(JSON.parse(body), new URL(req.url, 'http://localhost').searchParams.get('mode') === 'manager');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(response));
    } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (req.url?.split('?')[0] === '/database') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html.replace('/webview.css', '/database.css').replace('/webview.js', '/database.js')); return;
  }
  if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const routes = { '/webview.js': ['dist/webview.js', 'text/javascript'], '/webview.css': ['dist/webview.css', 'text/css'], '/database.js': ['dist/database.js', 'text/javascript'], '/database.css': ['dist/database.css', 'text/css'] };
  const route = routes[req.url];
  if (!route) { res.writeHead(404); res.end('Not found'); return; }
  try { res.writeHead(200, { 'Content-Type': route[1] }); res.end(await readFile(route[0])); }
  catch { res.writeHead(500); res.end('Run npm run build first'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Sheet Studio preview: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void closeDatabasePreview().finally(() => server.close(() => process.exit(0))); });
