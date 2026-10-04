/**
 * 存储适配器接口 —— 晶格 · KnowLattice 的核心抽象。
 *
 * 设计原则：
 * - 开发期在浏览器里跑（IndexedDB），写完核心逻辑再接 Tauri fs，前端代码零改动
 * - 所有路径使用 POSIX 风格的 vault 相对路径，如 "01-生理学/05-呼吸/肺牵张反射.md"
 */

export interface VaultFileMeta {
  /** vault 相对路径，如 "01-生理学/05-呼吸/氧解离曲线.md" */
  path: string;
  /** 最后修改时间 (ms) */
  mtime: number;
  size: number;
}

export interface StorageAdapter {
  readonly name: string;
  listAll(): Promise<VaultFileMeta[]>;
  /** 一次读出全部笔记 {path → content}；适配器可实现单遍优化（IndexedDB getAll）。
   *  仅应包含可序列化为字符串的文件（.md 笔记）；二进制附件走 readAllAttachments。 */
  readAll(): Promise<Map<string, string>>;
  read(path: string): Promise<string>;
  /** 该路径在存储层是否已存在。新建笔记前用它兜底查重：
   *  内存索引可能因加载失败而残缺，光看内存会把磁盘上已有的笔记当成新笔记覆盖掉。 */
  exists(path: string): Promise<boolean>;
  /** 单路径的元信息，**不存在返回 null**（新建笔记是正常路径，不是错误）。
   *  写盘前用它比对 mtime：磁盘上的 mtime 与我们记录的不一致，说明这个文件在应用
   *  之外被改过（外部编辑器 / 另一个窗口 / 同步盘），此时必须先留档再覆盖。 */
  stat(path: string): Promise<Omit<VaultFileMeta, 'path'> | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** 批量写入（可选优化）：适配器可实现为「一批一个事务」合批提交（IndexedDB 下
   *  比「一文件一事务」快一个数量级）。未实现时调用方自动退回逐条 write。 */
  writeMany?(entries: Array<{ path: string; content: string }>): Promise<void>;
  /** 批量删除（可选优化）：同 writeMany，未实现时退回逐条 remove。 */
  removeMany?(paths: string[]): Promise<void>;
  /** 一次读出全部二进制附件 {path → Blob}。Blob 是惰性句柄，不会把全部字节读进内存。 */
  readAllAttachments(): Promise<Map<string, Blob>>;
  writeAttachment(path: string, blob: Blob): Promise<void>;
  removeAttachment(path: string): Promise<void>;
  /** 附件路径是否已存在（覆盖性导入前查重用；与 exists 的笔记版对应）。 */
  existsAttachment(path: string): Promise<boolean>;
}
