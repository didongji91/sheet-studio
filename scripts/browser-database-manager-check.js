async (page) => {
  const button = (name) => page.getByRole('button', { name, exact: true });
  const idle = () => page.getByText('就绪', { exact: true }).waitFor();
  await page.goto('http://127.0.0.1:5173/database?mode=manager');
  await page.getByRole('heading', { name: '连接数据，开始查询', exact: true }).waitFor();
  await button('新建数据库连接').click();
  await page.getByLabel('数据库连接名称', { exact: true }).fill('本地 PostgreSQL');
  await page.getByLabel('数据库主机', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('数据库名称', { exact: true }).fill('app_development');
  await page.getByLabel('数据库用户名', { exact: true }).fill('developer');
  await page.getByLabel('数据库密码', { exact: true }).fill('test-secret');
  for (const [kind, port] of [['mysql', '3306'], ['mariadb', '3306'], ['mssql', '1433'], ['postgres', '5432']]) {
    await page.getByLabel('数据库类型', { exact: true }).selectOption(kind);
    if (await page.getByLabel('数据库端口', { exact: true }).inputValue() !== port) throw new Error(kind + ' default port incorrect');
  }
  await page.getByLabel('数据库 TLS', { exact: true }).selectOption('verify');
  await page.screenshot({ path: 'output/playwright/database-connection.png' });
  await page.getByLabel('数据库端口', { exact: true }).fill('1');
  await button('测试连接').click();
  await page.getByRole('alert').filter({ hasText: /ECONNREFUSED|connect/i }).waitFor();
  await idle();
  await button('保存连接').click();
  await page.getByRole('dialog', { name: '数据库连接配置', exact: true }).waitFor({ state: 'detached' });
  const connections = page.getByLabel('选择数据库连接', { exact: true });
  if (!(await connections.innerText()).includes('本地 PostgreSQL')) throw new Error('Saved profile not listed');
  await page.reload();
  await button('编辑连接').waitFor();
  const options = await connections.locator('option').allTextContents();
  if (!options.some((option) => option.includes('本地 PostgreSQL'))) throw new Error('Saved profile did not reload');
  await connections.selectOption({ label: '本地 PostgreSQL · PostgreSQL' });
  await button('编辑连接').click();
  if (await page.getByLabel('数据库密码', { exact: true }).inputValue()) throw new Error('Stored password was exposed to the webview');
  await page.getByLabel('数据库连接名称', { exact: true }).fill('开发数据库');
  await button('保存连接').click();
  await idle();
  await button('连接').click();
  await page.getByRole('alert').filter({ hasText: /ECONNREFUSED|connect/i }).waitFor();
  await idle();
  await button('编辑连接').click();
  await button('删除连接').click();
  await page.getByRole('dialog', { name: '删除此连接配置？', exact: true }).getByRole('button', { name: '确定', exact: true }).click();
  await page.getByRole('dialog', { name: '数据库连接配置', exact: true }).waitFor({ state: 'detached' });
  if ((await connections.innerText()).includes('开发数据库')) throw new Error('Deleted profile is still listed');
  await page.screenshot({ path: 'output/playwright/database-manager.png' });
  console.log('PASS database manager browser: engine defaults, TLS, unavailable connection error, save/reload/edit/delete and password isolation');
}
