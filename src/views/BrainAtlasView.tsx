/**
 * Brain atlas + template MRI view.
 *
 * MNI152 T1 (2 mm) with Harvard-Oxford cortical / subcortical regions, rendered
 * by niivue. Everything runs locally: the template and label volumes live in
 * public/brain. niivue itself is heavy, so this view is lazy loaded by Workspace.
 *
 * Click a region -> move the crosshair to its MNI centroid. Drag the crosshair
 * to read MNI coordinates. Sliders control overlay opacity and clip-plane peel.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEsc, escThenClose } from './useEsc';
import { Niivue } from '@niivue/niivue';

type VolumeSpec = Parameters<Niivue['loadVolumes']>[0][number];
import {
  brainUrl, loadBrainAtlas, matchRegion, regionLabel, regionSide,
  type BrainAtlas, type BrainGroup, type BrainRegion,
} from '../core/brainAtlas';
import { netErrorHint } from '../core/netError';
import { IconBrain, IconClose } from './icons';

interface Props {
  onClose: () => void;
}

type Mode = 'multi' | 'axial' | 'coronal' | 'sagittal' | 'render';

const MODE_LABEL: Record<Mode, string> = {
  multi: '多平面',
  axial: '轴位',
  coronal: '冠状位',
  sagittal: '矢状位',
  render: '三维',
};

export default function BrainAtlasView({ onClose }: Props) {
  // Esc 关闭（接进全局 Esc 栈，与其余面板一致）；焦点在搜索框/滑杆上时先退出该控件
  useEsc(escThenClose(onClose));
  const [atlas, setAtlas] = useState<BrainAtlas | null>(null);
  const [groupId, setGroupId] = useState('cortical');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<BrainRegion | null>(null);
  const [mode, setMode] = useState<Mode>('multi');
  const [opacity, setOpacity] = useState(0.55);
  const [peel, setPeel] = useState(2);
  const [azi, setAzi] = useState(0);
  const [elev, setElev] = useState(0);
  const [mni, setMni] = useState<number[] | null>(null);
  const [error, setError] = useState('');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nvRef = useRef<Niivue | null>(null);

  // Load the atlas JSON once.
  useEffect(() => {
    const st = { alive: true as boolean };
    void loadBrainAtlas()
      .then((d) => { if (st.alive) setAtlas(d); })
      .catch((e) => { if (st.alive) setError(netErrorHint(e)); });
    return () => { st.alive = false; };
  }, []);

  // Initialise niivue and load the template + label volumes.
  useEffect(() => {
    if (atlas === null || canvasRef.current === null) return;
    const canvas = canvasRef.current;
    const st = { alive: true as boolean };
    const cort = atlas.groups.find((g) => g.id === 'cortical');
    const sub = atlas.groups.find((g) => g.id === 'subcortical');
    const nv = new Niivue({ show3Dcrosshair: true, isColorbar: true, textHeight: 0.035 });
    nvRef.current = nv;
    void (async () => {
      try {
        await nv.attachToCanvas(canvas);
        if ((st.alive as boolean) === false) return;
        // niivue 的 addVolumesFromUrl 用 `name || url` 去判定文件扩展名，而 getFileExt()
        // 内部是 `re.exec(fullname)[1].toUpperCase()`——没有 `|| ''` 兜底。传中文显示名
        // （如“MNI152 T1 模板”）会得到 undefined 并抛 TypeError，三个体积文件全部加载失败。
        // 所以这里的 name 必须是真实文件名；显示用中文名由本组件自己的 UI 承担。
        const list: VolumeSpec[] = [
          { url: brainUrl(atlas.template.file), name: atlas.template.file, colormap: 'gray', opacity: 1 },
        ];
        if (cort) list.push({ url: brainUrl(cort.file), name: cort.file, colormap: 'actc', opacity: 0.55, cal_min: 0, cal_max: 96 });
        if (sub) list.push({ url: brainUrl(sub.file), name: sub.file, colormap: 'random', opacity: 0.55, cal_min: 0, cal_max: 21 });
        await nv.loadVolumes(list);
        if ((st.alive as boolean) === false) return;
        nv.setSliceType(nv.sliceTypeMultiplanar);
        // scene.crosshairPos 是**分数坐标**（0~1），不是毫米。原来直接写 [0,-18,18]
        // 把交叉线丢到了体积之外，交互和读数都失效。用库自己的 mm2frac 换算，
        // 并与 createOnLocationChange 内部 frac2mm(..., true) 的约定保持一致。
        nv.scene.crosshairPos = nv.mm2frac([0, -18, 18], 0, true);
        nv.drawScene();
        nv.onLocationChange = (loc) => {
          const d = loc as { mm?: number[] };
          if (st.alive && d.mm) setMni(d.mm.map((v) => Math.round(v)));
        };
        // 主动触发一次，让读数在打开时就显示初始位置而不是 --
        nv.createOnLocationChange();
      } catch (e) {
        if (st.alive) setError(netErrorHint(e));
      }
    })();
    return () => {
      st.alive = false;
      nv.cleanup();
      if (nvRef.current === nv) nvRef.current = null;
    };
  }, [atlas]);

  const groups = atlas?.groups ?? [];
  const active: BrainGroup | undefined = groups.find((g) => g.id === groupId) ?? groups[0];
  const regions = useMemo(() => {
    if (active === undefined) return [];
    return active.regions.filter((r) => matchRegion(r, query));
  }, [active, query]);

  const focus = (r: BrainRegion) => {
    setSelected(r);
    const nv = nvRef.current;
    if (nv === null) return;
    nv.scene.crosshairPos = nv.mm2frac([r.x, r.y, r.z], 0, true);
    nv.drawScene();
    nv.createOnLocationChange();   // 同步刷新 MNI 读数
  };

  useEffect(() => {
    const nv = nvRef.current;
    if (nv === null) return;
    const map: Record<Mode, number> = {
      multi: nv.sliceTypeMultiplanar, axial: nv.sliceTypeAxial, coronal: nv.sliceTypeCoronal,
      sagittal: nv.sliceTypeSagittal, render: nv.sliceTypeRender,
    };
    nv.setSliceType(map[mode]);
  }, [mode]);

  useEffect(() => {
    const nv = nvRef.current;
    if (nv === null) return;
    if (nv.volumes.length > 1) nv.setOpacity(1, opacity);
    if (nv.volumes.length > 2) nv.setOpacity(2, opacity);
    nv.drawScene();
  }, [opacity]);

  useEffect(() => {
    const nv = nvRef.current;
    if (nv === null) return;
    if (peel >= 1.8) nv.setClipPlanes([]);
    else nv.setClipPlanes([[peel, azi, elev]]);
    nv.drawScene();
  }, [peel, azi, elev]);

  return (
    <div className="panel-backdrop quiz-overlay" onClick={onClose}>
      <div className="panel quiz-panel brain-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head quiz-header">
          <span className="panel__title quiz-title"><IconBrain /> 脑图谱 · MRI 对照</span>
          <button className="btn-icon" onClick={onClose} aria-label="close"><IconClose /></button>
        </div>
        <div className="panel__body brain-body">
          <div className="brain-side">
            <input className="brain-search" placeholder="搜索脑区（中文 / English）" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="brain-tabs">
              {groups.map((g) => (
                <button key={g.id} className={`btn-small${g.id === active?.id ? ' active' : ''}`} onClick={() => setGroupId(g.id)}>
                  {g.name}
                </button>
              ))}
            </div>
            <div className="brain-count muted">{regions.length} 个脑区</div>
            <div className="brain-list">
              {regions.map((r) => (
                <button
                  key={r.value}
                  className={`brain-item${selected?.value === r.value ? ' on' : ''}`}
                  onClick={() => focus(r)}
                  /* 中文名是主标签，英文原名留在悬停提示里——医学生两种叫法都要认 */
                  title={r.en}
                >
                  <span className="brain-tag">{regionSide(r)}</span>
                  <span className="brain-name">{regionLabel(r)}</span>
                  <span className="brain-mm">{r.x}, {r.y}, {r.z}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="brain-stage">
            <canvas ref={canvasRef} className="brain-canvas" />
            {atlas === null && error.length === 0 && <div className="brain-hint">载入中…</div>}
            {error.length > 0 && <div className="brain-hint">{error}</div>}
            <div className="brain-toolbar">
              {(['multi', 'axial', 'coronal', 'sagittal', 'render'] as Mode[]).map((m) => (
                <button key={m} className={`btn-small${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <div className="brain-controls">
              <label>叠加透明度
                <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
              </label>
              <label>剖面深度
                <input type="range" min={0} max={2} step={0.02} value={peel} onChange={(e) => setPeel(Number(e.target.value))} />
              </label>
              <label>剖面方位角
                <input type="range" min={-180} max={180} step={1} value={azi} onChange={(e) => setAzi(Number(e.target.value))} />
              </label>
              <label>剖面仰角
                <input type="range" min={-90} max={90} step={1} value={elev} onChange={(e) => setElev(Number(e.target.value))} />
              </label>
            </div>
            <div className="brain-readout">
              <span>MNI 坐标</span>
              <b>{mni === null ? '--' : `${mni[0]}, ${mni[1]}, ${mni[2]}`}</b>
              {selected !== null && (
                <>
                  <span className="brain-readout-name">{regionLabel(selected)}</span>
                  <span className="brain-readout-en">{selected.en}</span>
                </>
              )}
            </div>
            <div className="brain-legend muted">数据：MNI152 模板 · Harvard-Oxford 图谱（研究用途）</div>
          </div>
        </div>
      </div>
    </div>
  );
}
