/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearLocalVideoHandles,
  openLocalVideoFromHandle,
  pickLocalVideoWithHandle,
  removeLocalVideoHandle,
  supportsLocalVideoPicker,
} from '../videoHandles';

afterEach(() => {
  delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  vi.restoreAllMocks();
});

describe('videoHandles', () => {
  it('浏览器不支持 showOpenFilePicker 时安全返回 unsupported', async () => {
    expect(supportsLocalVideoPicker()).toBe(false);
    expect(await pickLocalVideoWithHandle()).toBe('unsupported');
  });

  it('用户取消文件选择返回 null，选中则返回 file 与 handle', async () => {
    const abortErr = new DOMException('cancelled', 'AbortError');
    (window as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker =
      vi.fn().mockRejectedValueOnce(abortErr);
    expect(await pickLocalVideoWithHandle()).toBeNull();

    const file = new File(['abc'], 'lecture.mp4', { type: 'video/mp4' });
    const handle = { getFile: vi.fn(async () => file) };
    (window as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker =
      vi.fn().mockResolvedValueOnce([handle]);
    expect(supportsLocalVideoPicker()).toBe(true);
    expect(await pickLocalVideoWithHandle()).toEqual({ file, handle });
  });

  it('缺失句柄时 openLocalVideoFromHandle 返回 null 且删除/清空不抛错', async () => {
    expect(await openLocalVideoFromHandle('missing.mp4|1|1')).toBeNull();
    await expect(removeLocalVideoHandle('missing.mp4|1|1')).resolves.toBeUndefined();
    await expect(clearLocalVideoHandles()).resolves.toBeUndefined();
  });
});
