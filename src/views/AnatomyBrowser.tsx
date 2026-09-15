/**
 * M5 · 解剖结构浏览器：
 * 解析 manifest.json → 12 个系统 × 3478 个结构 → 可搜索树 → 点击创建笔记。
 *
 * manifest/词典加载与中文名查询在 core/anatomy.ts。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  loadZhDict,
  zhOrganName,
  type AnatomyManifest,
  type ManifestOrgan,
} from '../core/anatomy';
import type { KeyboardEvent } from 'react';
import { clickable } from './a11y';

// ---------- 系统中英文映射 ----------

const SYSTEM_NAMES: Record<string, string> = {
  articular: '关节',
  cardiovascular: '心血管',
  digestive: '消化',
  endocrine: '内分泌',
  integumentary: '皮肤',
  lymphatic: '淋巴',
  muscular: '肌肉',
  nervous: '神经',
  regional: '区域',
  renal: '泌尿',
  reproductive: '生殖',
  respiratory: '呼吸',
  skeletal: '骨骼',
};

// ---------- 组件 ----------

interface Props {
  /** 从已加载的 manifest 获取，由父组件传入 */
  manifest: AnatomyManifest | null;
  /** 当前选中结构（3D 与列表双向高亮） */
  selectedId: string | null;
  /** 列表点击 → 选中结构（在 3D 中高亮） */
  onSelectStructure: (organ: ManifestOrgan | null) => void;
  /** 打开/创建该结构的笔记 */
  onOpenNote: (organ: ManifestOrgan) => void;
  /** 关闭浏览器面板 */
}

// ---------- 结构路径格式化 ----------

function organLabel(organ: ManifestOrgan): string {
  return `${organ.name_en}`;
}

// ---------- 系统分组 ----------

function groupBySystem(organs: ManifestOrgan[]) {
  const groups: Record<string, ManifestOrgan[]> = {};
  for (const o of organs) {
    if (!groups[o.system]) groups[o.system] = [];
    groups[o.system].push(o);
  }
  return groups;
}

