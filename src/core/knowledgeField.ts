/**
 * 知识星图背景（Knowledge Field）：一片极慢漂移、逐点呼吸的节点网络，
 * 对应「KNOWLATTICE」这个名字，也让首屏真正在动，而不是贴一张静图。
 *
 * 为什么用 Canvas：要让上百个节点各自有相位、速度与亮度，SVG 得挂上百个
 * <animate>，CSS 得写上百条 keyframes，都是文档级负担；Canvas 每帧只做一次
 * 绘制，节点数只影响画布成本，不碰 DOM。
 *
 * 三条开销约束（口径同 core/cardTilt.ts、core/hoverGlow.ts）：
 * 1. 30fps 封顶 + DPR 上限 2：背景是装饰，不需要跟 165Hz 屏幕逐帧重画；
 * 2. 节点按网格索引只连右 / 下邻居，不做 O(n²) 距离检索；
 * 3. 窗口隐藏、系统要求减少动效、纯触摸设备 → 只画一帧静图（动效开关见 core/motionPrefs）。
 *
 * 颜色只取主题的 --accent（浅色 #4f46e5 / 深色 #818cf8），透明度全部走
 * globalAlpha：换主题不用改这里，也不会把色值写死在 TS 里。
 */

import { hasFinePointer, motionAllowed, subscribeMotionAllowed } from './motionPrefs';

/** 网格间距（CSS px）：比正文行距大得多，才不会和文字抢注意力 */
const SPACING = 104;
/** 节点随机偏移上限：整齐网格像表格，抖动后才像「星图」 */
const JITTER = 20;
/** 连线的最大长度：超过就不连，避免远距离斜线把画面糊成蛛网 */
const LINK_MAX = SPACING * 1.55;
/** 绘制帧率上限：背景也要跟手，30fps 的间隔本身就够被看成「鼠标拖影」 */
const STEP_MS = 1000 / 60;
/** 指针眩光半径；只有光晕做平滑，影响圈直接用原始坐标 */
const GLOW_RADIUS = 320;
const GLOW_TAU = 45;
/** 指针影响半径：进入这个圈内的节点会被推开、提亮 */
const INFLUENCE_RADIUS = 240;
/** 最大推开距离（px）：再大就像在躲鼠标，不像被「扰动」 */
const INFLUENCE_PUSH = 18;
/** 整片星图随指针反向位移的上限（px，按节点深度缩放） */
const PARALLAX = 10;

interface FieldNode {
  /** 抖动后的网格坐标 */
  x: number;
  y: number;
  /** 0.35–1 的「深度」：越浅漂得越远、越亮，形成轻微视差 */
  z: number;
  /** 相位与角速度（rad/ms），错开后才不会整片同频呼吸 */
  phase: number;
  speed: number;
  /** 漂移幅度（px） */
  amp: number;
  radius: number;
}

