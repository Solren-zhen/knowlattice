/**
 * IntersectionObserver 兜底：解决 PDF 面板「首次打开偶发空白」。
 *
 * 背景：@react-pdf-viewer/core 的 <Viewer> 用 IntersectionObserver 决定文档要不要开始加载——
 * 只有收到「容器可见」回调后才挂载 DocumentLoader（`file.shouldLoad && <DocumentLoader>`）。
 * 实测（生产构建 + 全新 origin 冷缓存首次打开）：容器 742×632 明明可见，
 * 观察器回调却始终不派发 —— PDF 停在空白，连加载指示器都没有，控制台也无报错；
 * 刷新一次（热缓存）或再打开一次又常常正常。同一环境里手动新建的观察器能正常回调，
 * 说明是「观察器实例回调丢失」这一类时序问题，而不是容器真的不可见。
 *
 * 做法：包装 IntersectionObserver，observe() 后若原生回调在短时限内一直没来，
 * 且元素仍在文档里、有实际尺寸，就补发一次「可见」回调，让等待可见性的消费者继续。
 * - 原生回调只要为**该元素**投递过（无论可见与否），就绝不补发；
 * - disconnect/unobserve 后不再补发；
 * - 零尺寸/已卸载的元素不补发。
 * 本项目源码没有其他 IntersectionObserver 消费者（grep 确认），
 * 用到的库只有 @react-pdf-viewer 的 core 与 thumbnail，两者都对「可见」做惰性渲染，
 * 收到正向信号即工作，被补发一次不会造成错误状态。
 */

const PATCH_FLAG = '__knowlatticePdfIoFallback';
/** 补发时限：原生回调通常在一个渲染帧内到达，等这么久还没来才补 */
const FALLBACK_MS = 700;

interface Rec {
  cb: IntersectionObserverCallback;
  /** 原生已为该元素投递过回调（无论结果），不再补发 */
  nativeSpoke: WeakSet<Element>;
  observed: WeakSet<Element>;
  timers: Set<number>;
  stopped: boolean;
}

type IOLike = {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
  takeRecords(): IntersectionObserverEntry[];
};

function makeSyntheticEntry(target: Element, rect: DOMRect): IntersectionObserverEntry {
  return {
    target,
    isIntersecting: true,
    intersectionRatio: 1,
    boundingClientRect: rect,
    intersectionRect: rect,
    rootBounds: null,
    time: performance.now(),
  } as unknown as IntersectionObserverEntry;
}

/** 幂等安装；浏览器不支持 IntersectionObserver 时什么都不做 */
export function installPdfIntersectionFallback(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown> & { IntersectionObserver?: typeof IntersectionObserver };
  if (w[PATCH_FLAG] || typeof w.IntersectionObserver !== 'function') return;
  w[PATCH_FLAG] = true;

  const Native = w.IntersectionObserver;
  const records = new WeakMap<object, Rec>();

  function Patched(this: IOLike, cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    const rec: Rec = { cb, nativeSpoke: new WeakSet(), observed: new WeakSet(), timers: new Set(), stopped: false };
    // 原生回调转发：先记录「该元素原生已投递」，保证补发逻辑不会与原生重复触发
    const native = new Native((entries, obs) => {
      for (const e of entries) rec.nativeSpoke.add(e.target);
      cb(entries, obs);
    }, options);
    records.set(this, rec);

    this.observe = (target: Element) => {
      native.observe(target);
      if (rec.stopped || rec.observed.has(target)) return;
      rec.observed.add(target);
      const kickAndSynth = () => {
        rec.timers.delete(timer);
        if (rec.stopped || rec.nativeSpoke.has(target)) return;
        if (!target.isConnected) return;
        // ① 踢一脚：新建一个一次性观察器观察同一元素，强制浏览器跑一次交叉计算——
        //    这会把所有挂起的 IO 通知（包括 viewer 自己那个）在同一渲染步里投递。
        //    实测：viewer 的回调被无限期搁置时，这一脚能让它立刻到达、面板恢复渲染。
        try {
          const kick = new Native(() => {}, options);
          kick.observe(target);
          window.setTimeout(() => { try { kick.disconnect(); } catch { /* 已断开 */ } }, 100);
        } catch {
          /* 踢不动就走下面的合成保底 */
        }
        // ② 保底：踢完一帧仍无回调，就直接补发一次「可见」
        window.setTimeout(() => {
          if (rec.stopped || rec.nativeSpoke.has(target) || !target.isConnected) return;
          const rect = target.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          try {
            cb([makeSyntheticEntry(target, rect)], this as unknown as IntersectionObserver);
          } catch {
            /* 补发失败不影响原生行为 */
          }
        }, 250);
      };
      const timer = window.setTimeout(kickAndSynth, FALLBACK_MS);
      rec.timers.add(timer);
    };
    this.unobserve = (target: Element) => {
      rec.observed.delete(target);
      native.unobserve(target);
    };
    this.disconnect = () => {
      rec.stopped = true;
      for (const t of rec.timers) window.clearTimeout(t);
      rec.timers.clear();
      native.disconnect();
    };
    this.takeRecords = () => native.takeRecords();
  }
  // 原型链保持原生，instanceof 检查照常成立
  Patched.prototype = Native.prototype;
  w.IntersectionObserver = Patched as unknown as typeof IntersectionObserver;
}
