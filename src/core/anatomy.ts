/**
 * 解剖图谱共享数据层：manifest / 中文词典的加载与缓存、结构中文名查询。
 * 从 views/AnatomyBrowser.tsx 拆出，供 Workspace / 3D 视图 / 浏览器面板共用。
 *
 * 数据来源：Anatria-3D（Apache-2.0 代码 + CC BY-SA 4.0 模型）
 */

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
