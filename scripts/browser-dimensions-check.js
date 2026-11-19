async (page) => {
  await page.reload();
  await page.getByRole('grid', { name: '项目明细', exact: true }).waitFor();
  await page.getByRole('button', { name: '视图', exact: true }).click();
  const button = name => page.getByRole('button', { name, exact: true });
  const address = page.getByRole('textbox', { name: '单元格地址', exact: true });
  const select = async value => { await address.fill(value); await address.press('Enter'); };
  const size = async (role, name, axis, expected) => {
    await page.waitForFunction(({ role, name, axis, expected }) => {
      const el = [...document.querySelectorAll('[role]')].find(e => e.getAttribute('role') === role && e.getAttribute('aria-label') === name);
      return el && Math.abs(parseFloat(el.style[axis]) - expected) < .02;
    }, { role, name, axis, expected });
  };
  const setSize = async (axis, value) => {
    await button(axis === 'row' ? '行高…' : '列宽…').click();
    await page.getByRole('spinbutton').fill(String(value));
    await button('确定').click();
  };
  await select('B2');
  await setSize('row', 44.5);
  await size('rowheader', '2', 'height', 44.5);
  await button('撤销 (Ctrl+Z)').click();
  await size('rowheader', '2', 'height', 30);
  await button('重做 (Ctrl+Y)').click();
  await size('rowheader', '2', 'height', 44.5);
  await select('B2:D4');
  await setSize('row', 48);
  for (const name of ['2', '3', '4']) await size('rowheader', name, 'height', 48);
  await size('rowheader', '5', 'height', 30);
  await button('撤销 (Ctrl+Z)').click();
  await size('rowheader', '2', 'height', 44.5);
  await size('rowheader', '3', 'height', 30);
  await size('rowheader', '4', 'height', 30);
  await button('重做 (Ctrl+Y)').click();
  await setSize('column', 166.25);
  for (const name of ['B', 'C', 'D']) await size('columnheader', name, 'width', 166.25);
  await button('撤销 (Ctrl+Z)').click();
  await size('columnheader', 'B', 'width', 150);
  await size('columnheader', 'C', 'width', 115);
  await size('columnheader', 'D', 'width', 130);
  await button('重做 (Ctrl+Y)').click();
  await button('行高…').click();
  for (const value of ['19', '1001']) {
    await page.getByRole('spinbutton').fill(value);
    await button('确定').click();
    if (!await page.getByRole('dialog', { name: '设置行高' }).isVisible()) throw new Error('Invalid dimensions were accepted');
  }
  await page.keyboard.press('Escape');
  console.log('PASS precise row and column dimensions, range batches, one-step undo/redo and numeric input bounds');
}
