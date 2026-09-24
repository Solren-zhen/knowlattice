/**
 * M5 · 3D 解剖渲染器（原生 three.js，无 react-three-fiber 依赖）。
 * - 按系统懒加载 GLB（Draco 压缩），点击拾取结构，悬停高亮
 * - 单击 = 选中并把点击坐标交给父组件（用于在光标旁浮现结构笔记卡片）
 * 数据：Anatria-3D（CC BY-SA 4.0，Z-Anatomy / BodyParts3D 派生）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadZhDict, modelLoadHint, systemMeshFiles, zhOrganName, type AnatomyManifest, type ManifestOrgan } from '../core/anatomy';
import { assignMuscleLayers, LAYER_LABELS } from '../core/muscleLayer';
import { nextDegraded } from '../core/adaptiveQuality';
import { PointerTap } from '../core/pointerTap';

interface Props {
  manifest: AnatomyManifest;
  /** 当前选中（来自列表或 3D），用于双向高亮 */
  selectedId: string | null;
  /** 3D 中单击选中结构；at = 点击点在视口中的坐标（供笔记卡片贴着光标浮现） */
  onSelect: (organ: ManifestOrgan | null, at?: { x: number; y: number }) => void;
}

/** 静态资源根：base './' 时构建产物为 './'，GitHub Pages 子路径也能正确加载 */
const BASE = import.meta.env.BASE_URL;

/** 视角预设按钮文案 */
const VIEW_LABELS: Record<'front' | 'back' | 'left' | 'right', string> = {
  front: '前', back: '后', left: '左', right: '右',
};

const SYSTEM_LABELS: Record<string, string> = {
  articular: '关节', cardiovascular: '心血管', digestive: '消化',
  endocrine: '内分泌', integumentary: '皮肤', lymphatic: '淋巴',
  muscular: '肌肉', nervous: '神经', regional: '区域',
  renal: '泌尿', reproductive: '生殖', respiratory: '呼吸',
  skeletal: '骨骼',
};

/** 分类上色：动脉红 / 静脉蓝 / 神经黄 / 淋巴绿 / 筋膜银白，其余按系统基础色 */
const FASCIA_RE = /fascia|aponeuro/i;

function categoryColor(organ: ManifestOrgan): number | null {
  const n = organ.name_en;
  if (FASCIA_RE.test(n)) return 0xcfc7b4; // 筋膜/腱膜：银白色，与肌肉区分
  if (organ.system === 'lymphatic' || /lymph|node/i.test(n)) return 0x5aa86c;
  if (organ.system === 'nervous' || /nerv/i.test(n)) return 0xe3b83e;
  if (organ.system === 'cardiovascular') {
    if (/arter/i.test(n)) return 0xc0392b;
    if (/vein|venous/i.test(n)) return 0x3a6ea8;
  }
  return null;
}

/** 各系统基础色：仿真实人体解剖色（高饱和） */
const SYSTEM_COLORS: Record<string, number> = {
  skeletal: 0xEDE3CF,
  muscular: 0xDC2626,
  articular: 0xE3E8EA,
  digestive: 0xD9975C,
  respiratory: 0xCE8F8F,
  renal: 0xA34A42,
  reproductive: 0xC9718A,
  endocrine: 0xA9B45E,
  integumentary: 0xDE9F63,
  regional: 0xB0A99C,
};

/** 重要器官写实配色（正则匹配名号，优先级仅次于动静脉神经淋巴） */
const ORGAN_OVERRIDES: Array<[RegExp, number]> = [
  [/heart|cardiac/i, 0xD41F1F],
  [/lung|pulmon/i, 0xC98383],
  [/liver|hepat/i, 0x8E3527],
  [/stomach|gastr/i, 0xD9825C],
  [/kidney|renal/i, 0x96453C],
  [/spleen|splenic/i, 0x6E3050],
  [/brain|cerebr|enceph/i, 0xC79A9A],
  [/spinal/i, 0xD8CBB8],
  [/intestin|colon|cecum|rectum|jejunum|ileum|duodenum/i, 0xD98F70],
  [/bladder/i, 0xD9BE5E],
  [/cartilage/i, 0xDFE6E4],
];

/** 结构最终颜色：类别色 > 器官写实色 > 系统色 > 兕底 */
function structureColor(organ: ManifestOrgan): number {
  return (
    categoryColor(organ) ??
    ORGAN_OVERRIDES.find(([re]) => re.test(organ.name_en))?.[1] ??
    SYSTEM_COLORS[organ.system] ??
    0xB0A99C
  );
}

/** 简易字符串哈希：让同系统内相邻结构有明暗差异，便于区分 */
function nameHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 是否筋膜/腱膜：半透明显示，否则会完全遮住下层肌肉并截获点击 */
const isFascia = (organ: ManifestOrgan) => FASCIA_RE.test(organ.name_en);

/**
 * 结构颜色写成逐顶点 Uint8 归一化颜色属性：3 字节/顶点，
 * 代价远低于「每个结构克隆一份材质」，也让同系统可以共用材质。
 */