export default function AnatomyBrowser({ manifest, selectedId, onSelectStructure, onOpenNote }: Props) {
  const [query, setQuery] = useState('');
  const [openSystem, setOpenSystem] = useState<Set<string>>(new Set(['nervous', 'cardiovascular']));
  const [zh, setZh] = useState<{ organs: Map<string, string>; paths: Map<string, string> } | null>(null);

  useEffect(() => {
    void loadZhDict().then(setZh);
  }, []);

  /** 中文名：委托共享查询函数（词典未加载时返回 null → 界面回退英文） */
  const zhName = useCallback(
    (nameEn: string): string | null => {
      if (!zh) return null;
      return zhOrganName(nameEn, zh.organs);
    },
    [zh]
  );

  const zhPath = useCallback(
    (p: string): string => zh?.paths.get(p) ?? p,
    [zh]
  );

  const organs = useMemo(() => manifest?.organs ?? [], [manifest]);
  const selectedOrgan = useMemo(
    () => (selectedId && manifest ? manifest.organs.find((o) => o.organ_id === selectedId) ?? null : null),
    [selectedId, manifest]
  );
  const groups = useMemo(() => groupBySystem(organs), [organs]);
  const systemOrder = useMemo(
    () => manifest?.systems.map((s) => s.system) ?? [],
    [manifest]
  );

  // 搜索过滤（中英文均可）
  const filtered = useMemo(() => {
    if (!query.trim()) return organs;
    const q = query.toLowerCase();
    return organs.filter((o) => {
      const zhn = zhName(o.name_en);
      return (
        o.name_en.toLowerCase().includes(q) ||
        o.ta2_latin.toLowerCase().includes(q) ||
        o.organ_id.toLowerCase().includes(q) ||
        (zhn && zhn.includes(q)) ||
        o.path.some((p) => p.toLowerCase().includes(q) || (zh?.paths.get(p) ?? '').includes(q)) ||
        (SYSTEM_NAMES[o.system] ?? '').includes(q)
      );
    });
  }, [organs, query, zhName, zh]);

  // 按系统分组过滤结果
  const filteredGroups = useMemo(() => groupBySystem(filtered), [filtered]);

  if (!manifest) {
    return (
      <div className="anatomy-empty">
        <p>解剖数据加载中…</p>
        <p className="muted">数据来源：Anatria-3D · CC BY-SA 4.0</p>
      </div>
    );
  }

  /**
   * 结构列表的键盘导航：整棵树有上千行，逐行给 tabindex 会造出上千个 Tab 停靠点，
   * 所以这里用标准 listbox 的 roving tabindex —— 每个系统组在 Tab 顺序里只占一个点，
   * 组内用上下键/Home/End 移动。选中项所在组把停靠点给选中项，否则给该组第一项。
   */
  const onOrganKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.anatomy-organ'));
    if (!rows.length) return;
    e.preventDefault();
    const cur = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown' ? (cur < 0 ? 0 : Math.min(rows.length - 1, cur + 1))
      : e.key === 'ArrowUp' ? Math.max(0, cur < 0 ? 0 : cur - 1)
      : e.key === 'Home' ? 0
      : rows.length - 1;
    rows[next]?.focus();
  };

  return (
    <div className="anatomy-panel">
      <div className="anatomy-header">
        <span className="anatomy-title">结构列表</span>
        <span className="muted">{organs.length} 结构 · {systemOrder.length} 系统</span>
      </div>

      <input
        className="anatomy-search"
        placeholder="搜索结构（中英文均可）…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      <div className="anatomy-attribution muted">
        {manifest.attribution}
      </div>

      <div className="anatomy-tree">
        {systemOrder.map((sys) => {
          const count = (groups[sys] ?? []).length;
          const isOpen = openSystem.has(sys) || !!query.trim();
          const sysOrgans = filteredGroups[sys] ?? [];
          const tabStopId = sysOrgans.some((o) => o.organ_id === selectedId) ? selectedId : sysOrgans[0]?.organ_id;
          return (
            <div key={sys} className="anatomy-system">
              <div
                className={`anatomy-system-header ${isOpen ? 'open' : ''}`}
                onClick={() => {
                  const next = new Set(openSystem);
                  if (next.has(sys)) next.delete(sys);
                  else next.add(sys);
                  setOpenSystem(next);
                }}
                {...clickable(`${isOpen ? '收起' : '展开'}系统：${SYSTEM_NAMES[sys] ?? sys}`)}
              >
                <span className="system-chevron">{isOpen ? '▾' : '▸'}</span>
                <span className="system-name">{SYSTEM_NAMES[sys] ?? sys}</span>
                <span className="system-name-en">{sys}</span>
                <span className="system-count">{query.trim() ? sysOrgans.length : count}</span>
              </div>
              {isOpen && (
                <div
                  className="anatomy-organ-list"
                  role="listbox"
                  aria-label={`${SYSTEM_NAMES[sys] ?? sys} 结构`}
                  onKeyDown={onOrganKeyDown}
                >
                  {sysOrgans.map((o) => {
                    const zhn = zhName(o.name_en);
                    return (
                      <div
                        key={o.organ_id}
                        className={`anatomy-organ ${selectedId === o.organ_id ? 'selected' : ''}`}
                        role="option"
                        aria-selected={selectedId === o.organ_id}
                        tabIndex={o.organ_id === tabStopId ? 0 : -1}
                        onClick={() => onSelectStructure(selectedId === o.organ_id ? null : o)}
                        onDoubleClick={() => onOpenNote(o)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
                        }}
                        title={`${o.name_en}\n${o.ta2_latin}\n${o.path.join(' > ')}`}
                      >
                        <span className="organ-name">{zhn ?? organLabel(o)}</span>
                        <span className="organ-parent muted">
                          {zhn ? o.name_en : ''}
                          {o.path.length > 0 && ` · ${o.path.map(zhPath).join(' › ')}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {selectedOrgan && (
        <div className="anatomy-footer">
          <div className="footer-info">
            <div className="footer-name">{zhName(selectedOrgan.name_en) ?? selectedOrgan.name_en}</div>
            <div className="muted">{selectedOrgan.name_en} · {selectedOrgan.path.map(zhPath).join(' › ')}</div>
          </div>
          <button className="btn-primary footer-btn" onClick={() => onOpenNote(selectedOrgan)}>
            打开笔记 →
          </button>
        </div>
      )}
    </div>
  );
}
