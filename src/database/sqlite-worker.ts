import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { SqliteEngine } from './sqlite';
import { applyRowChanges, browse } from './service';

async function main() {
  const engine = await SqliteEngine.open(workerData.bytes, new Uint8Array(readFileSync(workerData.wasmPath)));
  parentPort!.postMessage({ ready: true });
  let queue = Promise.resolve();
  parentPort!.on('message', (request) => {
    queue = queue.then(async () => {
      let before: Uint8Array | undefined;
      try {
        const { action, args = {} } = request;
        if (action === 'execute' || action === 'changes') before = engine.image();
        let result: unknown;
        if (action === 'catalog') result = await engine.catalog();
        else if (action === 'describe') result = await engine.describe(args.object);
        else if (action === 'page') result = await browse(engine, args.object, args.options);
        else if (action === 'execute') result = await engine.execute(args.sql, args.limit);
        else if (action === 'changes') result = await applyRowChanges(engine, args.object, args.changes);
        else if (action === 'image') result = engine.image();
        else if (action === 'restore') {
          engine.restore(args.bytes);
          result = true;
        } else if (action === 'dump') result = await engine.dump();
        else throw new Error('数据库操作无效。');
        const after = before ? engine.image() : undefined;
        const change =
          before && after && !Buffer.from(before).equals(Buffer.from(after)) ? { before, after } : undefined;
        parentPort!.postMessage({ id: request.id, result, change });
      } catch (error) {
        if (before) engine.restore(before);
        parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}
void main();