/** 可复现的伪随机：同一格网永远得到同一点，窗口缩放不会让星图「跳一下」 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把主题色解析成 rgb 分量：Canvas 渐变只认具体颜色，不认 CSS 变量 */
export function colorToRgb(color: string): [number, number, number] {
  const value = color.trim();
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      return [
        Number.parseInt(hex[0] + hex[0], 16),
        Number.parseInt(hex[1] + hex[1], 16),
        Number.parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (hex.length >= 6) {
      return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  const parts = value.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (parts) return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  return [79, 70, 229];
}

export function initKnowledgeField(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};

  const canvas = document.createElement('canvas');
  canvas.className = 'knowledge-field';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const context2d = canvas.getContext('2d');
  if (!context2d) {
    canvas.remove();
    return () => {};
  }
  // 先做空值判定再取别名：闭包里用的是已收窄的具体类型，不必到处加 `!`
  const ctx = context2d;

  let width = 0;
  let height = 0;
  let cols = 0;
  let rows = 0;
  let nodes: FieldNode[] = [];
  /** 每帧算好的屏幕坐标与亮度（0–1），连线与节点共用一遍 */
  let posX = new Float32Array(0);
  let posY = new Float32Array(0);
  let shine = new Float32Array(0);
  /** 每帧的指针影响强度（0–1）：被推开的节点同时也更亮 */
  let boost = new Float32Array(0);

  let accent = '#4f46e5';
  let rgb: [number, number, number] = [79, 70, 229];
  let dark = false;
  /** 节点柔光的预渲染贴图：每帧给 300 个节点各建一次径向渐变太贵，这里只建一次 */
  let glowSprite: HTMLCanvasElement | null = null;

  let raf = 0;
  let startedAt = 0;
  let lastTs = 0;
  let acc = 0;
  /** 上一次实际绘制的时刻：指针跟随按真实 dt 收敛，与帧率解耦 */
  let lastDrawAt = 0;
  /** 精确指针：每帧 matchMedia 太浪费，跟动效开关一起缓存 */
  let finePointer = false;

  const pointer = { x: 0, y: 0, tx: 0, ty: 0, active: false, primed: false };

  function readTheme(): void {
    const style = getComputedStyle(document.documentElement);
    accent = style.getPropertyValue('--accent').trim() || '#4f46e5';
    rgb = colorToRgb(accent);
    dark = document.documentElement.dataset.theme === 'dark';
    buildGlowSprite();
  }

  function buildGlowSprite(): void {
    const size = 64;
    const sprite = document.createElement('canvas');
    sprite.width = size;
    sprite.height = size;
    const paint = sprite.getContext('2d');
    if (!paint) return;
    const gradient = paint.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 1)`);
    gradient.addColorStop(0.4, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.3)`);
    gradient.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
    paint.fillStyle = gradient;
    paint.fillRect(0, 0, size, size);
    glowSprite = sprite;
  }

  function build(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 用 clientWidth/Height（不含滚动条）而不是 innerWidth：鼠标事件坐标也在这个坐标系里，
    // 两者差 15px 滚动条宽度时，画布内容整体就会有横向偏移。
    const root = document.documentElement;
    width = root.clientWidth || window.innerWidth;
    height = root.clientHeight || window.innerHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 多铺一圈，边缘连线和漂移不会露白
    cols = Math.ceil(width / SPACING) + 3;
    rows = Math.ceil(height / SPACING) + 3;
    nodes = new Array<FieldNode>(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const random = mulberry32((r * 73856093) ^ (c * 19349663));
        const z = 0.35 + random() * 0.65;
        nodes[r * cols + c] = {
          x: (c - 1) * SPACING + (random() * 2 - 1) * JITTER,
          y: (r - 1) * SPACING + (random() * 2 - 1) * JITTER,
          z,
          phase: random() * Math.PI * 2,
          // 周期约 3.5–8.5s：扫一眼就能看出在飘；峰值位移速度约 30px/s
          speed: 0.00075 + random() * 0.001,
          amp: (5 + random() * 11) * (0.6 + 0.4 * z),
          radius: 0.9 + random() * 1.5,
        };
      }
    }
    posX = new Float32Array(nodes.length);
    posY = new Float32Array(nodes.length);
    shine = new Float32Array(nodes.length);
    boost = new Float32Array(nodes.length);
  }

  function lineAlpha(): number {
    return dark ? 0.26 : 0.18;
  }

  function nodeAlpha(): number {
    return dark ? 0.85 : 0.65;
  }

  function linkTo(i: number, j: number, base: number): void {
    const dx = posX[j] - posX[i];
    const dy = posY[j] - posY[i];
    const distance = Math.hypot(dx, dy);
    if (distance > LINK_MAX) return;
    const fade = 1 - distance / LINK_MAX;
    // 指针附近的连线跟着提亮（两端 boost 取平均），让鼠标「点得亮」一片网
    const near = 1 + (boost[i] + boost[j]) * 1.1;
    ctx.globalAlpha = Math.min(1, base * fade * (0.45 + 0.55 * ((shine[i] + shine[j]) * 0.5)) * near);
    ctx.beginPath();
    ctx.moveTo(posX[i], posY[i]);
    ctx.lineTo(posX[j], posY[j]);
    ctx.stroke();
  }

  function draw(now: number): void {
    const t = now - startedAt;
    const dt = lastDrawAt ? Math.min(120, now - lastDrawAt) : 16;
    lastDrawAt = now;
    // 全局呼吸：约 40s 一轮，幅度压低，避免「在闪」的观感
    const breath = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(t / 6500));

    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineWidth = 1;

    const hover = pointer.active && finePointer;
    // 「鼠标到哪、网就动到哪」：影响圈与视差一律使用原始指针坐标（tx/ty），
    // 不再等平滑值追上来。只有眩光保留 45ms 的极短平滑，用来把光晕抹开。
    if (hover) {
      if (!pointer.primed) {
        pointer.x = pointer.tx;
        pointer.y = pointer.ty;
        pointer.primed = true;
      }
      const follow = 1 - Math.exp(-dt / GLOW_TAU);
      pointer.x += (pointer.tx - pointer.x) * follow;
      pointer.y += (pointer.ty - pointer.y) * follow;
    }
    const focusX = hover ? pointer.tx : pointer.x;
    const focusY = hover ? pointer.ty : pointer.y;
    // 反向视差：鼠标往右，星图整体微微往左；越"近"（z 大）的节点位移越多
    const parallaxX = hover ? -((focusX - width / 2) / width) * PARALLAX : 0;
    const parallaxY = hover ? -((focusY - height / 2) / height) * PARALLAX : 0;
    const influence2 = INFLUENCE_RADIUS * INFLUENCE_RADIUS;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      // 相位里掺一点位置：相邻节点错开起落，整片看起来像一道缓慢传过去的波，
      // 而不是所有点同频上下（同频反而显得是「整体在缩放」，看不出流动）
      const wave = t * node.speed + node.phase + (node.x + node.y) * 0.0025;
      posX[i] = node.x + Math.sin(wave) * node.amp + parallaxX * node.z;
      posY[i] = node.y + Math.cos(wave * 0.73 + node.phase * 0.6) * node.amp + parallaxY * node.z;
      shine[i] = 0.5 + 0.5 * Math.sin(wave * 1.8 + node.phase);
      boost[i] = 0;

      // 指针附近的节点向外让开一点，同时被照亮 —— 这是「手感」的主要来源
      if (hover) {
        const dx = posX[i] - focusX;
        const dy = posY[i] - focusY;
        const distance2 = dx * dx + dy * dy;
        if (distance2 < influence2) {
          const distance = Math.sqrt(distance2) || 1;
          const fall = 1 - distance / INFLUENCE_RADIUS;
          const push = fall * fall * INFLUENCE_PUSH;
          posX[i] += (dx / distance) * push;
          posY[i] += (dy / distance) * push;
          boost[i] = fall;
          shine[i] = Math.min(1, shine[i] + fall * 0.8);
        }
      }
    }

    // 连线：只连右 / 下邻居，数量随窗口线性增长
    const base = lineAlpha() * breath;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (c + 1 < cols) linkTo(i, i + 1, base);
        if (r + 1 < rows) linkTo(i, i + cols, base);
      }
    }

    // 节点：柔光 + 实心点。柔光让「星」有大小差别，实心点保证缩到 1px 时仍看得见
    const nodeBase = nodeAlpha() * breath;
    if (glowSprite) {
      for (let i = 0; i < nodes.length; i++) {
        const halo = nodes[i].radius * (1 + boost[i] * 1.6) * 8;
        ctx.globalAlpha = Math.min(1, nodeBase * 0.34 * (0.4 + 0.6 * shine[i]) * (1 + boost[i] * 1.5));
        ctx.drawImage(glowSprite, posX[i] - halo / 2, posY[i] - halo / 2, halo, halo);
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      ctx.globalAlpha = Math.min(1, nodeBase * (0.3 + 0.7 * shine[i]) * (1 + boost[i] * 1.2));
      ctx.beginPath();
      ctx.arc(posX[i], posY[i], nodes[i].radius * (1 + boost[i] * 0.9), 0, Math.PI * 2);
      ctx.fill();
    }

    // 指针眩光：位置在上面已按真实 dt 平滑过一次，这里只负责画
    if (hover) {
      const glow = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, GLOW_RADIUS);
      const core = dark ? 0.2 : 0.15;
      glow.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${core})`);
      glow.addColorStop(0.45, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${core * 0.35})`);
      glow.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
      ctx.globalAlpha = 1;
      ctx.fillStyle = glow;
      ctx.fillRect(pointer.x - GLOW_RADIUS, pointer.y - GLOW_RADIUS, GLOW_RADIUS * 2, GLOW_RADIUS * 2);
    }
    ctx.globalAlpha = 1;
  }

  function loop(now: number): void {
    raf = requestAnimationFrame(loop);
    if (!lastTs) lastTs = now;
    acc += now - lastTs;
    lastTs = now;
    if (acc < STEP_MS) return;
    acc %= STEP_MS;
    draw(now);
  }

  function stopLoop(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastTs = 0;
    acc = 0;
  }

  /** 按当前开关状态决定「动」还是「静」；主题切换时也走这里重画 */
  function sync(): void {
    readTheme();
    finePointer = hasFinePointer();
    if (!motionAllowed() || !finePointer) {
      stopLoop();
      draw(performance.now());
      return;
    }
    if (!raf) {
      startedAt = performance.now();
      lastTs = 0;
      acc = 0;
      raf = requestAnimationFrame(loop);
    }
  }

  let resizeFrame = 0;
  function onResize(): void {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      build();
      if (!raf) draw(performance.now());
    });
  }

  function onPointerMove(event: PointerEvent): void {
    pointer.tx = event.clientX;
    pointer.ty = event.clientY;
    pointer.active = true;
  }

  function onPointerLeave(): void {
    pointer.active = false;
    pointer.primed = false;
  }

  function onVisibility(): void {
    if (document.hidden) stopLoop();
    else sync();
  }

  const themeObserver = new MutationObserver(() => {
    sync();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  const unsubscribeMotion = subscribeMotionAllowed(sync);
  window.addEventListener('resize', onResize);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);

  build();
  startedAt = performance.now();
  sync();

  return () => {
    stopLoop();
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    unsubscribeMotion();
    themeObserver.disconnect();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerleave', onPointerLeave);
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.remove();
  };
}
