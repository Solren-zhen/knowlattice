import { describe, expect, it } from 'vitest';
import {
  claimSheetDrag,
  resolveSheetTarget,
  sheetAnchors,
  sheetDragY,
  sheetOpenY,
  sheetRestY,
  type SheetGeometry,
} from '../sheet';

/** 视口 800、抽屉占 94%、两档：露出 60% / 94% */
const G: SheetGeometry = { viewport: 800, panelFraction: 0.94, stops: [0.6, 0.94] };
/** 三档：多一档才测得出「甩动跨档」 */
const G3: SheetGeometry = { viewport: 800, panelFraction: 0.94, stops: [0.35, 0.6, 0.94] };

describe('锚点换算', () => {
  it('露出越少，translateY 越大；列表按升序给 pickSnapAnchor 用', () => {
    expect(sheetAnchors(G)).toEqual([0, 272]);
    expect(sheetAnchors(G3)).toEqual([0, 272, 472]);
  });

  it('打开时停在最小位移那一档（露出最多）', () => {
    expect(sheetOpenY(G)).toBe(0);
    expect(sheetRestY(G)).toBe(272);
  });

  it('stops 给乱序也照样升序输出', () => {
    const shuffled: SheetGeometry = { viewport: 800, panelFraction: 0.94, stops: [0.94, 0.6] };
    expect(sheetAnchors(shuffled)).toEqual([0, 272]);
  });
});

describe('拖拽位移（橡皮筋）', () => {
  it('区间内 1:1 跟手', () => {
    expect(sheetDragY(0, G)).toBe(0);
    expect(sheetDragY(136, G)).toBe(136);
    expect(sheetDragY(272, G)).toBe(272);
  });

  it('往上越界（想拉得比全开更高）被衰减，且不会越过 0 太多', () => {
    const y = sheetDragY(-100, G);
    expect(y).toBeLessThan(0);
    expect(y).toBeGreaterThan(-60);
  });

  it('往下越界（想推开）被衰减，且远小于手指位移', () => {
    const y = sheetDragY(372, G);
    expect(y).toBeGreaterThan(272);
    expect(y).toBeLessThan(340);
  });

  it('位移随手指单调不减（不会出现「越拖越回」）', () => {
    const samples = [-200, -100, 0, 100, 272, 400, 800].map((raw) => sheetDragY(raw, G));
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
  });
});

describe('松手吸附', () => {
  it('慢放：离谁近去谁（等价于越过中点才换档）', () => {
    expect(resolveSheetTarget(130, 0, G)).toBe(0);
    expect(resolveSheetTarget(140, 0, G)).toBe(272);
  });

  it('快甩：按惯性投影跨档，而不是按手指停在哪', () => {
    // 停在中间档，但以 1px/ms 向上甩 → 投影到 771，落到最后一档（全开）
    expect(resolveSheetTarget(272, 1, G3)).toBe(472);
    expect(resolveSheetTarget(272, -1, G3)).toBe(0);
  });

  it('投影越界时停在端点', () => {
    expect(resolveSheetTarget(472, 5, G3)).toBe(472);
    expect(resolveSheetTarget(0, -5, G3)).toBe(0);
  });
});

describe('手势仲裁', () => {
  it('抽屉没开就不接管', () => {
    expect(claimSheetDrag({ open: false, scrollTop: 0, dy: 60 })).toBe(false);
  });

  it('内容还没滚到顶 → 先滚内容', () => {
    expect(claimSheetDrag({ open: true, scrollTop: 40, dy: 60 })).toBe(false);
  });

  it('往上拖是滚内容，不是拉抽屉', () => {
    expect(claimSheetDrag({ open: true, scrollTop: 0, dy: -60 })).toBe(false);
  });

  it('横向意图更大时不接管（横向是别的交互，比如滑日期）', () => {
    expect(claimSheetDrag({ open: true, scrollTop: 0, dy: 20, dx: 90 })).toBe(false);
  });

  it('到顶 + 向下拖 + 纵向为主 → 接管', () => {
    expect(claimSheetDrag({ open: true, scrollTop: 0, dy: 60, dx: 6 })).toBe(true);
  });
});
