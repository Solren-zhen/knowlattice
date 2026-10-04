/**
 * 桌面端存储适配器：Tauri fs 插件，把笔记写成用户磁盘上的真实文件。
 *
 * 两种模式（构造参数决定）：
 * - 默认模式：root = tauriEnv.VAULT_ROOT，相对系统「文档」目录
 *   （<文档>/KnowLattice/**.md、_attachments/**），fs 调用带 baseDir: Document，
 *   作用域由 capabilities/default.json 里的静态 $DOCUMENT/KnowLattice 授权。
 * - 自定义模式：root = 用户通过系统目录选择框选定的绝对路径（vaultFolder.ts 持久化），
 *   fs 调用直接用完整路径（不带 baseDir），作用域由 Rust 端 set_vault_dir 命令
 *   在运行时 allow_directory 授权（见 src-tauri/src/lib.rs）。
 *
 * 设计要点：
 * - fs 插件惰性加载：浏览器构建不带进主包，只有桌面端真正调用时才 import。
 * - 路径安全：所有 vault 相对路径先过 safeRel（拒绝绝对路径与 `..`），fs 插件自身也会
 *   拦截越界访问，两层防护。
 * - 原子写：先写 `<目标>.tmp-xxx` 再 rename 覆盖，进程中断不会留下半截笔记；
 *   平台不支持 rename 时退回直写并清理临时文件。
 */
import type { StorageAdapter, VaultFileMeta } from './adapter';
import { VAULT_ROOT } from './tauriEnv';

/** 惰性加载：整个 fs 插件只在桌面端第一次读写时才进入内存 */
let fsMod: Promise<typeof import('@tauri-apps/plugin-fs')> | null = null;
function fs(): Promise<typeof import('@tauri-apps/plugin-fs')> {
  return (fsMod ??= import('@tauri-apps/plugin-fs'));
}

/** vault 内相对路径规范化：拒绝空路径、绝对路径与 `..` 越界（与 vault.safeVaultPath 同口径） */
function safeRel(path: string): string {
  const p = String(path).replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) throw new Error(`非法 vault 路径：${path}`);
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) throw new Error(`非法 vault 路径：${path}`);
  return parts.join('/');
}

/** 是否为文件系统绝对路径（POSIX 或 Windows 盘符/UNC） */
function isAbsoluteFsPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(p);
}

export class TauriAdapter implements StorageAdapter {
  readonly name = 'tauri-fs';

  /** 默认模式：相对 $DOCUMENT 的根目录名（如 "KnowLattice"）；自定义模式：所选绝对路径。
   *  两种模式下 fs 调用都以 this.root 为路径前缀，读取结果的切片逻辑（root.length+1）共用。 */
  readonly root: string;

  /** 非空 = 自定义模式（用户所选绝对目录），fs 调用不带 baseDir */
  private readonly absDir: string | null;

  constructor(root?: string | null) {
    if (root != null && isAbsoluteFsPath(root)) {
      if (root.includes('\0')) throw new Error(`非法 vault 目录：${root}`);
      this.absDir = root.replace(/\\/g, '/').replace(/\/+$/, '');
      this.root = this.absDir;
    } else {
      this.absDir = null;
      this.root = safeRel(root ?? VAULT_ROOT);
    }
  }

  /** fs 调用选项：默认模式锚定 $DOCUMENT；自定义模式不带 baseDir（绝对路径走运行时作用域） */
  private baseOpts(bd: import('@tauri-apps/plugin-fs').BaseDirectory): { baseDir: typeof bd } | {} {
    return this.absDir ? {} : { baseDir: bd };
  }

  /** vault 相对路径 → fs 插件的目标路径（默认模式相对 $DOCUMENT；自定义模式为完整路径） */
  private target(path: string): string {
    const safe = safeRel(path);
    return this.absDir ? `${this.absDir}/${safe}` : `${this.root}/${safe}`;
  }

  private parentOf(relPath: string): string {
    const i = relPath.lastIndexOf('/');
    return i > 0 ? relPath.slice(0, i) : '';
  }

  private async ensureDir(dirTarget: string): Promise<void> {
    const { mkdir, BaseDirectory } = await fs();
    await mkdir(dirTarget, { ...this.baseOpts(BaseDirectory.Document), recursive: true });
  }

  /** 递归列出目录下的全部文件（返回含 root 前缀的相对路径）。目录不存在时抛错，由调用方兜底。 */
  private async walkFiles(dirTarget: string): Promise<string[]> {
    const { readDir, BaseDirectory } = await fs();
    const out: string[] = [];
    const entries = await readDir(dirTarget, this.baseOpts(BaseDirectory.Document));
    for (const e of entries) {
      const child = `${dirTarget}/${e.name}`;
      if (e.isDirectory) out.push(...(await this.walkFiles(child)));
      else if (e.isFile) out.push(child);
    }
    return out;
  }

