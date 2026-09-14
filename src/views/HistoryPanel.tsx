/**
 * 历史版本面板：查看当前笔记的历史快照并一键恢复；
 * 同时列出「已删除笔记」的残留快照，误删的笔记可从这里找回（core/history）。
 */
import { useCallback, useEffect, useState } from 'react';
import { listSnapshots, listSnapshotPaths, type Snapshot } from '../core/history';
import { toast, confirmBox } from '../core/feedback';
import { IconHistory } from './icons';

interface Props {
  currentPath: string | null;
  /** 全库现存笔记路径（用于区分「已删除」快照） */
  existingPaths: Set<string>;
  /** 恢复（覆盖现存笔记或找回已删除笔记）：写回 vault 并打开 */
  onRestore: (path: string, content: string) => Promise<void>;
  onClose: () => void;
}

const fmtTime = (at: number) =>
  new Date(at).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

export default function HistoryPanel({ currentPath, existingPaths, onRestore, onClose }: Props) {
  const [current, setCurrent] = useState<Snapshot[]>([]);
  const [deleted, setDeleted] = useState<Map<string, Snapshot[]>>(new Map());
  const [preview, setPreview] = useState<Snapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [cur, allPaths] = await Promise.all([
      currentPath ? listSnapshots(currentPath) : Promise.resolve<Snapshot[]>([]),
      listSnapshotPaths(),
    ]);
    const del = new Map<string, Snapshot[]>();
    for (const p of allPaths.keys()) {
      if (p === currentPath || existingPaths.has(p)) continue;
      del.set(p, await listSnapshots(p));
    }
    setCurrent(cur);
    setDeleted(del);
    setPreview(null);
    setLoaded(true);
  }, [currentPath, existingPaths]);

  useEffect(() => { void load(); }, [load]);

  const restore = async (snap: Snapshot, deletedNote: boolean) => {
    const ok = await confirmBox({
      title: deletedNote ? `找回「${snap.path.replace(/\.md$/, '')}」？` : '恢复此版本？',
      detail: deletedNote
        ? '将以该快照内容重新创建这篇笔记。'
        : `当前内容会被保存为新的历史快照，可随时再次恢复。\n快照时间：${fmtTime(snap.at)}`,
      okText: deletedNote ? '找回笔记' : '恢复',
    });
    if (!ok) return;
    try {
      await onRestore(snap.path, snap.content);
      toast(deletedNote ? `已找回：${snap.path}` : '已恢复此版本', 'ok');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const snapRow = (snap: Snapshot, deletedNote: boolean) => (
    <div key={`${snap.path}-${snap.at}`} className={`hist-row${preview === snap ? ' active' : ''}`}>
      <button className="hist-main" onClick={() => setPreview(preview === snap ? null : snap)}>
        <b>{fmtTime(snap.at)}</b>
        <span className="muted">{snap.content.length} 字</span>
        <span className="hist-excerpt muted">{snap.content.replace(/\s+/g, ' ').slice(0, 42)}</span>
      </button>
      <button className="btn-small hist-restore" onClick={() => void restore(snap, deletedNote)}>
        {deletedNote ? '找回' : '恢复'}
      </button>
    </div>
  );

  return (
    <div className="panel-backdrop quiz-overlay" onClick={onClose}>
      <div className="quiz-panel history-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head quiz-header">
          <span className="panel__title quiz-title">历史版本 · 快照与找回</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="history-body">
          {!loaded && <p className="muted">读取快照中…</p>}
          {loaded && (
            <>
              <div className="hist-section">
                <h4>当前笔记{currentPath ? ` · ${currentPath.replace(/\.md$/, '')}` : ''}</h4>
                {!currentPath && <p className="muted">未打开笔记。删除笔记后可从下方「已删除笔记」找回。</p>}
                {currentPath && current.length === 0 && (
                  <p className="muted">还没有快照。每次保存会自动留档，保留最近 10 条。</p>
                )}
                {current.length > 0 && (
                  <div className="hist-list">{current.map((s) => snapRow(s, false))}</div>
                )}
              </div>

              <div className="hist-section">
                <h4>已删除笔记{deleted.size > 0 ? ` · ${deleted.size} 篇可找回` : ''}</h4>
                {deleted.size === 0 && <p className="muted">暂无可找回的删除记录。</p>}
                {[...deleted.entries()].map(([path, snaps]) => (
                  <div key={path} className="hist-deleted">
                    <div className="hist-deleted-head">
                      <IconHistory size={13} />
                      <b>{path.replace(/\.md$/, '')}</b>
                      <span className="muted">{snaps.length} 份快照 · 最近 {fmtTime(snaps[0].at)}</span>
                    </div>
                    <div className="hist-list">{snaps.map((s) => snapRow(s, true))}</div>
                  </div>
                ))}
              </div>

              {preview && (
                <div className="hist-preview">
                  <div className="hist-preview-head">
                    <b>{fmtTime(preview.at)} 快照预览</b>
                    <span className="muted">{preview.path}</span>
                  </div>
                  <textarea className="quiz-paste" readOnly value={preview.content} rows={8} />
                </div>
              )}
            </>
          )}
        </div>

        <div className="quiz-actions">
          <span className="muted hist-hint">每次保存自动留档，每篇保留最近 10 份快照</span>
          <button className="btn-small" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
