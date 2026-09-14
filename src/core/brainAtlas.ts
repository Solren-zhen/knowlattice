/**
 * Brain atlas data layer: MNI152 T1 template + Harvard-Oxford regions
 * (region names, side, MNI centroid in millimetres).
 *
 * Files live in public/brain and are fetched lazily; the 3D/MRI viewer itself
 * (niivue) is lazily imported by views/BrainAtlasView.
 */
export interface BrainRegion {
  value: number;
  en: string;
  cn: string;
  x: number;
  y: number;
  z: number;
  voxels: number;
}

export interface BrainGroup {
  id: string;
  name: string;
  file: string;
  regions: BrainRegion[];
}

export interface BrainAtlas {
  space: string;
  template: { file: string; name: string };
  attribution: string;
  groups: BrainGroup[];
}

const BASE = import.meta.env.BASE_URL;
let cache: BrainAtlas | null = null;

export async function loadBrainAtlas(): Promise<BrainAtlas> {
  if (cache) return cache;
  const resp = await fetch(`${BASE}brain/regions.json`);
  if (resp.ok === false) throw new Error(`brain atlas HTTP ${resp.status}`);
  cache = (await resp.json()) as BrainAtlas;
  return cache;
}

export function brainUrl(file: string): string {
  return `${BASE}brain/${file}`;
}

/** Mixed CN/EN filter: case-insensitive English substring plus Chinese contains. */
export function matchRegion(r: BrainRegion, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (s.length === 0) return true;
  const cn = r.cn ?? '';
  return r.en.toLowerCase().includes(s) || cn.includes(q.trim());
}

/** "Left" / "Right" prefix as a short side tag. */
export function regionSide(r: BrainRegion): string {
  if (r.en.startsWith('Left')) return 'L';
  if (r.en.startsWith('Right')) return 'R';
  return '';
}

/** Display label: Chinese name first when present, English otherwise. */
export function regionLabel(r: BrainRegion): string {
  return (r.cn ?? '').trim().length > 0 ? r.cn : r.en;
}
