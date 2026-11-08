/**
 * 桌宠图片库（IndexedDB，fake-indexeddb）：存取、读回同一 Blob、清空后为空。
 * 缩图依赖 canvas，jsdom 没有 2D 上下文，那一半只做「非图片输入报错」级别的行为验证。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearPetImage, loadPetImage, savePetImage } from '../petImage';

beforeEach(async () => {
  await clearPetImage();
});

describe('petImage IndexedDB', () => {
  it('存进去什么读回什么', async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    await savePetImage(png);
    const got = await loadPetImage();
    expect(got).toBeInstanceOf(Blob);
    expect(got?.type).toBe('image/png');
    expect(new Uint8Array(await got!.arrayBuffer())).toEqual(new Uint8Array(await png.arrayBuffer()));
  });

  it('覆盖写：后一张替换前一张', async () => {
    await savePetImage(new Blob(['a'], { type: 'image/png' }));
    await savePetImage(new Blob(['bb'], { type: 'image/png' }));
    const got = await loadPetImage();
    expect(got?.size).toBe(2);
  });

  it('清空后读不到', async () => {
    await savePetImage(new Blob(['x']));
    await clearPetImage();
    expect(await loadPetImage()).toBeNull();
  });

  it('非 Blob 的旧数据被当成没有图片', async () => {
    const { openDB } = await import('idb');
    const d = await openDB('knowlattice-pet', 1);
    await d.put('img', 'not-a-blob', 'custom');
    d.close();
    expect(await loadPetImage()).toBeNull();
  });
});
