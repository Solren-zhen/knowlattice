/**
 * 区分「点击」与「拖拽/缩放」，用于 3D 视图的拾取：旋转视角不应触发选中。
 *
 * 比「位移阈值 + 时间阈值」的朴素写法更稳的地方：
 * - 多指按下（双指缩放）直接判定为不是点击；
 * - pointercancel（被系统/手势打断）也判定为不是点击；
 * - 每个指针各记一个起点，互不干扰。
 * 参考 human-atlas 的 PointerTap（MIT）实现思路。
 */
export class PointerTap {
  private active = new Map<number, { x: number; y: number; threshold: number }>();
  private blocked = false;

  down(id: number, x: number, y: number, threshold: number): void {
    if (this.active.size === 0) this.blocked = false; // 新手势开始，重置
    this.active.set(id, { x, y, threshold });
    if (this.active.size > 1) this.blocked = true;
  }

  move(id: number, x: number, y: number): void {
    const start = this.active.get(id);
    if (start && Math.hypot(x - start.x, y - start.y) > start.threshold) this.blocked = true;
  }

  /** 抬起：返回是否为一次有效点击 */
  up(id: number, x: number, y: number): boolean {
    this.move(id, x, y);
    const tap = this.active.has(id) && this.active.size === 1 && !this.blocked;
    this.active.delete(id);
    return tap;
  }

  cancel(id: number): void {
    this.active.delete(id);
    this.blocked = true;
  }
}
