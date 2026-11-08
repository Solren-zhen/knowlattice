/**
 * 桌宠「晶灵」：显隐、停靠位置、外观与一句提示。
 *
 * 只做存储与校验，不引状态库：
 *   - 读写 localStorage（键已登记 KV_KEYS）；
 *   - 把坐标夹在视口内（窗口变窄 / 换屏幕后不至于飞出去）；
 *   - 用 CustomEvent 通知设置面板、自定义面板与角色本体同步。
 * 角色本体在 views/PetFigure.tsx，外壳与拖拽在 views/Pet.tsx，
 * 自定义面板在 views/PetCustomizer.tsx，样式在 styles/21-pet.css。
 */
import { defineStore } from '../storage/kv';

export type PetSize = 's' | 'm' | 'l';
export type PetFace = 'dot' | 'smile' | 'star';
export type PetAccessory = 'none' | 'sprout' | 'halo';

/** 可自定义的外观。坐标与显隐是另一层，不混在这里 */
export interface PetLook {
  name: string;
  /** 自定义主色（#rrggbb）；null = 跟随主题 --accent */
  color: string | null;
  size: PetSize;
  face: PetFace;
  accessory: PetAccessory;
  /** 用上传的图片替换晶体角色；图片本体在 IndexedDB（core/petImage），这里只存开关 */
  image: boolean;
}

export interface PetState extends PetLook {
  hidden: boolean;
  /** 视口坐标（px）；null = 用默认右下角 */
  x: number | null;
  y: number | null;
}

export const PET_LOOK_DEFAULT: PetLook = {
  name: '晶灵',
  color: null,
  size: 'm',
  face: 'dot',
  accessory: 'none',
  image: false,
};

export const PET_FALLBACK: PetState = { ...PET_LOOK_DEFAULT, hidden: false, x: null, y: null };

export const PET_SIZES: readonly PetSize[] = ['s', 'm', 'l'];
export const PET_FACES: readonly PetFace[] = ['dot', 'smile', 'star'];
export const PET_ACCESSORIES: readonly PetAccessory[] = ['none', 'sprout', 'halo'];

export const PET_SIZE_LABELS: Record<PetSize, string> = { s: '小', m: '中', l: '大' };
export const PET_FACE_LABELS: Record<PetFace, string> = { dot: '圆眼', smile: '笑眼', star: '星星眼' };
export const PET_ACCESSORY_LABELS: Record<PetAccessory, string> = { none: '无', sprout: '新芽', halo: '光环' };

/**
 * 主色预设：全部取自界面已经在用的色相，避免自定义色与主题打架。
 * null 那一项表示「跟随主题强调色」。
 */
export const PET_COLORS: ReadonlyArray<{ value: string | null; label: string }> = [
  { value: null, label: '跟随主题' },
  { value: '#4f46e5', label: '靛蓝' },
  { value: '#0e7490', label: '青' },
  { value: '#b45309', label: '琥珀' },
  { value: '#be123c', label: '玫红' },
  { value: '#047857', label: '松绿' },
  { value: '#7c3aed', label: '紫' },
];

const NAME_MAX = 12;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') return PET_LOOK_DEFAULT.name;
  const trimmed = value.trim().slice(0, NAME_MAX);
  return trimmed || PET_LOOK_DEFAULT.name;
}

function normalizeColor(value: unknown): string | null {
  return typeof value === 'string' && COLOR_RE.test(value) ? value.toLowerCase() : null;
}

const PET_STORE = defineStore<PetState>({
  key: 'knowlattice-pet',
  fallback: PET_FALLBACK,
  decode: (raw) => {
    const value = (raw ?? {}) as Partial<PetState>;
    return {
      name: normalizeName(value.name),
      color: normalizeColor(value.color),
      size: pick(value.size, PET_SIZES, PET_LOOK_DEFAULT.size),
      face: pick(value.face, PET_FACES, PET_LOOK_DEFAULT.face),
      accessory: pick(value.accessory, PET_ACCESSORIES, PET_LOOK_DEFAULT.accessory),
      image: value.image === true,
      hidden: value.hidden === true,
      x: typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : null,
      y: typeof value.y === 'number' && Number.isFinite(value.y) ? value.y : null,
    };
  },
});

export const PET_CHANGE_EVENT = 'knowlattice:pet-change';
export const PET_NAME_MAX = NAME_MAX;

export function loadPet(): PetState {
  return PET_STORE.read();
}

export function savePet(next: PetState) {
  PET_STORE.write(next);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PET_CHANGE_EVENT));
}

export function setPetHidden(hidden: boolean) {
  savePet({ ...loadPet(), hidden });
}

export function isPetHidden(): boolean {
  return loadPet().hidden;
}

/** 只改外观，保留坐标与显隐 */
export function updatePetLook(patch: Partial<PetLook>) {
  const current = loadPet();
  const next: PetState = {
    ...current,
    ...patch,
    name: patch.name === undefined ? current.name : normalizeName(patch.name),
    color: patch.color === undefined ? current.color : normalizeColor(patch.color),
  };
  savePet(next);
}

/** 恢复默认外观（名字/颜色/体型/表情/配饰），坐标与显隐不动 */
export function resetPetLook() {
  savePet({ ...loadPet(), ...PET_LOOK_DEFAULT });
}

/** 设置面板、自定义面板与角色本体共用：任何一方改完，其他方立即跟上 */
export function subscribePet(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(PET_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(PET_CHANGE_EVENT, onChange);
}

/** 把左上角坐标夹进视口，元素尺寸由调用方给 */
export function clampPet(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportW: number,
  viewportH: number,
): { x: number; y: number } {
  const maxX = Math.max(0, viewportW - width);
  const maxY = Math.max(0, viewportH - height);
  return {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY),
  };
}

/** 点一下换一句：都是知识库里的日常动作，不新增任何数据请求 */
export const PET_LINES = [
  'Ctrl K 搜一下，比翻目录快。',
  '今天的复习清了吗？',
  '笔记写一句，胜过读十遍。',
  '错题是还没结晶的知识点。',
  '双击目录里的笔记，就能接着写。',
  '累了就合上，明天再打开。',
] as const;

export const PET_DEFAULT_LINE = PET_LINES[0];

/** 轮播提示：不与上一句重复 */
export function nextPetLine(previous?: string): string {
  const pool = PET_LINES.filter((line) => line !== previous);
  const list = pool.length ? pool : PET_LINES;
  return list[Math.floor(Math.random() * list.length)];
}
