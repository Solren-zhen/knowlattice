import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadAnatomyManifest,
  loadZhDict,
  modelLoadHint,
  systemMeshFiles,
  zhOrganName,
  type AnatomyManifest,
  type ManifestOrgan,
} from '../anatomy';

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

describe('modelLoadHint · 模型取不到时说什么', () => {
  // three.js 0.185 的 FileLoader 在非 2xx 时抛 HttpError，并把 Response 挂在 .response 上
  const httpError = (status: number, url: string) => {
    const e = new Error(`fetch for "${url}" responded with ${status}: ${status === 404 ? 'Not Found' : 'err'}`);
    (e as Error & { response?: { status: number } }).response = { status };
    return e;
  };

  it('404 → 说明「没随包提供」并告诉用户别的系统没事、列表还能用', () => {
    const out = modelLoadHint(httpError(404, 'http://127.0.0.1:8790/anatomy/nervous_male.glb'), 'nervous_male.glb');
    expect(out).toContain('nervous_male.glb');
    expect(out).toContain('没有随包提供');
    expect(out).toContain('右侧列表');
    // 不能再把 three.js 的英文原文当成全部内容丢给用户
    expect(out).not.toMatch(/^fetch for/);
  });

  it('response 字段拿不到时退回看消息里的状态码', () => {
    const out = modelLoadHint(new Error('fetch for "x" responded with 404: Not Found'), 'nervous_male.glb');
    expect(out).toContain('没有随包提供');
  });

  it('传输层失败走 netError 的中文提示（这是两回事）', () => {
    const out = modelLoadHint(new TypeError('Failed to fetch'), 'muscular_male.glb');
    expect(out).toContain('连不上本地服务');
    expect(out).not.toContain('没有随包提供');
  });

  it('其它错误原样透出，不被覆盖', () => {
    expect(modelLoadHint(new Error('THREE.GLTFLoader: 解析失败'), 'x.glb')).toBe('THREE.GLTFLoader: 解析失败');
  });
});

describe('systemMeshFiles · 一个系统要用几个模型文件', () => {
  const organ = (system: string, meshFile: string, id: string): ManifestOrgan => ({
    organ_id: id,
    ta2_latin: '',
    name_en: id,
    system,
    mesh_file: meshFile,
    node: id,
    path: [],
  });
  const man = (organs: ManifestOrgan[]): AnatomyManifest => ({
    version: 1,
    gender_model: 'x',
    systems: [],
    organs,
  });

  it('单文件系统：只返回那一个', () => {
    const m = man([
      organ('skeletal', 'skeletal_male.glb', 'F1'),
      organ('skeletal', 'skeletal_male.glb', 'F2'),
    ]);
    expect(systemMeshFiles(m, 'skeletal')).toEqual(['skeletal_male.glb']);
  });

  // 这条是 2026-09-20 那个缺陷的回归测试：digestive/endocrine/respiratory 各有两个文件，
  // 以前只取「第一条 organ 的 mesh_file」，visceral_male.glb 里的 13 个结构永远加载不到。
  it('多文件系统：全部返回、去重，且主文件排在最前（它失败才算整个系统失败）', () => {
    const m = man([
      organ('endocrine', 'endocrine_male.glb', 'A'),
      organ('endocrine', 'visceral_male.glb', 'B'),
      organ('endocrine', 'endocrine_male.glb', 'C'),
      organ('endocrine', 'visceral_male.glb', 'D'),
    ]);
    expect(systemMeshFiles(m, 'endocrine')).toEqual(['endocrine_male.glb', 'visceral_male.glb']);
  });

  it('只认自己系统的 organs，不串到别的系统', () => {
    const m = man([organ('renal', 'renal_male.glb', 'R'), organ('skeletal', 'skeletal_male.glb', 'S')]);
    expect(systemMeshFiles(m, 'renal')).toEqual(['renal_male.glb']);
  });

  it('manifest 里没有该系统时回退到 <system>_male.glb（与旧行为一致）', () => {
    expect(systemMeshFiles(man([]), 'nervous')).toEqual(['nervous_male.glb']);
  });

  it('mesh_file 为空时不产生一个坏 URL', () => {
    const m = man([organ('renal', '', 'R'), organ('renal', 'renal_male.glb', 'R2')]);
    expect(systemMeshFiles(m, 'renal')).toEqual(['renal_male.glb']);
    expect(systemMeshFiles(man([organ('renal', '', 'R')]), 'renal')).toEqual(['renal_male.glb']);
  });
});
