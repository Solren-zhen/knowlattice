/**
 * PDF 文字层的几何选区计算。
 *
 * 扫描版 PDF 的 OCR 文字层在 DOM 里的顺序常常和视觉排版不一致（跨栏、表格、分块识别），
 * 浏览器原生拖拽选区是按 DOM 顺序扩展的——所以「选第一行、鼠标一动就带进第四行」。
 * 这里一律按屏幕几何位置挑选和排序：先按纵坐标分行，行内再按横坐标排，不依赖 DOM 顺序。
 */

import { normalizePdfSelection } from './pdfText';

export interface TextBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 两点位移超过这个像素数就当拖拽，否则视为点选（整行） */
const DRAG_THRESHOLD = 3;

export function isDragGesture(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) > DRAG_THRESHOLD || Math.abs(ay - by) > DRAG_THRESHOLD;
}

/** 把文字块按视觉行分组：行内按横坐标排好，返回每行在 boxes 里的下标 */
export function groupLines(boxes: TextBox[]): number[][] {
  const items = boxes.map((box, index) => ({ box, index }));
  items.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);

  const lines: Array<{ top: number; bottom: number; items: number[] }> = [];
  for (const it of items) {
    const line = lines[lines.length - 1];
    if (line) {
      const overlap = Math.min(line.bottom, it.box.bottom) - Math.max(line.top, it.box.top);
      const height = Math.max(1, it.box.bottom - it.box.top);
      // 与当前行的垂直重叠超过自身高度一半 → 同一行
      if (overlap > height * 0.5) {
        line.top = Math.min(line.top, it.box.top);
        line.bottom = Math.max(line.bottom, it.box.bottom);
        line.items.push(it.index);
        continue;
      }
    }
    lines.push({ top: it.box.top, bottom: it.box.bottom, items: [it.index] });
  }
  for (const line of lines) line.items.sort((a, b) => boxes[a].left - boxes[b].left);
  return lines.map((l) => l.items);
}

/** 把文字块按「先行后列」的视觉顺序排好，返回原数组下标 */
export function orderByReadingOrder(boxes: TextBox[]): number[] {
  return groupLines(boxes).flat();
}

/** 找 y 落在哪一行：优先落在行带内（留少量容差），否则取行中心最近的一行 */
function lineNear(bands: Array<{ top: number; bottom: number }>, y: number): number {
  let inside = -1, insideDist = Infinity, nearest = -1, nearestDist = Infinity;
  bands.forEach((b, i) => {
    const dist = Math.abs((b.top + b.bottom) / 2 - y);
    if (y >= b.top - 6 && y <= b.bottom + 6 && dist < insideDist) { insideDist = dist; inside = i; }
    if (dist < nearestDist) { nearestDist = dist; nearest = i; }
  });
  return inside >= 0 ? inside : nearest;
}

/** 点选：取垂直中心落在 y 上下半个行高内的文字块，再按阅读顺序排好 */
export function pickLineAt(boxes: TextBox[], y: number, lineHeight: number): number[] {
  const half = Math.max(2, lineHeight / 2);
  const top = y - half, bottom = y + half;
  const picked: TextBox[] = [];
  const origin: number[] = [];
  boxes.forEach((box, index) => {
    const center = (box.top + box.bottom) / 2;
    if (center < top || center > bottom) return;
    picked.push(box);
    origin.push(index);
  });
  return orderByReadingOrder(picked).map((i) => origin[i]);
}

/**
 * 拖拽：按视觉行选取。
 * - 起点行到终点行之间的行全部纳入（不再按矩形横向相交挑选，竖直向下拖不会漏掉行内靠左的块）；
 * - 横向位移明显时才在起点/终点行做横向截取（贴近浏览器原生选区语义）；
 * - 纯竖直拖动整行纳入——那正是「选中过程中有遗漏」的根源。
 */
export function pickLineRange(
  boxes: TextBox[], ax: number, ay: number, bx: number, by: number
): number[] {
  const lines = groupLines(boxes);
  if (!lines.length) return [];
  const bands = lines.map((idxs) => {
    let top = Infinity, bottom = -Infinity;
    for (const i of idxs) {
      top = Math.min(top, boxes[i].top);
      bottom = Math.max(bottom, boxes[i].bottom);
    }
    return { top, bottom };
  });
  const anchorLine = lineNear(bands, ay);
  const focusLine = lineNear(bands, by);
  if (anchorLine < 0 || focusLine < 0) return [];
  const from = Math.min(anchorLine, focusLine);
  const to = Math.max(anchorLine, focusLine);
  const trim = Math.abs(bx - ax) > 12; // 横向位移够大才做端点截取
  const lo = Math.min(ax, bx), hi = Math.max(ax, bx);

  const picked: number[] = [];
  for (let li = from; li <= to; li++) {
    for (const i of lines[li]) {
      const b = boxes[i];
      if (trim) {
        if (li === anchorLine && li === focusLine) {
          if (b.right < lo || b.left > hi) continue; // 同一行内：取横向区间
        } else if (li === anchorLine) {
          if (b.right < ax) continue; // 起点行：从按下处往右（向上拖也成立）
        } else if (li === focusLine) {
          if (b.left > bx) continue; // 终点行：取到松开处
        }
      }
      picked.push(i);
    }
  }
  return picked;
}

/**
 * 按已排好的顺序拼接文字：同一行内横向间隙够大补空格，换行补换行符，
 * 最后交给 normalizePdfSelection 处理中文排版空白。
 */
export function joinOrderedText(parts: Array<{ text: string; box: TextBox }>): string {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const { text, box } = parts[i];
    if (i > 0) {
      const prev = parts[i - 1].box;
      const overlap = Math.min(prev.bottom, box.bottom) - Math.max(prev.top, box.top);
      const height = Math.max(1, Math.min(prev.bottom - prev.top, box.bottom - box.top));
      if (overlap > height * 0.5) {
        if (box.left - prev.right > height * 0.25) out += ' ';
      } else {
        const gap = box.top - prev.bottom;
        out += gap > height * 0.6 ? '\n\n' : '\n';
      }
    }
    out += text;
  }
  return normalizePdfSelection(out);
}
