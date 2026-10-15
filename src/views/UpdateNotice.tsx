/**
 * 右下角更新卡片：软件内自动更新的唯一交互面。
 *
 * 只负责「把 core/updater 的状态画出来」——检查/下载/安装/跳过全在 core 里，
 * 「关于与许可」面板读的是同一份状态，所以两边不会各说一套。
 * 非模态：不拦操作、不抢焦点，出现时机由 core/updater 的 noticeVisible 决定
 * （有更新、下载中、安装中、用户手动检查有回音）。
 */
import { useSyncExternalStore } from 'react';
import {
  checkForUpdate,
  dismissUpdate,
  installUpdate,
  noticeVisible,
  skipUpdateVersion,
  subscribeUpdate,
  updateState,
} from '../core/updater';
import { IconClose, IconInfo } from './icons';

function titleOf(phase: string): string {
  switch (phase) {
    case 'checking':
      return '正在检查更新';
    case 'current':
      return '已是最新版本';
    case 'available':
      return '有可用更新';
    case 'downloading':
      return '正在下载更新';
    case 'installing':
      return '正在安装更新';
    default:
      return '更新检查失败';
  }
}

export default function UpdateNotice() {
  const s = useSyncExternalStore(subscribeUpdate, updateState);
  if (!noticeVisible(s)) return null;

  const busy = s.phase === 'downloading' || s.phase === 'installing';
  const pct = s.pct;

  return (
    <aside
      className="update-notice"
      role={s.phase === 'error' ? 'alert' : 'status'}
      aria-label="软件更新"
    >
      <div className="update-notice__head">
        <span className="update-notice__glyph" aria-hidden="true"><IconInfo size={15} /></span>
        <h2 className="update-notice__title">{titleOf(s.phase)}</h2>
        {!busy && (
          <button className="btn-icon" onClick={dismissUpdate} aria-label="关闭更新提示"><IconClose /></button>
        )}
      </div>

      {s.phase === 'checking' && <p className="update-notice__meta">正在连接更新源…</p>}

      {s.phase === 'current' && (
        <p className="update-notice__meta">当前版本 {s.current || '已是最新'}</p>
      )}

      {s.phase === 'available' && (
        <>
          <p className="update-notice__meta">
            {s.current ? `v${s.current} → ` : ''}新版本 v{s.version}
          </p>
          {s.notes && <p className="update-notice__notes">{s.notes}</p>}
          <div className="update-notice__actions">
            <button className="btn-small update-notice__go" onClick={() => void installUpdate()}>下载并安装</button>
            <button className="btn-small" onClick={() => void skipUpdateVersion()}>跳过此版本</button>
          </div>
        </>
      )}

      {busy && (
        <>
          <p className="update-notice__meta">
            {s.phase === 'installing'
              ? '正在安装，完成后应用会自动重启'
              : `正在下载 v${s.version}${pct !== null ? ` · ${pct}%` : ''}`}
          </p>
          <div
            className={`update-notice__bar${pct === null ? ' indet' : ''}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct === null ? undefined : pct}
            aria-label="更新下载进度"
          >
            <i style={pct === null ? undefined : { width: `${pct}%` }} />
          </div>
        </>
      )}

      {s.phase === 'error' && (
        <>
          <p className="update-notice__err">{s.error}</p>
          <div className="update-notice__actions">
            <button className="btn-small" onClick={() => void checkForUpdate({ manual: true })}>重试</button>
          </div>
        </>
      )}
    </aside>
  );
}
