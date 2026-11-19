import { applyOperation, blankWorkbook, inputCell, key, type Workbook, type Operation } from '../src/model';
import { normalizeBackground } from '../src/appearance';
declare global { function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): any; setState(state: any): void } }
export function demoWorkbook(): Workbook {
  const workbook = blankWorkbook('项目预算.xlsx');
  const sheet = workbook.sheets[0]; sheet.name = '项目明细'; sheet.frozenRows = 1;
  sheet.columnWidths = { 0: 150, 1: 150, 2: 115, 3: 130, 4: 120, 5: 130, 6: 160 };
  const rows = [
    ['项目名称', '所属团队', '负责人', '预算（元）', '完成进度', '实际支出（元）', '剩余预算（元）'],
    ['产品官网改版', '设计团队', '林晓', 68000, 0.85, 52600, '=D2-F2'],
    ['移动端体验优化', '产品团队', '陈晨', 42000, 0.6, 23800, '=D3-F3'],
    ['数据看板', '研发团队', '张远', 95000, 0.72, 67400, '=D4-F4'],
    ['品牌视觉升级', '设计团队', '林晓', 36000, 1, 34200, '=D5-F5'],
    ['用户增长实验', '运营团队', '周宁', 28000, 0.35, 9600, '=D6-F6'],
    ['客户服务平台', '研发团队', '李可', 78000, 0.48, 31000, '=D7-F7'],
    ['内容管理系统', '研发团队', '张远', 56000, 0.9, 49100, '=D8-F8'],
    ['年度用户研究', '产品团队', '陈晨', 24000, 0.55, 11200, '=D9-F9'],
    ['营销自动化', '运营团队', '周宁', 47000, 0.25, 8300, '=D10-F10'],
    ['组件库 2.0', '设计团队', '林晓', 32000, 0.78, 21600, '=D11-F11'],
    ['API 网关升级', '研发团队', '李可', 64000, 0.45, 25200, '=D12-F12'],
    ['多语言支持', '产品团队', '陈晨', 18000, 0.15, 2400, '=D13-F13'],
    ['合计', '', '', '=SUM(D2:D13)', '', '=SUM(F2:F13)', '=SUM(G2:G13)'],
  ];
  rows.forEach((values, r) => values.forEach((v, c) => {
    const cell = typeof v === 'string' ? inputCell(v) : { value: v };
    if (!cell) return;
    cell.style = r === 0 ? { bold: true, background: '#eef5f1', color: '#375b49' } : c === 4 ? { numberFormat: '0%' } : c >= 3 ? { numberFormat: '#,##0', ...(r === 13 ? { bold: true, background: '#f3f6f4' } : {}) } : r === 13 ? { bold: true, background: '#f3f6f4' } : undefined;
    sheet.cells[key(r, c)] = cell;
  }));
  const next = applyOperation(workbook, { type: 'addSheet', name: '使用说明', id: 'guide' });
  next.sheets[1].columnWidths = { 0: 240, 1: 420 };
  [['快捷键', '操作'], ['双击 / F2', '编辑单元格'], ['Ctrl+F / Ctrl+H', '查找 / 替换'], ['Ctrl+C / Ctrl+V', '复制 / 粘贴多单元格'], ['Ctrl+D / Ctrl+R', '向下 / 向右填充'], ['Ctrl+S', '保存文件'], ['Ctrl+Z / Ctrl+Y', '撤销 / 重做']].forEach((row, r) => row.forEach((value, c) => next.sheets[1].cells[key(r, c)] = { value }));
  return next;
}
export const isPreview = typeof acquireVsCodeApi !== 'function';
const api = isPreview ? undefined : acquireVsCodeApi();
let demo = demoWorkbook();
const history: Workbook[] = [], redo: Workbook[] = [];
function previewBackground() {
  try { return normalizeBackground(localStorage.getItem('sheetStudio.backgroundColor')); } catch { return normalizeBackground(null); }
}
export const bridge = {
  state: () => api?.getState(),
  remember: (state: any) => api?.setState(state),
  post: (message: any) => {
    if (api) { api.postMessage(message); return; }
    const emit = (extra: any = {}) => setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', workbook: demo, ...extra } })), 0);
    if (message.type === 'ready') {
      emit();
      setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'appearance', backgroundColor: previewBackground() } })), 0);
    }
    if (message.type === 'setAppearance') {
      const backgroundColor = normalizeBackground(message.backgroundColor);
      try { localStorage.setItem('sheetStudio.backgroundColor', backgroundColor); } catch { /* Preview storage can be unavailable in private browsing. */ }
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'appearance', backgroundColor } }));
    }
    if (message.type === 'edit') {
      try {
        history.push(demo); redo.length = 0;
        demo = applyOperation(demo, message.operation as Operation);
        emit({ ack: message.sequence, clientId: message.clientId });
      } catch (error) {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', workbook: demo, ack: message.sequence, message: String(error) } }));
      }
    }
    if (message.type === 'undo' && history.length) { redo.push(demo); demo = history.pop()!; emit(); }
    if (message.type === 'redo' && redo.length) { history.push(demo); demo = redo.pop()!; emit(); }
    if (message.type === 'save') emit({ saved: true });
    if (message.type === 'export') window.dispatchEvent(new MessageEvent('message', { data: { type: 'notice', message: '安装插件后可导出为 XLSX、CSV 或 TSV。' } }));
  },
};
