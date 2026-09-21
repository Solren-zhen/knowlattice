/**
 * 解剖图谱共享数据层：manifest / 中文词典的加载与缓存、结构中文名查询。
 * 从 views/AnatomyBrowser.tsx 拆出，供 Workspace / 3D 视图 / 浏览器面板共用。
 *
 * 数据来源：Anatria-3D（Apache-2.0 代码 + CC BY-SA 4.0 模型）
 */

import { netErrorHint } from './netError';

// ---------- manifest 类型（与 Anatria-3D manifest.json 对齐） ----------

export interface ManifestOrgan {
  organ_id: string;
  ta2_latin: string;
  name_en: string;
  system: string;
  mesh_file: string;
  node: string;
  path: string[];
}

export interface ManifestSystem {
  system: string;
  organ_count: number;
  load_on_start: boolean;
}

export interface AnatomyManifest {
  version: number;
  gender_model: string;
  systems: ManifestSystem[];
  organs: ManifestOrgan[];
  attribution?: string;
}

// ---------- 加载 manifest ----------

let _manifestCache: AnatomyManifest | null = null;

/** 静态资源根：base './' 时构建产物为 './'，GitHub Pages 子路径也能正确加载 */
const BASE = import.meta.env.BASE_URL;

export async function loadAnatomyManifest(): Promise<AnatomyManifest> {
  if (_manifestCache) return _manifestCache;
  const resp = await fetch(`${BASE}anatomy/manifest.json`);
  if (!resp.ok) throw new Error(`无法加载解剖数据 (HTTP ${resp.status})`);
  _manifestCache = (await resp.json()) as AnatomyManifest;
  return _manifestCache!;
}

// ---------- 中文词典加载（分批文件合并） ----------

const ZH_FILES = [
  'zh-paths.json',
  'zh-organs-a.json',
  'zh-organs-b.json',
  'zh-organs-c.json',
  'zh-organs-d.json',
  'zh-organs-e.json',
  'zh-organs-f.json',
  'zh-organs-g.json',
  'zh-organs-h.json',
];

let _zhCache: { organs: Map<string, string>; paths: Map<string, string> } | null = null;

export async function loadZhDict(): Promise<{ organs: Map<string, string>; paths: Map<string, string> }> {
  if (_zhCache) return _zhCache;
  const organs = new Map<string, string>();
  const paths = new Map<string, string>();
  await Promise.all(
    ZH_FILES.map(async (f) => {
      try {
        const resp = await fetch(`${BASE}anatomy/${f}`);
        if (!resp.ok) return;
        const data = (await resp.json()) as Record<string, string>;
        const isPaths = f === 'zh-paths.json';
        for (const [en, zh] of Object.entries(data)) {
          (isPaths ? paths : organs).set(en, zh);
        }
      } catch {
        /* 单个词典文件缺失不影响其余 */
      }
    })
  );
  _zhCache = { organs, paths };
  return _zhCache;
}

// ---------- 中文名查询（浏览器显示与「双击建笔记」共用） ----------

/**
 * 结构中文名：基础名查词典；带 (left|right) 后缀的拼成「…（左/右）」。
 * 词典未命中返回 null，由调用方回退英文显示。
 */
export function zhOrganName(nameEn: string, organs: Map<string, string>): string | null {
  const m = /^(.*?) \((left|right)\)$/i.exec(nameEn);
  if (m) {
    const base = organs.get(m[1]);
    return base ? `${base}（${m[2].toLowerCase() === 'left' ? '左' : '右'}）` : null;
  }
  return organs.get(nameEn) ?? null;
}

// ---------- manifest 派生信息 ----------

/**
 * 一个系统实际要用到哪几个 GLB。
 *
 * 不能假设「一个系统一个文件」。manifest 里有 3 个系统（digestive / endocrine /
 * respiratory）的 organs 指向**两个** mesh_file：主文件 + `visceral_male.glb`（内脏器官）。
 * 例如 endocrine 的 10 个结构里只有 4 个在 `endocrine_male.glb`，另外 6 个（垂体、松果体、
 * 甲状腺、肾上腺…）都在 `visceral_male.glb`。以前只取「该系统第一条 organ 的 mesh_file」，
 * 于是这 13 个结构在列表里点得到、3D 里永远不显示。
 *
 * 顺序保持 manifest 中出现顺序：第一个是该系统的主文件（加载失败才算整个系统失败）。
 */
export function systemMeshFiles(manifest: AnatomyManifest, system: string): string[] {
  const files: string[] = [];
  for (const o of manifest.organs) {
    if (o.system !== system) continue;
    if (o.mesh_file && !files.includes(o.mesh_file)) files.push(o.mesh_file);
  }
  return files.length > 0 ? files : [`${system}_male.glb`];
}

// ---------- 模型加载失败时给用户看什么 ----------

/**
 * 3D 模型取不到时的文案。
 *
 * 404 与传输层失败是两回事，所以分开给话术：
 * - 404（`FileLoader` 抛的 HttpError 带 `response`）：这个文件没随包提供，用户既不知道
 *   「是缺文件」也不知道「别的系统没事、结构列表还能用」，所以要说清楚；
 * - 其它（连不上本地服务等）交给 netErrorHint。
 *
 * 触发场景不再是「nervous_male.glb 没提交」（2026-09-20 已从上游补回并加了打包闸门），
 * 而是任何一次包不完整 / 服务没起来——包括 `visceral_male.glb` 这类**附加**文件缺失。
 */
export function modelLoadHint(err: unknown, file: string): string {
  // three.js 的 HttpError 带 response 字段（class HttpError { this.response = response }），
  // 优先读它；读不到再退回到消息里的状态码（不依赖具体措辞）。
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (status === 404 || (status === undefined && /\b404\b/.test(raw))) {
    return `${file} 没有随包提供，这个系统的 3D 模型无法显示。其它系统不受影响；`
      + '该系统的结构名称与笔记仍可在右侧列表里查看。';
  }
  return netErrorHint(err);
}
