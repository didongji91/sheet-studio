type Message = { type: string; [key: string]: any };
const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
let sequence = 0;
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const listeners = new Set<(message: Message) => void>();
window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'dbResponse') {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error));
    else task.resolve(message.data);
  } else for (const listener of listeners) listener(message);
});
export const dbBridge = {
  preview: !api,
  state() {
    if (api) return api.getState();
    try {
      return JSON.parse(localStorage.getItem('sheetStudio.databaseView') || '{}');
    } catch {
      return {};
    }
  },
  remember(value: unknown) {
    if (api) api.setState(value);
    else
      try {
        localStorage.setItem('sheetStudio.databaseView', JSON.stringify(value));
      } catch {}
  },
  subscribe(callback: (message: Message) => void) {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
  async request<T = any>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = String(++sequence);
    if (!api) {
      const response = await fetch('/api/database' + location.search, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, args }),
      });
      const message = await response.json();
      if (message.state)
        for (const listener of listeners) listener({ type: 'dbState', state: message.state, changed: message.changed });
      if (message.error) throw new Error(message.error);
      return message.data;
    }
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      api.postMessage({ id, action, args });
    });
  },
};
