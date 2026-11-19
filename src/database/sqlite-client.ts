import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

export interface SqliteResponse<T> {
  result: T;
  change?: { before: Uint8Array; after: Uint8Array };
}
export class SqliteClient {
  private worker?: Worker;
  private ready?: Promise<Worker>;
  private startup?: { reject: (error: Error) => void; timer: NodeJS.Timeout };
  private serial = 0;
  private closed = false;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    private directory: string,
    private stable: Uint8Array,
    private timeoutMs = 30000,
  ) {}
  private start() {
    if (this.closed) throw new Error('数据库已关闭。');
    if (this.ready) return this.ready;
    const worker = (this.worker = new Worker(join(this.directory, 'sqlite-worker.cjs'), {
      workerData: { bytes: this.stable, wasmPath: join(this.directory, 'sql-wasm.wasm') },
    }));
    this.ready = new Promise<Worker>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.cancel('SQLite 初始化超时。');
      }, 15000);
      this.startup = { reject, timer };
      worker.on('message', (response) => {
        if (this.worker !== worker) return;
        if (response.ready) {
          clearTimeout(timer);
          this.startup = undefined;
          resolve(worker);
          return;
        }
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) pending.reject(new Error(response.error));
        else {
          if (response.change) this.stable = response.change.after;
          pending.resolve(response);
        }
      });
      worker.on('error', (error) => {
        if (this.worker === worker) this.fail(error);
      });
      worker.on('exit', () => {
        if (this.worker === worker) this.fail(new Error('SQLite 工作进程已退出，请重试。'));
      });
    });
    return this.ready;
  }
  private fail(error: Error) {
    if (this.startup) {
      clearTimeout(this.startup.timer);
      this.startup.reject(error);
      this.startup = undefined;
    }
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    this.worker = undefined;
    this.ready = undefined;
  }
  async call<T>(action: string, args: Record<string, unknown> = {}): Promise<SqliteResponse<T>> {
    const worker = await this.start();
    if (worker !== this.worker) throw new Error('查询已取消，上次完成的修改仍保留。');
    const id = ++this.serial;
    const result = await new Promise<SqliteResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.cancel('查询超时，操作已取消；上次完成的修改仍保留。');
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, action, args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
    if (action === 'restore') this.stable = args.bytes as Uint8Array;
    else if (action === 'image') this.stable = result.result as Uint8Array;
    return result;
  }
  async cancel(message = '查询已取消，上次完成的修改仍保留。') {
    const worker = this.worker;
    this.fail(new Error(message));
    await worker?.terminate();
  }
  async close() {
    this.closed = true;
    await this.cancel('数据库已关闭。');
  }
}
