async (page) => {
  const button = name => page.getByRole('button', { name, exact: true });
  const address = page.getByRole('textbox', { name: '单元格地址', exact: true });
  const select = async value => { await address.fill(value); await address.press('Enter'); };
  const size = async (role, name, axis, expected) => {
    await page.waitForFunction(({ role, name, axis, expected }) => {
      const el = [...document.querySelectorAll('[role]')].find(e => e.getAttribute('role') === role && e.getAttribute('aria-label') === name);
      return el && Math.abs(parseFloat(el.style[axis]) - expected) < .02;
    }, { role, name, axis, expected });
  };
  await page.getByRole('rowheader', { name: '6', exact: true }).click();
  await page.getByRole('rowheader', { name: '8', exact: true }).click({ modifiers: ['Shift'] });
  await page.getByRole('rowheader', { name: '7', exact: true }).click({ button: 'right' });
  await page.locator('.context-menu').getByRole('button', { name: '行高…', exact: true }).click();
  await page.getByText('应用于所选 3 行，单位为像素，可输入 20–1000。', { exact: true }).waitFor();
  await page.getByRole('spinbutton').fill('48');
  await button('确定').click();
  for (const name of ['6', '7', '8']) await size('rowheader', name, 'height', 48);
  const rowHandle = await page.getByRole('separator', { name: '调整第 7 行行高', exact: true }).boundingBox();
  await page.mouse.move(rowHandle.x + rowHandle.width / 2, rowHandle.y + rowHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowHandle.x + rowHandle.width / 2, rowHandle.y + rowHandle.height / 2 + 12, { steps: 5 });
  for (const name of ['6', '7', '8']) await size('rowheader', name, 'height', 60);
  await page.getByText('行高 60 px · 3 行', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/row-resize-preview.png' });
  await page.mouse.up();
  await button('撤销 (Ctrl+Z)').click();
  for (const name of ['6', '7', '8']) await size('rowheader', name, 'height', 48);
  await page.getByRole('columnheader', { name: 'B', exact: true }).click();
  await page.getByRole('columnheader', { name: 'D', exact: true }).click({ modifiers: ['Shift'] });
  const colHandle = await page.getByRole('separator', { name: '调整 C 列列宽', exact: true }).boundingBox();
  await page.mouse.move(colHandle.x + colHandle.width / 2, colHandle.y + colHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(colHandle.x + colHandle.width / 2 + 30, colHandle.y + colHandle.height / 2, { steps: 5 });
  for (const name of ['B', 'C', 'D']) await size('columnheader', name, 'width', 196);
  await page.mouse.up();
  await button('撤销 (Ctrl+Z)').click();
  for (const name of ['B', 'C', 'D']) await size('columnheader', name, 'width', 166.25);
  const cancelHandle = await page.getByRole('separator', { name: '调整第 2 行行高', exact: true }).boundingBox();
  await page.mouse.move(cancelHandle.x + 10, cancelHandle.y + 2);
  await page.mouse.down();
  await page.mouse.move(cancelHandle.x + 10, cancelHandle.y + 22);
  await size('rowheader', '2', 'height', 68);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await size('rowheader', '2', 'height', 48);
  console.log('PASS precise dimensions, batch input and drag, live preview, undo/redo, input bounds, Shift header selection, context menu and Escape cancellation');
}
