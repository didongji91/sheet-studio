async (page) => {
  await page.reload();
  await page.getByRole('grid', { name: '项目明细', exact: true }).waitFor();
  const button = name => page.getByRole('button', { name, exact: true });
  await button('视图').click();
  const background = async color => {
    await page.waitForFunction(color => getComputedStyle(document.querySelector('main')).backgroundColor === color, color);
  };
  const preset = page.getByRole('combobox', { name: '背景预设', exact: true });
  const hex = page.getByRole('textbox', { name: '背景色值', exact: true });
  await button('重置').click();
  await page.evaluate(() => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-editor-background', '#550000');
    document.body.style.setProperty('--vscode-editor-foreground', '#00ff00');
  });
  await background('rgb(255, 255, 255)');
  await preset.selectOption('#1e2521');
  await background('rgb(30, 37, 33)');
  await page.getByRole('gridcell', { name: 'A2 产品官网改版', exact: true }).evaluate(el => {
    if (getComputedStyle(el).backgroundColor !== 'rgb(30, 37, 33)') throw new Error('Blank cell fill must use the editor background');
    if (getComputedStyle(el).color !== 'rgb(237, 246, 239)') throw new Error('Dark background must use readable text');
  });
  await page.evaluate(() => document.body.className = 'vscode-light');
  await background('rgb(30, 37, 33)');
  await page.screenshot({ path: 'output/playwright/independent-dark.png' });
  await preset.selectOption('#fff9ed');
  await background('rgb(255, 249, 237)');
  await preset.selectOption('#eef6f0');
  await background('rgb(238, 246, 240)');
  await hex.fill('#CABDEF');
  await hex.press('Enter');
  await background('rgb(202, 189, 239)');
  if (await hex.inputValue() !== '#cabdef') throw new Error('Custom hex was not normalized');
  await hex.fill('invalid');
  await hex.press('Enter');
  await background('rgb(202, 189, 239)');
  if (await hex.inputValue() !== '#cabdef') throw new Error('Invalid color must restore the saved color');
  await page.getByRole('textbox', { name: '背景颜色', exact: true }).fill('#203550');
  await background('rgb(32, 53, 80)');
  await page.evaluate(() => document.body.className = 'vscode-high-contrast');
  await background('rgb(32, 53, 80)');
  if (!await page.getByText('已保存到本地', { exact: false }).isVisible()) throw new Error('Appearance changes dirtied the workbook');
  await page.reload();
  await page.getByRole('grid', { name: '项目明细', exact: true }).waitFor();
  await background('rgb(32, 53, 80)');
  await button('视图').click();
  if (await page.getByRole('textbox', { name: '背景色值', exact: true }).inputValue() !== '#203550') throw new Error('Background preference did not survive a reload');
  await button('开始').click();
  await page.getByRole('gridcell', { name: 'B2 设计团队', exact: true }).click();
  await page.getByRole('textbox', { name: '填充颜色', exact: true }).fill('#ffcc00');
  await button('视图').click();
  await page.getByRole('textbox', { name: '背景色值', exact: true }).fill('#fff9ed');
  await page.getByRole('textbox', { name: '背景色值', exact: true }).press('Enter');
  await page.getByRole('gridcell', { name: 'B2 设计团队', exact: true }).evaluate(el => {
    if (getComputedStyle(el).backgroundColor !== 'rgb(255, 204, 0)') throw new Error('Editor background overwrote a cell fill');
  });
  await page.getByRole('textbox', { name: '单元格地址', exact: true }).fill('B2:D4');
  await page.getByRole('textbox', { name: '单元格地址', exact: true }).press('Enter');
  await button('行高…').click();
  await page.getByRole('spinbutton').fill('46');
  await button('确定').click();
  await page.screenshot({ path: 'output/playwright/custom-background.png' });
  await page.setViewportSize({ width: 800, height: 650 });
  await page.screenshot({ path: 'output/playwright/custom-background-compact.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('PASS independent light/dark/custom backgrounds, presets, picker, input validation, theme switching, preference persistence, clean workbook and independent cell fills');
}
