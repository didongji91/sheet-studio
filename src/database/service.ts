import type { BrowseOptions, DbDriver, DbObject, DbValue, RowChange, TableDetail, TablePage } from './types';
import { nativeValue, objectName, placeholder, quoteIdentifier } from './sql';

export async function browse(driver: DbDriver, object: DbObject, options: BrowseOptions = {}): Promise<TablePage> {
  const detail = await driver.describe(object),
    kind = driver.kind;
  const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 100))),
    offset = Math.max(0, Math.floor(options.offset ?? 0));
  if (!Number.isFinite(limit) || !Number.isFinite(offset) || offset > 1e12) throw new Error('分页参数无效。');
  const params: DbValue[] = [],
    names = new Set(detail.columns.map((c) => c.name));
  const bind = (value: DbValue) => {
    const mark = placeholder(kind, params.length);
    params.push(value);
    return mark;
  };
  let condition = '';
  const operator = options.filterOperator ?? 'contains';
  if (options.filterColumn && !names.has(options.filterColumn)) throw new Error('筛选列不存在。');
  if (options.sortColumn && !names.has(options.sortColumn)) throw new Error('排序列不存在。');
  if (operator === 'isNull' || operator === 'notNull') {
    if (!options.filterColumn) throw new Error('NULL 筛选请选择具体列。');
    condition = `${quoteIdentifier(kind, options.filterColumn)} IS ${operator === 'notNull' ? 'NOT ' : ''}NULL`;
  } else if (options.search) {
    const columns = options.filterColumn
      ? detail.columns.filter((c) => c.name === options.filterColumn)
      : detail.columns.filter((c) => !/blob|binary|image|bytea/i.test(c.type));
    condition =
      columns
        .map((c) => {
          const column = quoteIdentifier(kind, c.name);
          const text =
            kind === 'mssql'
              ? `CAST(${column} AS NVARCHAR(MAX))`
              : kind === 'mysql' || kind === 'mariadb'
                ? `CAST(${column} AS CHAR)`
                : `CAST(${column} AS TEXT)`;
          return operator === 'equals'
            ? `${text} = ${bind(options.search!)}`
            : `${text} LIKE ${bind('%' + options.search!.replace(/[!%_[]/g, (match) => '!' + match) + '%')} ESCAPE '!'`;
        })
        .join(' OR ') || '1 = 0';
  }
  const where = condition ? ` WHERE (${condition})` : '',
    table = objectName(kind, object);
  const countResult = (await driver.query(`SELECT COUNT(*) AS count FROM ${table}${where}`, params, 1))[0];
  const total = Number(countResult?.rows[0]?.[0] ?? 0);
  const projection = detail.columns.map((c) => quoteIdentifier(kind, c.name));
  let identityProjection = '';
  if (detail.rowidAlias)
    identityProjection = `${quoteIdentifier(kind, detail.rowidAlias)} AS ${quoteIdentifier(kind, '__sheet_studio_rowid__')}, `;
  const defaultSort = detail.identityColumns.length
    ? detail.identityColumns
    : detail.columns.slice(0, 1).map((c) => c.name);
  const sort = options.sortColumn ? [options.sortColumn] : defaultSort;
  const order = sort.length
    ? ` ORDER BY ${sort.map((c) => quoteIdentifier(kind, c)).join(', ')}${options.descending ? ' DESC' : ''}`
    : '';
  const pagination =
    kind === 'mssql' ? ` OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY` : ` LIMIT ${limit} OFFSET ${offset}`;
  const result = (
    await driver.query(
      `SELECT ${identityProjection}${projection.join(', ')} FROM ${table}${where}${order}${pagination}`,
      params,
      limit,
    )
  )[0];
  if (!result) throw new Error('数据库未返回结果。');
  const rows = detail.rowidAlias ? result.rows.map((row) => row.slice(1)) : result.rows;
  const identities = detail.rowidAlias
    ? result.rows.map((row) => [row[0]])
    : rows.map((row) => detail.identityColumns.map((name) => row[detail.columns.findIndex((c) => c.name === name)]));
  return { ...result, columns: detail.columns.map((c) => c.name), rows, identities, detail, total, offset, limit };
}

