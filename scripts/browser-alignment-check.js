async (page) => {
  await page.reload();
  await page.evaluate(() => {
    window.addEventListener('message', event => {
      if (event.data.type === 'state' && event.data.workbook) window.__alignmentLastState = event.data;
    });
  });
  const button = name => page.getByRole('button', { name, exact: true });
  const address = page.getByRole('textbox', { name: '单元格地址', exact: true });
  const select = async value => { await address.fill(value); await address.press('Enter'); };
  const put = async (target, value) => {
    await select(target);
    const formula = page.getByRole('textbox', { name: '公式栏', exact: true });
    await formula.fill(value); await formula.press('Enter');
    await page.getByRole('gridcell', { name: `${target} ${value}`, exact: true }).waitFor();
  };
  const size = async (axis, value) => {
    await button('视图').click();
    await button(axis === 'row' ? '行高…' : '列宽…').click();
    await page.getByRole('spinbutton').fill(String(value));
    await button('确定').click();
    await button('开始').click();
  };
  const metrics = target => page.locator(`[data-address="${target}"]`).evaluate(cell => {
    const content = cell.querySelector('.cell-value');
    const rect = cell.getBoundingClientRect(), text = content.getBoundingClientRect();
    return {
      top: text.top - rect.top, bottom: rect.bottom - text.bottom,
      center: (text.top + text.bottom - rect.top - rect.bottom) / 2,
      height: rect.height, textHeight: text.height,
      fontSize: parseFloat(getComputedStyle(content).fontSize),
      align: getComputedStyle(cell).textAlign,
      whiteSpace: getComputedStyle(cell).whiteSpace,
    };
  });
  const waitAlignment = value => page.waitForFunction(value =>
    document.querySelector('[data-address="A1"]')?.style.justifyContent === value, value);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await button('新增工作表').click();
  await page.getByRole('grid', { name: 'Sheet1', exact: true }).waitFor();
  await put('A1', '2025级（上）《物理实验》课表（第1轮）');
  await select('A1:I1');
  await button('合并单元格').click();
  await button('居中').click();
  await button('加粗').click();
  await page.getByRole('combobox', { name: '字号', exact: true }).selectOption('24');
  await size('row', 177);
  await size('column', 218);
  await button('垂直居中').click();
  let measured = await metrics('A1');
  check(Math.abs(measured.center) < 1, `Merged title is not centered: ${JSON.stringify(measured)}`);
  check(measured.height === 177 && measured.fontSize === 32 && measured.textHeight >= 32, 'Large title was clipped or row height changed');
  check(measured.align === 'center', 'Horizontal centering was lost');

  const headers = ['周次', '58努', '杨氏模量', '多普勒效应', '声速测量', '莫尔效应', '导热系数', '红外光电器件（已排）', '理想气体'];
  const rooms = ['', '', '601', '604', '612', '607', '605', '608', '603'];
  for (let index = 0; index < headers.length; index++) {
    const column = String.fromCharCode(65 + index);
    await put(`${column}2`, headers[index]);
    if (rooms[index]) await put(`${column}3`, rooms[index]);
  }
  await select('A2:I3'); await button('居中').click(); await button('垂直居中').click();
  await select('A2:I2'); await button('加粗').click(); await size('row', 42);
  await select('A1');
  await page.screenshot({ path: 'output/playwright/alignment-timetable.png' });
  await button('顶端对齐').click();
  measured = await metrics('A1');
  check(Math.abs(measured.top - 5) < 1, 'Top alignment is incorrect');
  await button('底端对齐').click();
  measured = await metrics('A1');
  check(Math.abs(measured.bottom - 6) < 1, 'Bottom alignment is incorrect');
  await button('撤销 (Ctrl+Z)').click();
  await waitAlignment('flex-start');
  check(Math.abs((await metrics('A1')).top - 5) < 1, 'Undo did not restore top alignment');
  await button('重做 (Ctrl+Y)').click();
  await waitAlignment('flex-end');
  check(Math.abs((await metrics('A1')).bottom - 6) < 1, 'Redo did not restore bottom alignment');
  await button('垂直居中').click();

  await put('A5', '这是用于检查自动换行与垂直居中的长文本，超过一行后也要保持在合并区域中央，不能被标题选区或边框裁掉。');
  await select('A5:C5'); await button('合并单元格').click();
  await button('自动换行').click(); await button('居中').click(); await button('垂直居中').click();
  await page.getByRole('combobox', { name: '字号', exact: true }).selectOption('24');
  await size('row', 150);
  measured = await metrics('A5');
  check(Math.abs(measured.center) < 1 && measured.textHeight > 60, 'Wrapped multi-line text is not centered');
  await select('A1');
  await page.setViewportSize({ width: 900, height: 700 });
  check(Math.abs((await metrics('A1')).center) < 1, 'Merged title shifted vertically in a narrow viewport');
  await page.setViewportSize({ width: 2026, height: 1000 });
  const replayState = () => page.evaluate(async () => {
    if (!window.__alignmentLastState) throw new Error('No host state was captured');
    const state = structuredClone(window.__alignmentLastState);
    delete state.ack; delete state.clientId;
    window.dispatchEvent(new MessageEvent('message', { data: state }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await address.fill('A8');
  await replayState();
  check(await address.inputValue() === 'A8', 'A host update replaced the address being typed');
  await address.press('Enter');
  const formula = page.getByRole('textbox', { name: '公式栏', exact: true });
  await formula.fill('尚未提交的公式栏草稿');
  await replayState();
  check(await formula.inputValue() === '尚未提交的公式栏草稿', 'A host update replaced the formula draft');
  await formula.press('Enter');
  await page.getByRole('gridcell', { name: 'A8 尚未提交的公式栏草稿', exact: true }).waitFor();
  await page.getByRole('gridcell', { name: 'A1 2025级（上）《物理实验》课表（第1轮）', exact: true }).waitFor();
  console.log('PASS tall merged title alignment, large fonts, unchanged row height, undo/redo, wrapped text and narrow viewport');
  console.log('PASS async host updates preserve address input and formula drafts and commit to the intended cell');
}