  /** 原子写：先写临时文件再 rename 覆盖；rename 不可用时退回直写并清理临时文件。 */
  private async writeAtomic(targetPath: string, data: string | Uint8Array): Promise<void> {
    const { writeTextFile, writeFile, rename, remove, BaseDirectory } = await fs();
    const opts = this.baseOpts(BaseDirectory.Document);
    // rename 的 baseDir 只在默认模式下传：自定义模式是绝对路径，若带 baseDir 会被
    // 按 $DOCUMENT 解析（Rust PathBuf::join 虽然绝对路径会整体替换，但不依赖这个行为）
    const renameOpts = this.absDir
      ? {}
      : { oldPathBaseDir: BaseDirectory.Document, newPathBaseDir: BaseDirectory.Document };
    const dir = this.parentOf(targetPath);
    if (dir) await this.ensureDir(dir);
    const put = (t: string): Promise<void> =>
      typeof data === 'string'
        ? writeTextFile(t, data, opts)
        : writeFile(t, data, opts);
    const tmp = `${targetPath}.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await put(tmp);
    try {
      await rename(tmp, targetPath, renameOpts);
    } catch {
      await put(targetPath);
      await remove(tmp, opts).catch(() => {});
    }
  }

  /** 目录是否真的不存在（区别于「存在但读不动」）。只有前者才算空库。 */
  private async dirMissing(dirTarget: string): Promise<boolean> {
    const { exists, BaseDirectory } = await fs();
    return !(await exists(dirTarget, this.baseOpts(BaseDirectory.Document)));
  }

  async listAll(): Promise<VaultFileMeta[]> {
    const { stat, BaseDirectory } = await fs();
    let files: string[];
    try {
      files = await this.walkFiles(this.root);
    } catch (e) {
      if (await this.dirMissing(this.root)) return []; // 目录不存在 = 新库
      // 目录存在却读不动（权限/IO/同步盘占用）：必须把错误抛出去。
      // 吞成「空库」会让 vault 的加载错误页与迁移守卫（目标非空则不迁移）全部失效，
      // 此后 IndexedDB 快照会无条件覆盖用户磁盘上的真实笔记。
      throw e;
    }
    const metas: VaultFileMeta[] = [];
    for (const rel of files) {
      if (!rel.endsWith('.md')) continue;
      const info = await stat(rel, this.baseOpts(BaseDirectory.Document)).catch(() => null);
      metas.push({
        path: rel.slice(this.root.length + 1),
        mtime: info?.mtime ? info.mtime.getTime() : 0,
        size: info?.size ?? 0,
      });
    }
    return metas;
  }

  async readAll(): Promise<Map<string, string>> {
    const { readTextFile, BaseDirectory } = await fs();
    let files: string[];
    try {
      files = await this.walkFiles(this.root);
    } catch (e) {
      if (await this.dirMissing(this.root)) return new Map(); // 目录不存在 = 新库
      // 同 listAll：读不动必须抛错，交给加载错误页，绝不能伪装成空库。
      throw e;
    }
    const map = new Map<string, string>();
    for (const rel of files) {
      if (!rel.endsWith('.md')) continue; // 附件等二进制不进 docs
      map.set(rel.slice(this.root.length + 1), await readTextFile(rel, this.baseOpts(BaseDirectory.Document)));
    }
    return map;
  }

  async read(path: string): Promise<string> {
    const { readTextFile, BaseDirectory } = await fs();
    return readTextFile(this.target(path), this.baseOpts(BaseDirectory.Document));
  }

  async exists(path: string): Promise<boolean> {
    const { exists, BaseDirectory } = await fs();
    return exists(this.target(path), this.baseOpts(BaseDirectory.Document));
  }

  /** 文件不存在（stat 抛 not found）时返回 null——这是新建笔记的正常路径。
   *  mtime 与 listAll 保持同一口径（毫秒；fs 未给出时记 0）。 */
  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    const { stat, BaseDirectory } = await fs();
    try {
      const info = await stat(this.target(path), this.baseOpts(BaseDirectory.Document));
      return { mtime: info.mtime ? info.mtime.getTime() : 0, size: info.size };
    } catch {
      return null;
    }
  }

  async write(path: string, content: string): Promise<void> {
    await this.writeAtomic(this.target(path), content);
  }

  async remove(path: string): Promise<void> {
    const { remove, BaseDirectory } = await fs();
    await remove(this.target(path), this.baseOpts(BaseDirectory.Document));
  }

  /** fs 无批量事务：逐条写（调用方依赖的「返回失败列表」语义由 vault 的逐条回退保证） */
  async writeMany(entries: Array<{ path: string; content: string }>): Promise<void> {
    for (const e of entries) await this.write(e.path, e.content);
  }

  async removeMany(paths: string[]): Promise<void> {
    for (const p of paths) await this.remove(p);
  }

  async readAllAttachments(): Promise<Map<string, Blob>> {
    const { readFile, BaseDirectory } = await fs();
    const map = new Map<string, Blob>();
    let files: string[];
    try {
      files = await this.walkFiles(this.target('_attachments'));
    } catch (e) {
      if (await this.dirMissing(this.target('_attachments'))) return map; // 没有附件目录 = 无附件
      throw e; // 同 readAll：存在但读不动，抛错而不是当成无附件
    }
    for (const rel of files) {
      const bytes = await readFile(rel, this.baseOpts(BaseDirectory.Document));
      map.set(rel.slice(this.root.length + 1), new Blob([bytes]));
    }
    return map;
  }

  async writeAttachment(path: string, blob: Blob): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await this.writeAtomic(this.target(path), bytes);
  }

  async removeAttachment(path: string): Promise<void> {
    await this.remove(path);
  }

  async existsAttachment(path: string): Promise<boolean> {
    return this.exists(path);
  }
}
