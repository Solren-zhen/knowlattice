/**
 * 版本化数据迁移框架（与具体存储解耦）。
 *
 * 为什么不是「一个 migrate() 里写几个 if」：
 *   - 迁移必须是一条**相邻版本链**（1→2→3…），跳号或重复会让回滚点对不上；
 *   - 每一步之前先把涉及的 store 整库快照进 meta，apply 抛错就写回并把版本号退回；
 *   - 版本号本身也要落盘，否则下次启动不知道从哪继续。
 *
 * 本模块只认一个极小的上下文接口，IndexedDB / 文件库 / 内存都能接。
 * 调用方负责提供 KV 与 store 读写；这里不 import storage/views（架构测试守着）。
 */

export interface MigrationRow {
  id: string;
  [key: string]: unknown;
}

/** 迁移能用的最小存储能力。实现方可以包一层 IndexedDB、文件库或内存 Map。 */
export interface MigrationContext {
  /** 可迁移的 store 名单（顺序无所谓，快照/恢复会遍历它） */
  stores: readonly string[];
  getMeta<T = unknown>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  all<T = MigrationRow>(store: string): Promise<T[]>;
  put<T extends MigrationRow>(store: string, row: T): Promise<void>;
  clear(store: string): Promise<void>;
}

export interface Migration {
  from: number;
  to: number;
  name: string;
  apply(ctx: MigrationContext, now: number): Promise<void> | void;
}

export const SCHEMA_KEY = 'schema.version';
export const BACKUP_PREFIX = 'schema.backup.';
/** 没有版本号的老库按 1 算。 */
export const BASE_SCHEMA_VERSION = 1;

export class MigrationError extends Error {
  readonly migration: Migration;
  readonly cause: unknown;

  constructor(migration: Migration, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`迁移「${migration.name}」失败，已回滚到 v${migration.from}：${reason}`);
    this.name = 'MigrationError';
    this.migration = migration;
    this.cause = cause;
  }
}

/** 相邻链校验：重复起始版本、跳号、非正整数都直接拒绝。 */
export function validateMigrations(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.from - b.from);
  const seen = new Set<number>();
  for (const m of sorted) {
    if (!Number.isInteger(m.from) || !Number.isInteger(m.to) || m.from < BASE_SCHEMA_VERSION) {
      throw new Error('迁移版本号必须是正整数：' + m.name);
    }
    if (m.to !== m.from + 1) throw new Error('迁移必须相邻（from + 1 === to）：' + m.name);
    if (seen.has(m.from)) throw new Error('重复的起始版本 v' + m.from + '（' + m.name + '）');
    seen.add(m.from);
  }
  return sorted;
}

export function pendingMigrations(migrations: readonly Migration[], version: number): Migration[] {
  const sorted = validateMigrations(migrations);
  const out: Migration[] = [];
  let current = version;
  for (;;) {
    const hit = sorted.find((m) => m.from === current);
    if (!hit) break;
    out.push(hit);
    current = hit.to;
  }
  return out;
}

export function targetVersion(migrations: readonly Migration[]): number {
  return validateMigrations(migrations).reduce((max, m) => Math.max(max, m.to), BASE_SCHEMA_VERSION);
}

export async function getSchemaVersion(ctx: MigrationContext): Promise<number> {
  const raw = await ctx.getMeta<unknown>(SCHEMA_KEY);
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : BASE_SCHEMA_VERSION;
}

export async function setSchemaVersion(ctx: MigrationContext, version: number): Promise<void> {
  await ctx.setMeta(SCHEMA_KEY, version);
}

interface BackupDoc {
  version: number;
  at: number;
  stores: Record<string, MigrationRow[]>;
}

async function snapshot(ctx: MigrationContext, stores: readonly string[]): Promise<Record<string, MigrationRow[]>> {
  const snap: Record<string, MigrationRow[]> = {};
  for (const store of stores) snap[store] = await ctx.all<MigrationRow>(store);
  return snap;
}

async function restore(ctx: MigrationContext, snap: Record<string, MigrationRow[]>): Promise<void> {
  for (const [store, rows] of Object.entries(snap)) {
    await ctx.clear(store);
    for (const row of rows) await ctx.put(store, row);
  }
}

export interface MigrationRunResult {
  from: number;
  to: number;
  applied: string[];
  backups: string[];
}

export interface RunOptions {
  now?: number;
  /** 只快照/恢复这些 store；不传用 ctx.stores */
  stores?: readonly string[];
}

/** 顺序执行所有待跑迁移；返回实际步骤与备份 id。 */
export async function runMigrations(
  ctx: MigrationContext,
  migrations: readonly Migration[],
  options: RunOptions = {},
): Promise<MigrationRunResult> {
  const now = options.now ?? Date.now();
  const stores = options.stores ?? ctx.stores;
  const from = await getSchemaVersion(ctx);
  const queue = pendingMigrations(migrations, from);
  const applied: string[] = [];
  const backups: string[] = [];
  let version = from;

  for (const migration of queue) {
    const backupId = BACKUP_PREFIX + version;
    const snap = await snapshot(ctx, stores);
    await ctx.setMeta(backupId, { version, at: now, stores: snap } satisfies BackupDoc);
    backups.push(backupId);
    try {
      await migration.apply(ctx, now);
    } catch (error) {
      await restore(ctx, snap);
      await setSchemaVersion(ctx, version);
      throw new MigrationError(migration, error);
    }
    version = migration.to;
    await setSchemaVersion(ctx, version);
    applied.push(migration.name);
  }

  return { from, to: version, applied, backups };
}

export interface MigrationStatus {
  version: number;
  target: number;
  pending: { from: number; to: number; name: string }[];
}

export async function migrationStatus(
  ctx: MigrationContext,
  migrations: readonly Migration[],
): Promise<MigrationStatus> {
  const version = await getSchemaVersion(ctx);
  return {
    version,
    target: targetVersion(migrations),
    pending: pendingMigrations(migrations, version).map((m) => ({ from: m.from, to: m.to, name: m.name })),
  };
}

/** 手动回退到某个备份（用户点「恢复上一版数据」时用）。 */
export async function restoreBackup(ctx: MigrationContext, version: number): Promise<boolean> {
  const doc = await ctx.getMeta<BackupDoc | undefined>(BACKUP_PREFIX + version);
  if (!doc || typeof doc !== 'object' || !doc.stores) return false;
  await restore(ctx, doc.stores);
  await setSchemaVersion(ctx, doc.version);
  return true;
}
