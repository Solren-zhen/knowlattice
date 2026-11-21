import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toDataURL } from 'qrcode';
import { applyReviewDelta } from '../core/reciteReview';
import { buildRecitePack } from '../core/recitePack';
import type { StoryArchiveEntry } from '../core/wordStory';
import { isTauri } from '../storage/tauriEnv';

interface SyncInfo {
  url: string;
  landingUrl: string;
  deepLink: string;
  expiresIn: number;
  ip: string;
  port: number;
}

interface Props {
  entries: StoryArchiveEntry[];
  initialSelectedId?: string | null;
  onClose: () => void;
}

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '无法启动手机同步，请确认桌面端是安装版。';
};

const stamp = (ts: number): string => {
  if (!ts) return '未知时间';
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export default function ReciteSyncPanel({ entries, initialSelectedId, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => {
    const first = initialSelectedId && entries.some((entry) => entry.id === initialSelectedId)
      ? initialSelectedId
      : entries[0]?.id;
    return new Set(first ? [first] : []);
  });
  const canAutoStart = isTauri() && entries.length > 0 && Boolean(initialSelectedId || entries.length === 1);
  const [started, setStarted] = useState(canAutoStart);
  const [info, setInfo] = useState<SyncInfo | null>(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(canAutoStart);
  const [nonce, setNonce] = useState(0);
  const [note, setNote] = useState('');
  const [review, setReview] = useState<{ added: number; skipped: number; words: number } | null>(null);
  const [reviewError, setReviewError] = useState('');

  useEffect(() => {
    let disposed = false;
    const handler = (event: { payload: unknown }) => {
      if (disposed) return;
      try {
        const raw = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        const result = applyReviewDelta(raw);
        setReview({ added: result.added, skipped: result.skipped, words: result.words.length });
        setReviewError('');
      } catch (reason) {
        setReviewError(reason instanceof Error ? reason.message : '手机回传的复习记录无法识别。');
      }
    };
    const pending = listen<unknown>('recite-review', handler).catch(() => null);
    return () => {
      disposed = true;
      void pending.then((unlisten) => unlisten?.());
    };
  }, []);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.id)),
    [entries, selected],
  );
  const pack = useMemo(
    () => (selectedEntries.length ? buildRecitePack(selectedEntries) : ''),
    [selectedEntries],
  );

  const stopServer = () => {
    void invoke('stop_recite_sync').catch(() => {
      // 不在 Tauri 中或服务已结束时忽略。
    });
  };

  const invalidate = () => {
    setStarted(false);
    setInfo(null);
    setQr('');
    setError('');
    setBusy(false);
    setNote('');
    setReview(null);
    setReviewError('');
    stopServer();
  };

  const toggle = (id: string) => {
    if (busy) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    invalidate();
  };

  const selectAll = () => {
    if (busy) return;
    setSelected(new Set(entries.map((entry) => entry.id)));
    invalidate();
  };

  const clearAll = () => {
    if (busy) return;
    setSelected(new Set());
    invalidate();
  };

  const start = () => {
    if (!pack || busy) return;
    if (!isTauri()) {
      setError('手机同步只在桌面安装版可用：请在桌面窗口中生成二维码。');
      return;
    }
    setError('');
    setQr('');
    setInfo(null);
    setNote('');
    setReview(null);
    setReviewError('');
    setBusy(true);
    setStarted(true);
    setNonce((value) => value + 1);
  };

  useEffect(() => {
    if (!started || !pack) return undefined;
    let alive = true;

    const run = async () => {
      try {
        const next = await invoke<SyncInfo>('start_recite_sync', { pack });
        if (!alive) {
          stopServer();
          return;
        }
        const image = await toDataURL(next.landingUrl, {
          width: 440,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#0f172a', light: '#ffffff' },
        });
        if (!alive) return;
        setInfo(next);
        setQr(image);
      } catch (reason) {
        if (alive) setError(errorText(reason));
        else stopServer();
      } finally {
        if (alive) setBusy(false);
      }
    };

    void run();
    return () => {
      alive = false;
      stopServer();
    };
  }, [started, pack, nonce]);

  const copyLink = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.landingUrl);
      setNote('链接已复制：手机点「粘贴电脑链接」或微信发给自己后粘贴即可导入。');
    } catch {
      setNote('复制失败，请直接使用二维码。');
    }
  };

  return (
    <section className="wd-sync" aria-label="手机扫码导入">
      <div className="wd-sync__head">
        <div>
          <div className="wd-idle__title">手机导入</div>
          <p className="wd-sync__intro">
            勾选要带到手机的短文，可多选。取包链接只能成功一次；背诵包服务会保留 60 分钟接收手机回传的复习记录。
          </p>
        </div>
        <button className="btn btn-small" type="button" onClick={onClose}>
          收起
        </button>
      </div>

      <div className="wd-sync__pickbar">
        <span>
          已选 <b>{selected.size}</b> / {entries.length} 篇
        </span>
        <div className="wd-sync__pickactions">
          <button className="btn btn-small" type="button" onClick={selectAll} disabled={busy || !entries.length}>
            全选
          </button>
          <button className="btn btn-small" type="button" onClick={clearAll} disabled={busy || !selected.size}>
            清空
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="wd-empty">还没有可导入的短文。先生成一篇短文，或从历史里打开一篇。</p>
      ) : (
        <div className="wd-sync__list" role="group" aria-label="选择要导入手机的短文">
          {entries.map((entry) => {
            const checked = selected.has(entry.id);
            return (
              <label className={`wd-sync__item${checked ? ' is-on' : ''}`} key={entry.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy}
                  onChange={() => toggle(entry.id)}
                />
                <span className="wd-sync__item-copy">
                  <b>{entry.story.title}</b>
                  <small>
                    {stamp(entry.createdAt)} · {entry.bankName || '单词工坊'} · {entry.words.length} 个目标词
                    {entry.analysis ? ` · ${entry.analysis.lines.length} 句精读` : ''}
                  </small>
                </span>
              </label>
            );
          })}
        </div>
      )}

      <div className="wd-sync__generate">
        <button className="btn btn-primary" type="button" onClick={start} disabled={!selected.size || busy}>
          {busy ? '正在生成…' : info ? '用所选重新生成' : '生成手机二维码'}
        </button>
        <span>将导入 {selectedEntries.length} 篇短文</span>
      </div>

      {busy && (
        <div className="wd-sync__state" role="status">
          <i aria-hidden="true" />
          正在生成一次性二维码…
        </div>
      )}

      {error && (
        <div className="wd-sync__error" role="alert">
          <span>{error}</span>
          <button className="btn btn-small" type="button" onClick={start}>
            重试
          </button>
        </div>
      )}

      {!busy && !error && info && qr && (
        <div className="wd-sync__body">
          <div className="wd-sync__qr">
            <img src={qr} alt="手机扫码导入背诵包" width="440" height="440" />
          </div>
          <div className="wd-sync__guide">
            <ol>
              <li>手机和电脑连接同一个 Wi-Fi。</li>
              <li>用手机系统相机扫描二维码，不要用微信扫一扫。</li>
              <li>打开「晶格背诵」，等待提示导入完成。</li>
              <li>背完后在手机上点「回传复习记录」，保持本页打开即可自动合并。</li>
            </ol>
            <p className="wd-sync__meta">
              局域网地址 {info.ip}:{info.port} · {Math.round(info.expiresIn / 60)} 分钟内有效 ·
              取包仅一次，回传可多次
            </p>
            <div className="wd-sync__actions">
              <button className="btn btn-small" type="button" onClick={() => void copyLink()}>
                复制链接
              </button>
              <button className="btn btn-small" type="button" onClick={() => invalidate()}>
                重新选择
              </button>
            </div>
            {note && <p className="wd-sync__note">{note}</p>}
            {info && !review && !reviewError && (
              <div className="wd-sync__waiting" role="status">
                <i aria-hidden="true" />
                等待手机回传… 背完在手机上点「回传复习记录」，结果会显示在这里。
              </div>
            )}
            {(review || reviewError) && (
              <div className="wd-sync__received" role="status" aria-live="polite">
                {reviewError ? (
                  <span>{reviewError}</span>
                ) : review ? (
                  <span>
                    手机已回传：新增 {review.added} 条复习记录
                    {review.skipped ? `，跳过 ${review.skipped} 条重复/过期记录` : ''}
                    {review.words ? `，更新 ${review.words} 个词` : ''}。
                  </span>
                ) : null}
              </div>
            )}
            <p className="wd-sync__hint">
              取包失败时检查 Windows 防火墙是否允许当前应用访问专用网络，或让手机重新连接同一 Wi-Fi。
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
