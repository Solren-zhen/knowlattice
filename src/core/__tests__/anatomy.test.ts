import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAnatomyManifest, loadZhDict, zhOrganName } from '../anatomy';

const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('anatomy/manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: 1,
            gender_model: 'x',
            systems: [],
            attribution: 'Anatria-3D',
            organs: [
              { organ_id: 'F1', ta2_latin: '', name_en: 'Femur', system: 'skeletal', mesh_file: 'f.glb', node: 'n', path: [] },
            ],
          }),
        };
      }
      if (url.endsWith('zh-paths.json')) return { ok: true, status: 200, json: async () => ({ Head: '头部' }) };
      if (url.endsWith('zh-organs-a.json')) return { ok: true, status: 200, json: async () => ({ Femur: '股骨' }) };
      if (url.endsWith('zh-organs-b.json')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadAnatomyManifest', () => {
  it('加载并缓存 manifest（重复调用只 fetch 一次）', async () => {
    const m = await loadAnatomyManifest();
    expect(m.organs[0].name_en).toBe('Femur');
    expect(await loadAnatomyManifest()).toBe(m);
    expect(calls.filter((u) => u.includes('manifest.json'))).toHaveLength(1);
  });
});

describe('loadZhDict', () => {
  it('合并分批词典，缺失文件跳过', async () => {
    const dict = await loadZhDict();
    expect(dict.organs.get('Femur')).toBe('股骨');
    expect(dict.paths.get('Head')).toBe('头部');
    await loadZhDict();
    expect(calls.filter((u) => u.includes('zh-organs-a.json'))).toHaveLength(1);
  });
});

describe('zhOrganName', () => {
  const organs = new Map([
    ['Femur', '股骨'],
    ['Heart', '心脏'],
  ]);

  it('精确命中直接返回中文', () => {
    expect(zhOrganName('Femur', organs)).toBe('股骨');
  });

  it('左右后缀拼成中文括注（大小写不敏感）', () => {
    expect(zhOrganName('Femur (left)', organs)).toBe('股骨（左）');
    expect(zhOrganName('Femur (RIGHT)', organs)).toBe('股骨（右）');
  });

  it('未命中返回 null（调用方回退显示英文）', () => {
    expect(zhOrganName('Unknown', organs)).toBeNull();
    expect(zhOrganName('Unknown (left)', organs)).toBeNull();
  });
});
