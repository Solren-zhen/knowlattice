/**
 * 生产期存储适配器：Tauri fs（M4 阶段接入）。
 * 目前仅保留接口占位，签名与 WebAdapter 一致，
 * 接入时前端代码零改动。
 */
import type { StorageAdapter, VaultFileMeta } from './adapter';

export class TauriAdapter implements StorageAdapter {
  readonly name = 'tauri-fs';

  /** vault 根目录（接入 Tauri fs 时使用） */
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async listAll(): Promise<VaultFileMeta[]> {
    throw new Error('TauriAdapter 将在 M4 阶段实现');
  }
  async readAll(): Promise<Map<string, string>> {
    throw new Error('TauriAdapter 将在 M4 阶段实现');
  }
  async read(_path: string): Promise<string> {
    throw new Error('TauriAdapter 将在 M4 阶段实现');
  }
  async exists(_path: string): Promise<boolean> {
    throw new Error('TauriAdapter 将在 M4 阶段实现');
  }
  async write(_path: string, _content: string): Promise<void> {
    throw new Error('TauriAdapter 将在 M4 阶段实现');
  }
  async remove(_path: string): Promise<void> {
    throw new Error('TauriAdapter 将在 M4 阶段实现');
  }
  async readAllAttachments(): Promise<Map<string, Blob>> {
    throw new Error('TauriAdapter 将在 M4 阶段实现');
  }
  async writeAttachment(_path: string, _blob: Blob): Promise<void> {
    throw new Error('TauriAdapter 将在 M4 阶段实现');
  }
  async removeAttachment(_path: string): Promise<void> {
    throw new Error('TauriAdapter 将在 M4 阶段实现');
  }
}
