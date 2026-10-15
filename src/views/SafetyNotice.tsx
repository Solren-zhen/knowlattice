import { useEffect, useState, useSyncExternalStore } from 'react';
import { useEsc, escThenClose } from './useEsc';
import {
  checkForUpdate,
  installUpdate,
  isDesktopApp,
  subscribeUpdate,
  updateState,
} from '../core/updater';
import { IconClose, IconInfo } from './icons';

interface Props {
  onClose: () => void;
}

export default function SafetyNotice({ onClose }: Props) {
  useEsc(escThenClose(onClose));
  const legalUrl = `${import.meta.env.BASE_URL}legal.md`;
  // 版本与更新：状态全部来自 core/updater 的共享 store（右下角更新卡片读的是同一份）。
  // 这里只负责「显示 + 手动触发一次检查/安装」，不再自己维护一份进度。
  const [version, setVersion] = useState('');
  const upd = useSyncExternalStore(subscribeUpdate, updateState);

  useEffect(() => {
    if (!isDesktopApp()) return;
    void (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        setVersion(await getVersion());
      } catch { /* 忽略 */ }
    })();
  }, []);

  return (
    <div className="notice-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="notice-panel" role="dialog" aria-modal="true" aria-labelledby="notice-title">
        <header className="notice-header">
          <h2 id="notice-title"><IconInfo /> 关于与许可</h2>
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
        </header>
        <div className="notice-body">
          <section>
            <h3>医学内容边界</h3>
            <p>本应用仅供学习、科研与教育使用，不构成诊断、治疗或其他医疗建议。题库、笔记和 AI 输出都不应直接作为医疗决策依据。</p>
          </section>
          <section>
            <h3>数据与隐私</h3>
            <p>笔记、题库和学习记录默认保存在当前浏览器或本机应用中。AI 助手连接第三方网站；在其中输入的内容由对应平台处理，请勿输入可识别个人信息、病历、未公开资料或受版权限制的原文。</p>
          </section>
          <section>
            <h3>许可与再分发</h3>
            <p>源代码采用 GPL-3.0。解剖模型、脑图谱和依赖库保留各自许可证，尤其需要遵守署名、ShareAlike 或数据集专用条款。私有题库不属于公开网页构建内容；向他人分发受版权保护的内容前，应先确认拥有授权或适用法定例外。</p>
            <a className="notice-link" href={legalUrl} target="_blank" rel="noreferrer">查看公开版许可与数据说明</a>
          </section>
          <section>
            <h3>版本与更新</h3>
            {!isDesktopApp() ? (
              <p>当前为网页版，无自动更新。桌面版会自动检查新版本（更新经签名校验，来源 GitHub Releases）。</p>
            ) : (
              <>
                <p>当前版本 {version || '…'}</p>
                <div className="notice-actions">
                  <button
                    className="btn-small"
                    disabled={upd.phase === 'checking' || upd.phase === 'downloading' || upd.phase === 'installing'}
                    onClick={() => void checkForUpdate({ manual: true })}
                  >
                    {upd.phase === 'checking' ? '检查中…'
                      : upd.phase === 'downloading' ? `下载中… ${upd.pct !== null ? upd.pct + '%' : ''}`
                      : upd.phase === 'installing' ? '安装中…'
                      : '检查更新'}
                  </button>
                  {upd.phase === 'available' && (
                    <button className="btn-small" onClick={() => void installUpdate()}>
                      下载并安装 v{upd.version}
                    </button>
                  )}
                </div>
                {upd.phase === 'current' && <p className="muted">已是最新版本</p>}
                {upd.phase === 'error' && <p className="muted">检查失败：{upd.error}</p>}
                {upd.phase === 'available' && (
                  <p className="muted">发现新版本 v{upd.version}，安装后应用会自动重启（右下角更新卡片也可操作）。</p>
                )}
                {upd.phase === 'installing' && <p className="muted">正在安装，完成后应用会自动重启。</p>}
              </>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