function organColorAttribute(
  geometry: THREE.BufferGeometry, organ: ManifestOrgan
): THREE.BufferAttribute {
  const count = geometry.getAttribute('position').count;
  const c = organColor(organ);
  const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
  const arr = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = r;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = b;
  }
  return new THREE.BufferAttribute(arr, 3, true);
}

/** 共享材质的键：一个系统内按「是否筋膜」分两批 */
const materialKey = (system: string, fascia: boolean) => `${system}|${fascia ? 'fascia' : 'solid'}`;

/**
 * 结构最终颜色 = 类别/器官/系统配色 + 同系统内明暗微差。
 * 颜色会被烘进逐结构顶点色，这样同一个系统可以共用一份材质。
 */
function organColor(organ: ManifestOrgan): THREE.Color {
  const c = new THREE.Color(structureColor(organ));
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const jitter = ((nameHash(organ.organ_id) % 100) / 100 - 0.5) * 0.14;
  c.setHSL(hsl.h, hsl.s, Math.min(0.85, Math.max(0.15, hsl.l + jitter)));
  return c;
}

export default function AnatomyViewer3D({ manifest, selectedId, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const threeRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
    organMap: Map<string, { mesh: THREE.Object3D; organ: ManifestOrgan }>;
    loadedSystems: Set<string>;
    systemGroups: Map<string, THREE.Object3D>;
    highlighted: { mesh: THREE.Mesh; base: THREE.Material } | null;
    framePending: boolean;
    /** 拾取候选（与 organMap 同步重建，避免每次鼠标移动都新建上千元素数组） */
    pickMeshes: THREE.Mesh[];
    rebuildPickers: () => void;
    /** 按需渲染：标记场景已变化，下一帧才真正绘制 */
    invalidate: () => void;
    /** 每个「系统 × 是否筋膜」共享一对材质（基础 / 选中高亮），替代逐结构克隆材质 */
    sharedMaterials: Map<string, { base: THREE.MeshStandardMaterial; highlight: THREE.MeshStandardMaterial }>;
    getMaterials: (
      system: string, fascia: boolean, source: THREE.Material
    ) => { base: THREE.MeshStandardMaterial; highlight: THREE.MeshStandardMaterial };
    /** 视角预设取景：前 / 后 / 左 / 右 / 复位(三视角) */
    fitView: (view: 'front' | 'back' | 'left' | 'right' | 'iso') => void;
    /** 聚焦到单个结构；结构尚未加载出来时返回 false，由调用方稍后重试 */
    focusOrgan: (organId: string) => boolean;
    /** 重新合成可见性（系统是否加载 × 肌肉分层 × 是否聚焦） */
    applyVisibility: () => void;
  } | null>(null);
  const [activeSystems, setActiveSystems] = useState<Set<string>>(new Set(['skeletal']));
  const [muscleLayer, setMuscleLayer] = useState(4);
  const muscleLayers = useRef(new Map<string, number>());
  /** 全组件共享一个 DRACOLoader（解码 worker 复用），卸载时统一释放 */
  const dracoRef = useRef<DRACOLoader | null>(null);
  useEffect(() => () => {
    dracoRef.current?.dispose();
    dracoRef.current = null;
  }, []);
  const [loadingSystems, setLoadingSystems] = useState<Set<string>>(new Set());
  /** 系统 → 下载进度百分比（仅加载中时有值） */
  const [loadProgress, setLoadProgress] = useState<Map<string, number>>(new Map());
  const [autoRotate, setAutoRotate] = useState(false);
  /** 聚焦模式：只显示选中的结构并自动取景 */
  const [isolate, setIsolate] = useState(false);
  const [hoverOrgan, setHoverOrgan] = useState<ManifestOrgan | null>(null);
  /** 中文词典（与解剖浏览器共用缓存）：用于右下角显示中文结构名 */
  const [zhOrgans, setZhOrgans] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    void loadZhDict().then((d) => setZhOrgans(d.organs));
  }, []);
  const [error, setError] = useState<string | null>(null);

  // organ_id → organ 快查
  const organById = useRef(new Map<string, ManifestOrgan>());
  useEffect(() => {
    organById.current.clear();
    for (const o of manifest.organs) organById.current.set(o.organ_id, o);
  }, [manifest]);

  // ---------- three.js 初始化（一次） ----------
  useEffect(() => {
    const host = hostRef.current!;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.set(0, 0.2, 3.2);

    // powerPreference 让双显卡机器优先用独显，否则可能被浏览器丢到核显上
    const renderer = new THREE.WebGLRenderer({
      antialias: true, alpha: true, powerPreference: 'high-performance',
    });
    const fullPixelRatio = Math.min(window.devicePixelRatio, 1.25);
    renderer.setPixelRatio(fullPixelRatio);
    renderer.setClearColor(0x000000, 0);
    // 色彩与色调映射：ACES + sRGB 输出，避免高光死白、暗部发灰
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping; // 保饱和度，ACES 会把高亮区去饱和成白色
    renderer.toneMappingExposure = 0.75;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.setAttribute(
      'aria-label',
      '3D 解剖视图：拖拽旋转，滚轮缩放，单击选中结构并在光标旁浮现该结构的笔记卡片，同一位置再点可穿透到下一层'
    );

    // 灯光总量要和 albedo 同量级：加了环境贴图后原来的强度会把模型冲成死白（ACES 还会去饱和）
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 0.35));
    const dir = new THREE.DirectionalLight(0xffffff, 0.75);
    dir.position.set(2, 3, 4);
    scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xdfe8e2, 0.3);
    dir2.position.set(-3, -1, -2);
    scene.add(dir2);

    // 环境贴图（RoomEnvironment + PMREM）：GLTF 无材质时默认 metalness=1，
    // 没有环境反射时模型会又暗又灰，顶点色里的解剖配色几乎看不出来。
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envRT = pmrem.fromScene(room, 0.04);
    scene.environment = envRT.texture;
    room.dispose();
    pmrem.dispose();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    // 按需渲染：场景没变就不画，空闲时不再持续占用 GPU
    let needsRender = true;
    let raf = 0;
    let frameScheduled = false;
    const scheduleFrame = () => {
      if (frameScheduled) return;
      frameScheduled = true;
      raf = requestAnimationFrame(loop);
    };
    const invalidate = () => {
      needsRender = true;
      scheduleFrame();
    };

    const pickMeshes: THREE.Mesh[] = [];
    const rebuildPickers = () => {
      pickMeshes.length = 0;
      threeRef.current?.organMap.forEach((v) => pickMeshes.push(v.mesh as THREE.Mesh));
    };

    // 每个「系统 × 是否筋膜」共享一对材质：基础材质 + 选中高亮材质。
    // 原来逐结构 clone 材质（全量最多 3478 份），逐 draw call 的材质切换与 uniforms
    // 上传是拖拽旋转时的主要 CPU 开销；逐结构颜色改由顶点色承载。
    const sharedMaterials = new Map<
      string,
      { base: THREE.MeshStandardMaterial; highlight: THREE.MeshStandardMaterial }
    >();
    const getMaterials = (system: string, fascia: boolean, source: THREE.Material) => {
      const key = materialKey(system, fascia);
      let entry = sharedMaterials.get(key);
      if (!entry) {
        const base = source.clone() as THREE.MeshStandardMaterial;
        base.vertexColors = true;
        base.color.setHex(0xffffff); // 结构颜色烘进顶点色
        // 解剖标本是绝缘体，不是金属：GLTF 默认 metalness=1 会让顶点色完全不参与漫反射
        base.metalness = 0.05;
        base.roughness = 0.55;
        base.envMapIntensity = 0.5;
        if (fascia) {
          base.transparent = true;
          base.opacity = 0.45;
          base.roughness = 0.7;
        }
        const highlight = base.clone();
        // 底色现在偏亮，自发光要够强才能让选中结构一眼看出来
        highlight.emissive.setHex(0x1f7a4d);
        highlight.emissiveIntensity = 1.15;
        entry = { base, highlight };
        sharedMaterials.set(key, entry);
      }
      return entry;
    };

    // ---------- 取景 / 可见性 ----------
    const VIEW_VECTORS: Record<'front' | 'back' | 'left' | 'right', THREE.Vector3> = {
      front: new THREE.Vector3(0, 0.02, 1),
      back: new THREE.Vector3(0, 0.02, -1),
      left: new THREE.Vector3(-1, 0.02, 0),
      right: new THREE.Vector3(1, 0.02, 0),
    };
    const ISO_DIR = new THREE.Vector3(0.35, 0.16, 1).normalize();
    const _fitBox = new THREE.Box3();
    const _fitCenter = new THREE.Vector3();
    const _fitSize = new THREE.Vector3();

    /** 把相机摆到能完整看到 box 的位置；fill 越大留白越多 */
    const fitToBox = (box: THREE.Box3, dirVec: THREE.Vector3, fill = 1.25) => {
      if (box.isEmpty()) return;
      box.getCenter(_fitCenter);
      box.getSize(_fitSize);
      const radius = Math.max(_fitSize.length() / 2, 1e-4);
      const dist = (radius / Math.tan((camera.fov * Math.PI) / 360)) * fill;
      camera.near = Math.max(1e-4, dist / 100);
      camera.far = dist * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(_fitCenter);
      camera.position.copy(_fitCenter).addScaledVector(dirVec, dist);
      controls.update();
      invalidate();
    };
    /** 当前可见结构的整体包围盒（聚焦时只剩一个结构，取景自然跟着走） */
    const visibleBox = () => {
      const box = new THREE.Box3();
      const cur = threeRef.current;
      cur?.pickMeshes.forEach((m) => { if (m.visible !== false) box.expandByObject(m); });
      return box;
    };
    const fitView = (view: 'front' | 'back' | 'left' | 'right' | 'iso') => {
      const box = visibleBox();
      if (box.isEmpty()) return;
      fitToBox(box, view === 'iso' ? ISO_DIR : VIEW_VECTORS[view]);
    };
    const focusOrgan = (organId: string): boolean => {
      const cur = threeRef.current;
      const entry = cur?.organMap.get(organId);
      const bb = entry?.mesh.userData.bbox as THREE.Box3 | undefined;
      if (!cur || !entry || !bb) return false;
      _fitBox.copy(bb).applyMatrix4(entry.mesh.matrixWorld);
      fitToBox(_fitBox, ISO_DIR, 1.9);
      return true;
    };
    /** 可见性 = 系统是否加载（由 group 是否在场景中决定）× 肌肉分层 × 是否聚焦 */
    const applyVisibility = () => {
      const cur = threeRef.current;
      if (!cur) return;
      const sel = liveRef.current.selectedId;
      const iso = isolateRef.current;
      cur.organMap.forEach((v, id) => {
        const layerOk = v.organ.system !== 'muscular'
          || (muscleLayers.current.get(id) ?? 1) <= layerRef.current;
        v.mesh.visible = layerOk && (!iso || id === sel);
      });
      cur.invalidate();
    };

    threeRef.current = {
      renderer, scene, camera, controls, raycaster, pointer,
      organMap: new Map(),
      loadedSystems: new Set(),
      systemGroups: new Map(),
      highlighted: null,
      framePending: true,
      pickMeshes,
      rebuildPickers,
      invalidate,
      sharedMaterials,
      getMaterials,
      fitView,
      focusOrgan,
      applyVisibility,
    };
    const t = threeRef.current;
    // 阻尼未停时 controls.update() 会持续派发 change，从而持续渲染到相机静止
    controls.addEventListener('change', invalidate);

    // 交互期间的自适应渲染质量：只在「确实掉帧」时才降分辨率，避免画面无故发虚。
    const canDegrade = fullPixelRatio > 1.05;
    let degraded = false;
    let interacting = false;
    let lastRenderTs = 0;
    let skipSample = false;
    const frameSamples: number[] = [];
    const applyQuality = (want: boolean) => {
      if (want === degraded) return;
      degraded = want;
      renderer.setPixelRatio(want ? 1 : fullPixelRatio);
      skipSample = true; // 重分配绘制缓冲的那一帧不代表真实性能，不计入采样
      invalidate();
    };
    const onControlsStart = () => {
      interacting = true;
      lastRenderTs = 0;
      frameSamples.length = 0;
      invalidate();
    };
    const onControlsEnd = () => {
      interacting = false;
      frameSamples.length = 0;
      applyQuality(false); // 松手立刻恢复清晰
      invalidate();
    };
    controls.addEventListener('start', onControlsStart);
    controls.addEventListener('end', onControlsEnd);

    // 尺寸自适应
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth, h = host.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      invalidate();
    });
    ro.observe(host);

    // 渲染循环：只有场景变化或阻尼/自动旋转仍在推进时才预约下一帧。
    const loop = () => {
      frameScheduled = false;
      controls.update();
      // 自动旋转期间相机一直在动，按需渲染要持续出帧
      if (controls.autoRotate) needsRender = true;
      if (needsRender) {
        needsRender = false;
        const now = performance.now();
        if (canDegrade && interacting) {
          if (lastRenderTs && !skipSample) {
            const dt = now - lastRenderTs;
            if (dt > 0 && dt < 500) {
              frameSamples.push(dt);
              if (frameSamples.length > 24) frameSamples.shift();
              applyQuality(nextDegraded(frameSamples, degraded));
            }
          }
          skipSample = false;
          lastRenderTs = now;
        }
        renderer.render(scene, camera);
      }
      if (controls.autoRotate || needsRender) scheduleFrame();
    };
    invalidate();

    // 标签页切回前台时补一帧：按需渲染下没有常驻循环，否则可能留下空白画布
    const onVisible = () => { if (!document.hidden) invalidate(); };
    document.addEventListener('visibilitychange', onVisible);

    // ---------- 拾取 ----------
    const _box = new THREE.Box3();
    /** 包围盒粗筛：射线连包围盒都没碰到，就不必做三角形级求交 */
    const mayHit = (mesh: THREE.Mesh) => {
      const bb = mesh.userData.bbox as THREE.Box3 | undefined;
      if (!bb) return true; // 没有包围盒时不筛，保守处理
      _box.copy(bb).applyMatrix4(mesh.matrixWorld);
      return raycaster.ray.intersectsBox(_box);
    };
    /** 返回射线上命中的全部结构（由近及远），供穿透式切换 */
    const pickAll = (clientX: number, clientY: number): ManifestOrgan[] => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // 原实现每次移动都新建上千元素数组、对全部网格求交、再线性反查 organ；
      // 现改为缓存列表 + 包围盒粗筛 + userData 直查。
      const candidates = t.pickMeshes.filter((m) => m.visible !== false && mayHit(m));
      const hits = raycaster.intersectObjects(candidates, false);
      const out: ManifestOrgan[] = [];
      for (const hit of hits) {
        const id = hit.object.userData.organId as string | undefined;
        if (!id || out.some((o) => o.organ_id === id)) continue;
        const entry = t.organMap.get(id);
        if (entry) out.push(entry.organ);
      }
      return out;
    };
    const pick = (clientX: number, clientY: number): ManifestOrgan | null =>
      pickAll(clientX, clientY)[0] ?? null;

    // 点击判定交给 PointerTap：拖拽、双指缩放、被系统打断都不会误判为点击
    const tap = new PointerTap();
    // 点击命中栈：记录最近一次单击位置的重叠结构序列，供穿透切换
    let hitStack: ManifestOrgan[] = [];
    let hitIdx = 0;
    let lastUp: { x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      tap.down(e.pointerId, e.clientX, e.clientY, e.pointerType === 'touch' ? 12 : 5);
    };
    const onPointerCancel = (e: PointerEvent) => {
      tap.cancel(e.pointerId);
      lastUp = null;
    };
    const onPointerUp = (e: PointerEvent) => {
      // 拖拽旋转视角 / 双指缩放 不触发选择
      if (!tap.up(e.pointerId, e.clientX, e.clientY)) return;
      const cur = liveRef.current;
      const at = { x: e.clientX, y: e.clientY };
      const sameSpot = lastUp && Math.hypot(e.clientX - lastUp.x, e.clientY - lastUp.y) < 8;
      lastUp = { x: e.clientX, y: e.clientY };
      // 同一位置连续单击：在重叠结构间穿透切换（筋膜 → 肌肉 → 更深层）
      if (sameSpot && hitStack.length > 1) {
        hitIdx = (hitIdx + 1) % hitStack.length;
        cur.onSelect(hitStack[hitIdx], at);
        return;
      }
      hitStack = pickAll(e.clientX, e.clientY);
      hitIdx = 0;
      const organ = hitStack[0] ?? null;
      // 切换逻辑：唯一命中且已是当前选中 = 取消；点空白处也取消
      if (organ && organ.organ_id === cur.selectedId && hitStack.length === 1)
        cur.onSelect(null, at);
      else cur.onSelect(organ, at);
    };
    let hoverRaf = 0;
    let hoverX = 0, hoverY = 0;
    let lastHoverId: string | null = null;
    const onPointerMove = (e: PointerEvent) => {
      // 拖拽旋转视角时不做拾取，避免每次移动都触发 raycast 造成掉帧
      if (e.buttons !== 0) {
        if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0; }
        if (lastHoverId !== null) { lastHoverId = null; setHoverOrgan(null); }
        renderer.domElement.style.cursor = 'grab';
        return;
      }
      // 合并到每帧最多拾取一次；命中同一个结构时不再触发 React 重渲染
      hoverX = e.clientX; hoverY = e.clientY;
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const organ = pick(hoverX, hoverY);
        const id = organ?.organ_id ?? null;
        if (id !== lastHoverId) { lastHoverId = id; setHoverOrgan(organ); }
        renderer.domElement.style.cursor = organ ? 'pointer' : 'grab';
      });
    };

    // 指针离开画布（含移到侧栏/图例上）时清掉悬停名，避免残留
    const onPointerLeave = () => {
      if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0; }
      if (lastHoverId !== null) { lastHoverId = null; setHoverOrgan(null); }
      renderer.domElement.style.cursor = 'grab';
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerCancel);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

    return () => {
      cancelAnimationFrame(raf);
      frameScheduled = false;
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerCancel);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.removeEventListener('change', invalidate);
      controls.removeEventListener('start', onControlsStart);
      controls.removeEventListener('end', onControlsEnd);
      document.removeEventListener('visibilitychange', onVisible);
      controls.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      t.sharedMaterials.forEach(({ base, highlight }) => {
        base.dispose();
        highlight.dispose();
      });
      t.sharedMaterials.clear();
      scene.environment = null;
      envRT.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      threeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 高亮工具 ----------
  // 材质按系统共享，不能改单个 mesh 的材质参数；改为在「基础 / 高亮」两份共享材质间切换
  const setHighlight = (organId: string | null) => {
    const t = threeRef.current;
    if (!t) return;
    if (t.highlighted) {
      t.highlighted.mesh.material = t.highlighted.base;
      t.highlighted = null;
    }
    if (organId) {
      const entry = t.organMap.get(organId);
      if (entry) {
        const mesh = entry.mesh as THREE.Mesh;
        const shared = t.sharedMaterials.get(materialKey(entry.organ.system, isFascia(entry.organ)));
        if (shared) {
          mesh.material = shared.highlight;
          t.highlighted = { mesh, base: shared.base };
        }
      }
    }
    t.invalidate();
  };

  // 用 ref 镜像最新 props/state：three.js 事件回调与取景函数只挂载一次，必须经 ref 取实时值
  const liveRef = useRef({ onSelect, selectedId });
  liveRef.current = { onSelect, selectedId };
  const isolateRef = useRef(isolate);
  isolateRef.current = isolate;
  const layerRef = useRef(muscleLayer);
  layerRef.current = muscleLayer;

  // 列表/外部选中 → 3D 高亮
  useEffect(() => {
    setHighlight(selectedId);
  }, [selectedId]);

  // ---------- 按系统加载 GLB ----------
  const loadSystem = async (system: string) => {
    const t = threeRef.current;
    if (!t || t.loadedSystems.has(system)) return;
    setLoadingSystems((s) => new Set(s).add(system));
    // 一个系统可能对应**多个**文件：digestive / endocrine / respiratory 的内脏器官在
    // visceral_male.glb 里（见 core/anatomy.systemMeshFiles）。第一个是主文件，它失败才算
    // 整个系统失败；附加文件失败只提示影响范围。以前只取「第一条 organ 的 mesh_file」，
    // 于是这 13 个结构在列表里点得到、3D 里永远不显示。
    const files = systemMeshFiles(manifest, system);
    // GLB 导出时节点名被归一化：空格→下划线、去除点号（"Calcaneus.l" → "Calcaneusl"）
    const normalize = (s: string) => s.replace(/\./g, '').replace(/ /g, '_');
    const picked: THREE.Object3D[] = [];
    // 直接记住每个节点对应的 organ：visceral_male.glb 与主文件大量重名，事后按名字反查会串
    const pickedOrgan = new Map<THREE.Object3D, ManifestOrgan>();
    try {
      const loader = new GLTFLoader();
      if (!dracoRef.current) {
        const d = new DRACOLoader();
        d.setDecoderPath(`${BASE}draco/gltf/`);
        dracoRef.current = d;
      }
      loader.setDRACOLoader(dracoRef.current);
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        let gltf: GLTF;
        try {
          // 用 onProgress 上报下载百分比（Draco 解码阶段没有进度，会停在 99% 直到完成）
          gltf = await new Promise<GLTF>((resolve, reject) => {
            loader.load(
              `${BASE}anatomy/${file}`,
              resolve,
              (ev) => {
                if (!ev.lengthComputable || !ev.total) return;
                // 多文件时按「第几个文件 + 该文件内进度」折算，整体仍然单调递增
                const pct = Math.min(
                  99,
                  Math.round(((i + ev.loaded / ev.total) / files.length) * 100)
                );
                setLoadProgress((m) => {
                  if (m.get(system) === pct) return m;
                  const next = new Map(m);
                  next.set(system, pct);
                  return next;
                });
              },
              reject
            );
          });
        } catch (e) {
          console.error('[AnatomyViewer3D]', e);
          if (i === 0) {
            setError(modelLoadHint(e, file));
            return;
          }
          // 附加文件缺失：已加载的部分照常显示，只把「少的是哪一块、影响几个结构」说清楚
          const affected = manifest.organs.filter((o) => o.mesh_file === file).length;
          setError(`${modelLoadHint(e, file)}（这个系统还有 ${affected} 个结构靠它显示）`);
          break;
        }

        // 只认「manifest 说属于这个文件」的节点。visceral_male.glb 与主文件大量同名
        // （digestive 47 个结构里 44 个名字在两个文件里都有），只按名字匹配会把同一个
        // 结构加两遍：organMap 被覆盖、多出来的网格留在场景里。
        const byNode = new Map<string, ManifestOrgan>();
        for (const o of manifest.organs) {
          if (o.system !== system || o.mesh_file !== file) continue;
          byNode.set(o.node, o);
          byNode.set(normalize(o.node), o);
        }
        gltf.scene.traverse((obj) => {
          const organ = byNode.get(obj.name);
          if (!organ) return;
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          // 共享材质（系统 × 是否筋膜）；结构颜色写进顶点色，不再逐结构 clone 材质
          const shared = t.getMaterials(organ.system, isFascia(organ), mesh.material as THREE.Material);
          mesh.material = shared.base;
          mesh.geometry.setAttribute('color', organColorAttribute(mesh.geometry, organ));
          // 拾取用：organ 反查键 + 本地包围盒（供射线粗筛，省掉对上千网格的三角形求交）
          mesh.userData.organId = organ.organ_id;
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          mesh.userData.bbox = mesh.geometry.boundingBox;
          picked.push(obj);
          pickedOrgan.set(obj, organ);
        });
      }

      const group = new THREE.Group();
      group.name = `system-${system}`;
      // 遍历结束后再移动节点（遍历中改父层级会导致 children 数组移位越界）
      for (const obj of picked) {
        const organ = pickedOrgan.get(obj)!;
        group.add(obj);
        t.organMap.set(organ.organ_id, { mesh: obj as THREE.Mesh, organ });
      }
      t.scene.add(group);
      t.systemGroups.set(system, group);
      t.loadedSystems.add(system);
      // 世界矩阵在拾取粗筛前就绪；刷新拾取候选并请求重绘
      group.updateMatrixWorld(true);
      // 结构网格从不移动，关掉逐帧矩阵更新
      for (const obj of picked) (obj as THREE.Mesh).matrixAutoUpdate = false;
      t.rebuildPickers();
      // 聚焦模式下，可见性要按新的 organMap 重新合成
      t.applyVisibility();
      // 聚焦的结构刚加载出来 → 取景过去
      if (isolateRef.current) {
        const sel = liveRef.current.selectedId;
        if (sel) t.focusOrgan(sel);
      }
      t.invalidate();

      // 首次加载后取景：标准 fit-to-view
      if (t.framePending) {
        const box = new THREE.Box3().setFromObject(t.scene);
        const center = box.getCenter(new THREE.Vector3());
        const halfW = box.getSize(new THREE.Vector3()).length() / 2;
        const dist = (halfW / Math.tan((t.camera.fov * Math.PI) / 360)) * 1.25;
        t.camera.near = dist / 100;
        t.camera.far = dist * 20;
        t.camera.updateProjectionMatrix();
        t.camera.position.set(
          center.x + dist * 0.35,
          center.y + dist * 0.2,
          center.z + dist * 0.9
        );
        t.controls.target.copy(center);
        t.controls.update();
        t.framePending = false;
      }
    } catch (e) {
      console.error('[AnatomyViewer3D]', e);
      setError(modelLoadHint(e, files[0]));
    } finally {
      setLoadingSystems((s) => {
        const n = new Set(s);
        n.delete(system);
        return n;
      });
      setLoadProgress((m) => {
        if (!m.has(system)) return m;
        const n = new Map(m);
        n.delete(system);
        return n;
      });
    }
  };

  // 肌肉分层改用「精选解剖分层表」（core/muscleLayer）：
  // 原来的「到骨骼距离 + 排名均分」无法区分深浅（比目鱼肌与腓肠肌到骨距离几乎相同），
  // 且肌腱/滑囊也被当成肌肉分层。现在是显式定层、纯静态，不再需要几何计算。
  const muscleLayerMap = useMemo(
    () => assignMuscleLayers(manifest.organs.filter((o) => o.system === 'muscular')),
    [manifest]
  );
  /** 每层结构数，显示在分层按钮上 */
  const layerCounts = useMemo(() => {
    const c = [0, 0, 0, 0];
    for (const l of muscleLayerMap.values()) c[l - 1]++;
    return c;
  }, [muscleLayerMap]);

  useEffect(() => {
    muscleLayers.current = muscleLayerMap;
    threeRef.current?.applyVisibility();
  }, [muscleLayerMap]);

  // activeSystems 变化 → 卸载已关闭的系统 + 加载新开启的系统
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    // 卸载：把关闭系统的整个 group 从场景移除，并清掉索引
    for (const sys of [...t.loadedSystems]) {
      if (activeSystems.has(sys)) continue;
      const g = t.systemGroups.get(sys);
      if (g) {
        // 高亮网格若属于本系统，先解除引用（它即将随系统一起移除）
        if (t.highlighted && g.getObjectById(t.highlighted.mesh.id)) t.highlighted = null;
        t.scene.remove(g);
        // 释放该系统全部几何体，避免反复开关系统导致显存持续增长
        g.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
        });
        t.systemGroups.delete(sys);
      }
      // 共享材质按系统释放并从缓存移除：否则重新打开该系统会用到已 dispose 的材质
      for (const fascia of [false, true]) {
        const key = materialKey(sys, fascia);
        const entry = t.sharedMaterials.get(key);
        if (entry) {
          entry.base.dispose();
          entry.highlight.dispose();
          t.sharedMaterials.delete(key);
        }
      }
      for (const [id, v] of [...t.organMap]) {
        if (v.organ.system === sys) t.organMap.delete(id);
      }
      t.loadedSystems.delete(sys);
      // 若当前选中的结构属于被卸载的系统，同步取消选中
      if (liveRef.current.selectedId && !t.organMap.has(liveRef.current.selectedId)) {
        liveRef.current.onSelect(null);
      }
    }
    t.rebuildPickers();
    t.invalidate();
    for (const s of activeSystems) void loadSystem(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSystems]);

  const toggleSystem = (sys: string) => {
    setActiveSystems((prev) => {
      const next = new Set(prev);
      if (next.has(sys)) next.delete(sys);
      else next.add(sys);
      return next;
    });
  };

  // 可见性统一合成：系统是否加载（group 在不在场景里）× 肌肉分层 × 是否聚焦
  useEffect(() => {
    threeRef.current?.applyVisibility();
  }, [muscleLayer, isolate, selectedId]);

  // 自动旋转：循环里在 autoRotate 时持续出帧，与按需渲染兼容
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    t.controls.autoRotate = autoRotate;
    t.controls.autoRotateSpeed = 0.7;
    t.invalidate();
  }, [autoRotate]);

  // 聚焦：选中结构所属系统未加载就先加载；已加载则把相机对过去
  useEffect(() => {
    if (!isolate) return;
    if (!selectedId) { setIsolate(false); return; }
    const organ = organById.current.get(selectedId);
    if (!organ) return;
    if (!activeSystems.has(organ.system)) {
      setActiveSystems((prev) => new Set(prev).add(organ.system));
      return; // 加载完成后 loadSystem 结尾会重试取景
    }
    threeRef.current?.focusOrgan(selectedId);
  }, [isolate, selectedId, activeSystems]);

  // 退出聚焦时恢复整体取景
  const prevIsolate = useRef(false);
  useEffect(() => {
    if (prevIsolate.current && !isolate) threeRef.current?.fitView('iso');
    prevIsolate.current = isolate;
  }, [isolate]);

  const systems = useMemo(() => {
    const set = new Set(manifest.organs.map((o) => o.system));
    return [...set];
  }, [manifest]);

  /** 中文名优先，词典未命中回退英文 */
  const labelOf = (o: ManifestOrgan) =>
    zhOrgans ? zhOrganName(o.name_en, zhOrgans) ?? o.name_en : o.name_en;
  const selectedOrgan = selectedId ? organById.current.get(selectedId) ?? null : null;
  const selectedLabel = selectedOrgan ? labelOf(selectedOrgan) : '';
  const hoverLabel = hoverOrgan ? labelOf(hoverOrgan) : '';
  /** 悬停到的是与当前选中不同的结构：穿透后光标下仍是最外层，不能覆盖选中名 */
  const hoverIsOther = !!hoverOrgan && hoverOrgan.organ_id !== selectedOrgan?.organ_id;

  return (
    <div className="viewer3d">
      <div className="viewer3d-systems">
        {systems.map((sys) => (
          <button
            key={sys}
            className={`sys-chip ${activeSystems.has(sys) ? 'on' : ''} ${
              loadingSystems.has(sys) ? 'loading' : ''
            }`}
            onClick={() => toggleSystem(sys)}
          >
            {loadingSystems.has(sys)
              ? (loadProgress.has(sys) ? `${loadProgress.get(sys)}%` : '…')
              : SYSTEM_LABELS[sys] ?? sys}
          </button>
        ))}
        {activeSystems.has('muscular') && (
          <div className="viewer3d-layer-picker" title="按解剖学深浅分层逐层显示；数字为该层结构数（规则表见 core/muscleLayer）">
            <span>肌肉分层</span>
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                className={`layer-chip ${muscleLayer >= n ? 'on' : ''}`}
                onClick={() => setMuscleLayer(n)}
              >
                {n === 4 ? '全部' : LAYER_LABELS[n - 1]}
                <span className="layer-count">
                  {n === 4 ? layerCounts.reduce((a, b) => a + b, 0) : layerCounts[n - 1]}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="viewer3d-canvas" ref={hostRef} />
      <div className="viewer3d-tools">
        <div className="viewer3d-tools-group" role="group" aria-label="视角预设">
          {(['front', 'back', 'left', 'right'] as const).map((v) => (
            <button
              key={v}
              className="tool-chip"
              onClick={() => threeRef.current?.fitView(v)}
              title={`${VIEW_LABELS[v]}面视角`}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        <div className="viewer3d-tools-group">
          <button
            className={`tool-chip ${autoRotate ? 'on' : ''}`}
            onClick={() => setAutoRotate((v) => !v)}
            title="自动旋转"
            aria-pressed={autoRotate}
          >
            自动旋转
          </button>
          <button
            className={`tool-chip ${isolate ? 'on' : ''}`}
            disabled={!selectedId}
            onClick={() => setIsolate((v) => !v)}
            title={selectedId ? '只显示选中的结构并聚焦' : '先在模型或右侧列表里选中一个结构'}
            aria-pressed={isolate}
          >
            聚焦
          </button>
        </div>
        <button
          className="tool-chip"
          onClick={() => threeRef.current?.fitView('iso')}
          title="恢复整体取景"
        >
          复位
        </button>
      </div>
      <div className="viewer3d-legend">
        <span className="lg lg-artery">动脉</span>
        <span className="lg lg-vein">静脉</span>
        <span className="lg lg-nerve">神经</span>
        <span className="lg lg-lymph">淋巴</span>
      </div>
      {/* 右下角名称：选中优先（穿透到下一层时名称要跟着走）；悬停别的结构时附带显示 */}
      {(selectedOrgan || hoverOrgan) && (
        <div className="viewer3d-status">
          {selectedOrgan ? (
            <>
              <span className="viewer3d-status-tag">选中</span>
              <span className="viewer3d-status-name">{selectedLabel}</span>
              {selectedLabel !== selectedOrgan.name_en && (
                <span className="viewer3d-status-en">{selectedOrgan.name_en}</span>
              )}
              {hoverIsOther && <span className="viewer3d-status-hover">悬停 {hoverLabel}</span>}
            </>
          ) : hoverOrgan ? (
            <>
              <span className="viewer3d-status-tag">悬停</span>
              <span className="viewer3d-status-name">{hoverLabel}</span>
              {hoverLabel !== hoverOrgan.name_en && (
                <span className="viewer3d-status-en">{hoverOrgan.name_en}</span>
              )}
            </>
          ) : null}
        </div>
      )}
      {error && <div className="viewer3d-error">{error}</div>}
      <div className="viewer3d-hint muted">单击选中并弹出笔记卡片 · 同一位置再点可穿透到下一层 · 拖拽旋转 · 滚轮缩放</div>
    </div>
  );
}