function whereOriginal(driver: DbDriver, detail: TableDetail, change: RowChange, params: DbValue[]): string {
  if (
    !detail.identityColumns.length ||
    !change.identity ||
    change.identity.length !== detail.identityColumns.length ||
    !change.original ||
    change.original.length !== detail.columns.length
  )
    throw new Error('此行缺少主键或原始数据，不能安全更新。');
  const terms: string[] = [];
  const compare = (name: string, value: DbValue) => {
    if (value === null) return `${quoteIdentifier(driver.kind, name)} IS NULL`;
    nativeValue(value);
    const parameter = placeholder(driver.kind, params.length);
    params.push(value);
    return `${quoteIdentifier(driver.kind, name)} = ${parameter}`;
  };
  detail.identityColumns.forEach((name, index) => terms.push(compare(name, change.identity![index])));
  detail.columns.forEach((column, index) => {
    if (
      detail.identityColumns.includes(column.name) ||
      /blob|binary|image|bytea|xml|json/i.test(column.type) ||
      (driver.kind === 'mssql' && /^(?:text|ntext)$/i.test(column.type))
    )
      return;
    terms.push(compare(column.name, change.original![index]));
  });
  return terms.join(' AND ');
}
export async function applyRowChanges(
  driver: DbDriver,
  object: DbObject,
  changes: RowChange[],
  existingTransaction = false,
): Promise<number> {
  if (!Array.isArray(changes) || !changes.length || changes.length > 5000) throw new Error('一次提交须为 1–5000 行。');
  const detail = await driver.describe(object);
  if (detail.object.type !== 'table') throw new Error('视图结果仅供查看，请使用 SQL 修改对应基础表。');
  const columns = new Map(detail.columns.map((c) => [c.name, c]));
  const savepoint = driver.kind === 'mssql' ? 'SAVE TRANSACTION sheet_studio_grid' : 'SAVEPOINT sheet_studio_grid';
  if (existingTransaction) await driver.query(savepoint);
  else await driver.begin();
  let count = 0;
  try {
    for (const change of changes) {
      if (!['insert', 'update', 'delete'].includes(change.type)) throw new Error('行操作无效。');
      const params: DbValue[] = [],
        table = objectName(driver.kind, object);
      let sql: string;
      const entries = Object.entries(change.values ?? {});
      for (const [name, value] of entries) {
        const column = columns.get(name);
        if (!column || column.generated) throw new Error(`列 ${name} 不存在或由数据库自动生成。`);
        nativeValue(value);
      }
      if (change.type === 'insert') {
        if (!entries.length)
          sql =
            driver.kind === 'mysql' || driver.kind === 'mariadb'
              ? `INSERT INTO ${table} () VALUES ()`
              : `INSERT INTO ${table} DEFAULT VALUES`;
        else
          sql = `INSERT INTO ${table} (${entries.map(([name]) => quoteIdentifier(driver.kind, name)).join(', ')}) VALUES (${entries
            .map(([, value]) => {
              const mark = placeholder(driver.kind, params.length);
              params.push(value);
              return mark;
            })
            .join(', ')})`;
      } else if (change.type === 'update') {
        if (!entries.length) continue;
        const set = entries
          .map(([name, value]) => {
            const mark = placeholder(driver.kind, params.length);
            params.push(value);
            return `${quoteIdentifier(driver.kind, name)} = ${mark}`;
          })
          .join(', ');
        sql = `UPDATE ${table} SET ${set} WHERE ${whereOriginal(driver, detail, change, params)}`;
      } else sql = `DELETE FROM ${table} WHERE ${whereOriginal(driver, detail, change, params)}`;
      const result = await driver.query(sql, params);
      const affected = result.reduce((n, set) => n + set.affectedRows, 0);
      if (change.type !== 'insert' && affected !== 1)
        throw new Error('记录已改变、已删除或不再唯一。整批修改已回滚，请刷新后重试。');
      count += affected;
    }
    if (existingTransaction) {
      if (driver.kind !== 'mssql') await driver.query('RELEASE SAVEPOINT sheet_studio_grid');
    } else await driver.commit();
    return count;
  } catch (error) {
    if (existingTransaction) {
      await driver
        .query(
          driver.kind === 'mssql'
            ? 'ROLLBACK TRANSACTION sheet_studio_grid'
            : 'ROLLBACK TO SAVEPOINT sheet_studio_grid',
        )
        .catch(() => {});
      if (driver.kind !== 'mssql') await driver.query('RELEASE SAVEPOINT sheet_studio_grid').catch(() => {});
    } else await driver.rollback().catch(() => {});
    throw error;
  }
}
