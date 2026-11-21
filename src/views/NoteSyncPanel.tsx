import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toDataURL } from 'qrcode';
import { parseFrontmatterCached } from '../core/parser';
import { buildNotePack } from '../core/notePack';
import { isTauri } from '../storage/tauriEnv';
import PanelOverlay from './PanelOverlay';
import { escThenClose, useEsc } from './useEsc';

interface SyncInfo {
  landingUrl: string;
  expiresIn: number;
  ip: string;
  port: number;
}

interface Props {
  docs: ReadonlyMap<string, string>;
  paths: readonly string[];
  initialPath?: string | null;
  onClose: () => void;
}

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '无法启动手机同步，请确认桌面端是安装版。';
};

const titleOf = (path: string, docs: ReadonlyMap<string, string>): string => {
  const raw = docs.get(path) ?? '';
  const parsed = parseFrontmatterCached(path, raw);
  return parsed.title || (path.split('/').pop() ?? path).replace(/\.md$/i, '') || '未命名笔记';
};

const chapterOf = (path: string, docs: ReadonlyMap<string, string>): string => {
  const raw = docs.get(path) ?? '';
  const parsed = parseFrontmatterCached(path, raw);
  return parsed.meta.chapter.trim() || path.split('/').slice(0, -1).join('/');
};

const stopServer = () => {
  void invoke('stop_recite_sync').catch(() => {
    // 非 Tauri 环境或服务已结束时忽略。
  });
};

export default function NoteSyncPanel({ docs, paths, initialPath, onClose }: Props) {
  useEsc(escThenClose(onClose));
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const hasInitial = Boolean(initialPath && paths.includes(initialPath));
  const [selected, setSelected] = useState<Set<string>>(() => (hasInitial && initialPath ? new Set([initialPath]) : new Set()));
  const canAutoStart = isTauri() && hasInitial;
  const [started, setStarted] = useState(canAutoStart);
  const [info, setInfo] = useState<SyncInfo | null>(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(canAutoStart);
  const [nonce, setNonce] = useState(0);
  const [note, setNote] = useState('');

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return paths;
    return paths.filter((path) => {
      const title = titleOf(path, docs).toLowerCase();
      const chapter = chapterOf(path, docs).toLowerCase();
      return path.toLowerCase().includes(needle) || title.includes(needle) || chapter.includes(needle);
    });
  }, [deferredQuery, docs, paths]);

  const visible = useMemo(() => filtered.slice(0, 300), [filtered]);
  const selectedPaths = useMemo(() => paths.filter((path) => selected.has(path)), [paths, selected]);
  const pack = useMemo(
    () => (selectedPaths.length ? buildNotePack(docs, selectedPaths) : ''),
    [docs, selectedPaths],
  );
  // 出码后列表让位：面板高度锁在 86vh，列表还在就会把二维码区挤成一条可滚动窄缝。
  const showQr = !busy && !error && Boolean(info && qr);

  const invalidate = () => {
    setStarted(false);
    setInfo(null);
    setQr('');
    setError('');
    setBusy(false);
    setNote('');
    stopServer();
  };

  const toggle = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    invalidate();
  };

  const selectVisible = () => {
    setSelected(new Set(filtered));
    invalidate();
  };

  const clearAll = () => {
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
  }, [pack, started, nonce]);

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
    <PanelOverlay onClose={onClose} label="选择笔记发送到手机">
      <section className="note-sync" aria-label="选择笔记发送到手机">
        <header className="note-sync__head">
          <div>
            <div className="wd-idle__title">笔记发送到手机</div>
            <p>从章节目录里勾选笔记，生成一次性二维码。手机上只读展示 Markdown 正文。</p>
          </div>
          <button className="btn btn-small" type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="note-sync__tools">
          <input
            className="note-sync__search"
            type="search"
            aria-label="搜索要发送的笔记"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、章节或路径"
          />
          <div className="note-sync__pickactions">
            <button className="btn btn-small" type="button" onClick={selectVisible} disabled={busy || !filtered.length}>
              全选结果
            </button>
            <button className="btn btn-small" type="button" onClick={clearAll} disabled={busy || !selected.size}>
              清空
            </button>
          </div>
        </div>

        <div className="note-sync__summary">
          已选 <b>{selected.size}</b> 篇 · 当前结果 {filtered.length} 篇
          {filtered.length > visible.length ? `（只显示前 ${visible.length} 篇，继续搜索可缩小范围）` : ''}
        </div>

        <div className="note-sync__list" role="group" aria-label="选择笔记" hidden={showQr}>
          {visible.length === 0 ? (
            <p className="wd-empty">没有匹配的笔记。</p>
          ) : (
            visible.map((path) => {
              const checked = selected.has(path);
              return (
                <label className={`note-sync__item${checked ? ' is-on' : ''}`} key={path}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy}
                    onChange={() => toggle(path)}
                  />
                  <span className="note-sync__copy">
                    <b>{titleOf(path, docs)}</b>
                    <small>
                      {chapterOf(path, docs) || '未分章节'} · {path}
                    </small>
                  </span>
                </label>
              );
            })
          )}
        </div>

        <footer className="note-sync__foot">
          <button className="btn btn-primary" type="button" onClick={start} disabled={!selected.size || busy}>
            {busy ? '正在生成…' : info ? '用所选重新生成' : '生成手机二维码'}
          </button>
          <span>将发送 {selectedPaths.length} 篇笔记</span>
        </footer>

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
          <div className="note-sync__qrbody">
            <div className="wd-sync__qr">
              <img src={qr} alt="手机扫码导入笔记" width="440" height="440" />
            </div>
            <div className="wd-sync__guide">
              <ol>
                <li>手机和电脑连接同一个 Wi-Fi。</li>
                <li>用手机系统相机扫描二维码。</li>
                <li>打开「晶格背诵」，从「同步笔记」阅读。</li>
              </ol>
              <p className="wd-sync__meta">
                局域网地址 {info.ip}:{info.port} · {Math.round(info.expiresIn / 60)} 分钟内有效 ·
                仅可导入一次
              </p>
              <div className="wd-sync__actions">
                <button className="btn btn-small" type="button" onClick={() => void copyLink()}>
                  复制链接
                </button>
                <button className="btn btn-small" type="button" onClick={invalidate}>
                  重新选择
                </button>
              </div>
              {note && <p className="wd-sync__note">{note}</p>}
              <p className="wd-sync__hint">
                笔记里的本地图片附件暂不随包传输；正文 Markdown 可正常阅读。
              </p>
            </div>
          </div>
        )}
      </section>
    </PanelOverlay>
  );
}
