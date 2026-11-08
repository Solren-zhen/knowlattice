/**
 * 数据自检面板：把「库里有没有指向空气的记录」变成可执行的检查与安全修复。
 *
 * 数据源由 Workspace 传入（笔记 docs / 附件路径 / 双链索引），题库统计与收藏
 * 从 storage/qbank 读。检查与修复全部走 core/integrity 的纯函数；
 * 这里只负责加载、确认与调用存储层。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import DialogSurface from './DialogSurface';
import PanelOverlay from './PanelOverlay';
import { useEsc, escThenClose } from './useEsc';
import { toast, confirmBox } from '../core/feedback';
import { downloadFile } from '../core/anki';
import {
  checkIntegrity,
  integrityReport,
  integritySummary,
  planRepairs,
  SEVERITY_LABEL,
  type IntegrityCheck,
  type IntegrityData,
} from '../core/integrity';
import {
  getAllBanks,
  getAllQuestionStats,
  getAllStars,
  removeQuestionStat,
  removeStar,
} from '../storage/qbank';
import type { LinkIndex } from '../core/linkIndex';

interface Props {
  docs: ReadonlyMap<string, string>;
  attachmentPaths: readonly string[];
  linkIndex: LinkIndex;
  onClose: () => void;
}

const stamp = (at: number) => new Date(at).toISOString().slice(0, 19).replace(/[:T]/g, '-');

export default function IntegrityView(p: Props) {
  const [checks, setChecks] = useState<IntegrityCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastFix, setLastFix] = useState<{ at: number; removedStats: number; removedStars: number } | null>(null);
  useEsc(escThenClose(p.onClose));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [banks, stats, stars] = await Promise.all([getAllBanks(), getAllQuestionStats(), getAllStars()]);
      const data: IntegrityData = {
        banks,
        stats,
        stars,
        docs: p.docs,
        attachmentPaths: p.attachmentPaths,
        linkIndex: p.linkIndex,
      };
      setChecks(checkIntegrity(data));
      setError('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [p.docs, p.attachmentPaths, p.linkIndex]);

  useEffect(() => {
    // 放到微任务里：加载完成后的 setState 不在 effect 同步阶段触发
    void Promise.resolve().then(load);
  }, [load]);

  const summary = useMemo(() => integritySummary(checks), [checks]);
  const plan = useMemo(() => planRepairs(checks), [checks]);

  async function fix() {
    if (!plan.ops.length) return;
    const ok = await confirmBox({
      title: '修复数据自检？',
      detail: `将删除 ${plan.ops.filter((op) => op.kind === 'remove-stat').length} 条悬空统计、${plan.ops.filter((op) => op.kind === 'remove-star').length} 条悬空收藏。不会修改题目、笔记或附件。`,
      danger: true,
      okText: '修复',
    });
    if (!ok) return;
    setBusy(true);
    let removedStats = 0;
    let removedStars = 0;
    try {
      for (const op of plan.ops) {
        if (op.kind === 'remove-stat') {
          await removeQuestionStat(op.bank, op.qid);
          removedStats += 1;
        } else {
          await removeStar(op.bank, op.qid);
          removedStars += 1;
        }
      }
      setLastFix({ at: Date.now(), removedStats, removedStars });
      toast(`已修复：删除统计 ${removedStats} 条、收藏 ${removedStars} 条`, 'ok');
      await load();
    } catch (e: unknown) {
      toast(`修复失败：${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  function exportReport() {
    const text = integrityReport(checks, {
      at: Date.now(),
      removedStats: lastFix?.removedStats,
      removedStars: lastFix?.removedStars,
    });
    downloadFile(`knowlattice-integrity-${stamp(Date.now())}.md`, text);
  }

  return (
    <PanelOverlay tone="plain" onClose={p.onClose}>
      <DialogSurface className="panel integrity-panel" label="数据自检" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head">
          <span className="panel__title">数据自检</span>
          <span className="panel__actions">
            <button className="btn-small" onClick={exportReport} disabled={!checks.length}>导出报告</button>
            <button className="btn-small" onClick={fix} disabled={busy || !plan.ops.length}>
              {busy ? '修复中…' : plan.ops.length ? `修复 ${plan.ops.length} 项` : '无需修复'}
            </button>
            <button className="btn-small" onClick={p.onClose}>关闭</button>
          </span>
        </div>

        <div className="panel__body integrity-body">
          {loading && <p className="settings-note">正在读取题库与笔记索引…</p>}
          {error && <p className="load-error">读取失败：{error}</p>}
          {!loading && !error && (
            <>
              <div className="integrity-summary">
                <div className="integrity-kpi">
                  <span className="integrity-kpi__num">{summary.issues}</span>
                  <span className="integrity-kpi__label">问题条目</span>
                </div>
                <div className="integrity-kpi">
                  <span className="integrity-kpi__num">{summary.problems}</span>
                  <span className="integrity-kpi__label">涉及检查项</span>
                </div>
                <div className="integrity-kpi">
                  <span className="integrity-kpi__num">{plan.ops.length}</span>
                  <span className="integrity-kpi__label">可安全修复</span>
                </div>
                <p className="integrity-note">
                  只删除指向不存在题库/题目的统计与收藏；断链、空题干、疑似孤儿附件只报告，不自动改。
                </p>
              </div>

              {checks.map((check) => (
                <section key={check.id} className={`it-check${check.count === 0 ? ' is-clean' : ''}`}>
                  <header className="it-check__head">
                    <span className={`it-badge it-${check.severity}`}>{SEVERITY_LABEL[check.severity]}</span>
                    <h3 className="it-check__title">{check.title}</h3>
                    <span className="it-check__count">{check.count === 0 ? '正常' : `${check.count} 条`}</span>
                  </header>
                  <p className="it-check__hint">{check.fixable ? check.fixNote : `只报告：${check.fixNote}`}</p>
                  {check.count > 0 && (
                    <ul className="it-items">
                      {check.items.slice(0, 50).map((item) => (
                        <li key={item.id}>
                          <span className="it-item__title">{item.title}</span>
                          <span className="it-item__detail">{item.detail}</span>
                        </li>
                      ))}
                      {check.count > 50 && <li className="it-item__more">… 其余 {check.count - 50} 条见导出报告</li>}
                    </ul>
                  )}
                </section>
              ))}
              {checks.every((check) => check.count === 0) && (
                <p className="integrity-ok">全部检查通过：题库统计、收藏、题目、双链与附件都没有发现悬空记录。</p>
              )}
            </>
          )}
        </div>
      </DialogSurface>
    </PanelOverlay>
  );
}
