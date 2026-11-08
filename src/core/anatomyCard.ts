/**
 * M5+ · 解剖结构 → 笔记卡片：候选名解析与卡片落位。
 *
 * 卡片是「点结构 → 直接看笔记」的一等入口，这两件事都必须可测：
 * - 一个结构可能被写成了英文名 / 中文名 / 结构 ID 三种标题，接回笔记要挨个试；
 * - 卡片贴在 3D 舞台左边缘（模型居中，错开视野中心），纵向跟随点击点并夹紧。
 *
 * 纯函数，不碰 DOM（落位只吃矩形数值），由 views/AnatomyNoteCard 消费。
 */
import { sideOf, type ManifestOrgan } from './anatomy';

export interface CardSize {
  width: number;
  height: number;
}

/** 舞台在视口中的矩形（getBoundingClientRect 的子集） */
export interface CardStageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 卡片测量前的尺寸估计：先按它落位，量到真实尺寸后再校正（同一帧内完成，不闪） */
export const CARD_ESTIMATE: CardSize = { width: 340, height: 300 };

/** 卡片与舞台边缘的留白 */
const PAD = 12;
/** 默认停靠高度：让开顶部系统 chip 行；调用方会传入实测高度 */
const DOCK_TOP = 56;

/**
 * 结构 → 可用于接回笔记的名称，按优先级排列：
 * 本侧精确名（英文/中文，接旧分侧笔记）→ 共享名（无侧别英文/中文，接共享篇）→ 结构 ID。
 * 去重且丢弃空白项（中文词典缺失时 zhName 为 null）。
 *
 * 成对结构（名字带 `(left)`/`(right)`）的共享名排在分侧名之后：库里已有分侧笔记时
 * 打开分侧那篇（尊重旧数据），否则打开共享篇（另一侧建的「踇展肌」）；
 * 两者都不存在时由 Workspace 按共享语义新建（标题不带侧别）。
 */
export function anatomyNoteCandidates(organ: ManifestOrgan, zhName?: string | null): string[] {
  const out: string[] = [];
  const push = (raw?: string | null) => {
    const name = (raw ?? '').trim();
    if (name && !out.includes(name)) out.push(name);
  };
  const side = sideOf(organ.name_en);
  push(organ.name_en);
  push(zhName);
  if (side) {
    // 共享名排在分侧精确名之后:有分侧旧笔记时优先分侧,否则落到共享篇
    push(side.base);
    const zhBase = zhName ? zhName.replace(/（[左右]）$/, '') : null;
    push(zhBase);
  }
  push(organ.organ_id);
  return out;
}

/**
 * 结构 → 笔记路径：文件名 / 一级标题 / alias 任一命中即可（resolve 由 vault 提供）。
 * 都接不上返回 null，由卡片显示「还没有笔记」。
 */
export function resolveAnatomyNotePath(
  resolve: (name: string) => string | null,
  organ: ManifestOrgan,
  zhName?: string | null
): string | null {
  for (const name of anatomyNoteCandidates(organ, zhName)) {
    const path = resolve(name);
    if (path) return path;
  }
  return null;
}

/** 夹紧到 [lo, hi]；卡片比舞台还大（hi < lo）时取 lo，保证左/上边界优先可见 */
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * 计算卡片相对舞台的落位（left/top，单位 px）。
 *
 * **固定贴左边缘停靠，不再跟着光标游走**：舞台中央是模型，卡片压在点击点旁
 * 会把刚点的结构整个盖住（实测点胸口时 360×247 的卡片正好盖住右半身）。
 * 现在只借用点击点的纵向位置，让卡片与所点结构大致同高；横向永远停在左边缘，
 * 与居中的模型错开。`topInset` 由调用方按顶部 chip 行的实际高度传入。
 */
export function placeCard(
  anchor: { x: number; y: number } | null,
  stage: CardStageRect,
  card: CardSize,
  topInset: number = DOCK_TOP
): { left: number; top: number } {
  const top = anchor
    ? clamp(anchor.y - stage.top - card.height / 2, topInset, stage.height - card.height - PAD)
    : topInset;
  return { left: clamp(PAD, PAD, stage.width - card.width - PAD), top };
}
