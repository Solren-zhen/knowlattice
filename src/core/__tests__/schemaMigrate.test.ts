import { describe, expect, it } from 'vitest';
import {
  BASE_SCHEMA_VERSION,
  MigrationError,
  getSchemaVersion,
  migrationStatus,
  pendingMigrations,
  restoreBackup,
  runMigrations,
  setSchemaVersion,
  targetVersion,
  validateMigrations,
  type Migration,
  type MigrationContext,
  type MigrationRow,
} from '../schemaMigrate';

/** 内存上下文：行为与 IndexedDB 的 meta/store 最小子集一致 */
function memoryContext(stores = ['notes', 'cards']) {
  const data = new Map<string, MigrationRow[]>(stores.map((s) => [s, []]));
  const meta = new Map<string, unknown>();
  const ctx: MigrationContext = {
    stores,
    async getMeta<T>(key: string) {
      return meta.get(key) as T | undefined;
    },
    async setMeta(key, value) {
      meta.set(key, value);
    },
    async all<T = MigrationRow>(store: string) {
      return [...(data.get(store) ?? [])] as T[];
    },
    async put<T extends MigrationRow>(store: string, row: T) {
      const rows = data.get(store) ?? [];
      data.set(store, [...rows.filter((r) => r.id !== row.id), row]);
    },
    async clear(store) {
      data.set(store, []);
    },
  };
  return { ctx, data, meta };
}

const addReps: Migration = {
  from: 1,
  to: 2,
  name: 'cards 补 reps',
  async apply(ctx) {
    for (const card of await ctx.all('cards')) {
      if (typeof card.reps !== 'number') await ctx.put('cards', { ...card, reps: 0 });
    }
  },
};

const boom: Migration = {
  from: 2,
  to: 3,
  name: '会失败的迁移',
  async apply() {
    throw new Error('数据库被锁');
  },
};

describe('schemaMigrate', () => {
  it('未写入版本号时按 1 算', async () => {
    const { ctx } = memoryContext();
    expect(await getSchemaVersion(ctx)).toBe(BASE_SCHEMA_VERSION);
  });

  it('拒绝跳号、重复与非正整数', () => {
    expect(() => validateMigrations([{ from: 1, to: 3, name: '跳号', apply() {} }])).toThrow(/相邻/);
    expect(() => validateMigrations([addReps, { ...addReps, name: '重复' }])).toThrow(/重复/);
    expect(() => validateMigrations([{ from: 0, to: 1, name: '零', apply() {} }])).toThrow(/正整数/);
  });

  it('待跑迁移是按版本相邻链取出来的', () => {
    const list = validateMigrations([addReps, boom]);
    expect(pendingMigrations(list, 1).map((m) => m.name)).toEqual(['cards 补 reps', '会失败的迁移']);
    expect(pendingMigrations(list, 2).map((m) => m.name)).toEqual(['会失败的迁移']);
    expect(pendingMigrations(list, 3)).toEqual([]);
    expect(targetVersion(list)).toBe(3);
  });

  it('成功执行后版本推进，数据被改写', async () => {
    const { ctx, data, meta } = memoryContext();
    await ctx.put('cards', { id: 'c1' });
    const result = await runMigrations(ctx, [addReps], { now: 1000 });
    expect(result).toMatchObject({ from: 1, to: 2, applied: ['cards 补 reps'] });
    expect(meta.get('schema.version')).toBe(2);
    expect(data.get('cards')).toEqual([{ id: 'c1', reps: 0 }]);
    expect(meta.has('schema.backup.1')).toBe(true);
  });

  it('apply 抛错时整库回滚、版本退回，并抛出带迁移名的错误', async () => {
    const { ctx, data, meta } = memoryContext();
    await ctx.put('cards', { id: 'c1', reps: 7 });
    await setSchemaVersion(ctx, 2);
    const before = structuredClone(data.get('cards'));
    await expect(runMigrations(ctx, [addReps, boom], { now: 2000 })).rejects.toBeInstanceOf(MigrationError);
    expect(await getSchemaVersion(ctx)).toBe(2);
    expect(data.get('cards')).toEqual(before);
    expect(meta.has('schema.backup.2')).toBe(true);
    // 失败的那一步不会把版本写到 3
    expect(meta.get('schema.version')).not.toBe(3);
  });

  it('migrationStatus 报告当前版本、目标与待跑项', async () => {
    const { ctx } = memoryContext();
    await setSchemaVersion(ctx, 1);
    const status = await migrationStatus(ctx, [addReps, boom]);
    expect(status).toMatchObject({ version: 1, target: 3 });
    expect(status.pending.map((p) => p.name)).toEqual(['cards 补 reps', '会失败的迁移']);
  });

  it('restoreBackup 能回到某一步之前；不存在的备份返回 false', async () => {
    const { ctx, data } = memoryContext();
    await ctx.put('cards', { id: 'c1' });
    await runMigrations(ctx, [addReps], { now: 3000 });
    expect(data.get('cards')).toEqual([{ id: 'c1', reps: 0 }]);
    expect(await restoreBackup(ctx, 1)).toBe(true);
    expect(data.get('cards')).toEqual([{ id: 'c1' }]);
    expect(await getSchemaVersion(ctx)).toBe(1);
    expect(await restoreBackup(ctx, 99)).toBe(false);
  });
});
