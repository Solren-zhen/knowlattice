/**
 * 设置面板：所有「配一次就很少再动」的东西都在这里。
 *
 * 为什么要有这个面板：这些项以前占着左侧导航轨（字体 / 高亮 / 主题 / 关于与许可 / 备份 / 导入），
 * 导航轨因此从「我要去哪儿」退化成「功能清单」——每加一个功能就多一行，最后二十多行谁也扫不过来。
 * 分界线现在按用途划：左侧只放**去处**（目录、搜索、题库、复习、错题），
 * 动作放在它作用的对象旁边（打印/历史/视频在笔记工具条），
 * 低频功能的入口在**左侧导航轨**（Rail），配置放这里。
 * 所以这里不再列 PDF / 转换 / 历史：它们是功能，不是设置。
 *
 * 面板不做二级页面：设置项本来就少，一屏能看完比点三次进去找更省事。
 */
import { useState } from 'react';
import DialogSurface from './DialogSurface';
import { useEsc, escThenClose } from './useEsc';
import { IconBackup, IconFile, IconInfo } from './icons';
import {
  applyFont, applyTheme, currentFont, currentTheme, FONT_LABELS,
  type Font, type Theme,
} from '../core/theme';
import { applyHighlight, currentHighlight, HIGHLIGHT_PRESETS } from '../core/highlight';

interface Props {
  onClose: () => void;
  /** 整包备份到文件（笔记 + 题库 + 生词本 + 复习进度） */
  onBackup: () => void;
  /** 打开统一导入入口（恢复备份也走这里） */
  onImport: () => void;
  /** 安全与隐私说明 */
  onNotice: () => void;
}

export default function SettingsPanel(p: Props) {
  const [font, setFont] = useState<Font>(currentFont);
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [hl, setHl] = useState<string>(currentHighlight);
  useEsc(escThenClose(p.onClose));

  return (
    <div className="panel-backdrop" onClick={p.onClose}>
      <DialogSurface className="panel settings-panel" label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head">
          <span className="panel__title">设置</span>
          <button className="btn-small" onClick={p.onClose}>关闭</button>
        </div>

        <div className="settings-body">
          <section className="settings-sec" aria-label="外观">
            <h3 className="settings-sec__title">外观</h3>

            <div className="settings-row">
              <span className="settings-row__label">字体</span>
              <div className="settings-chips" role="group" aria-label="字体样式">
                {(['system', 'serif', 'mono'] as Font[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`chip${font === f ? ' on' : ''}`}
                    aria-pressed={font === f}
                    onClick={() => { applyFont(f); setFont(f); }}
                  >
                    {FONT_LABELS[f]}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-row">
              <span className="settings-row__label">主题</span>
              <div className="settings-chips" role="group" aria-label="主题">
                {(['light', 'dark'] as Theme[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`chip${theme === t ? ' on' : ''}`}
                    aria-pressed={theme === t}
                    onClick={(event) => {
                      // 传点击坐标：主题切换会做一次从按钮扩散的圆形揭示
                      applyTheme(t, { x: event.clientX, y: event.clientY });
                      setTheme(t);
                    }}
                  >
                    {t === 'dark' ? '深色' : '浅色'}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-row">
              <span className="settings-row__label">高亮色</span>
              <div className="rail-hl-swatches">
                {HIGHLIGHT_PRESETS.map((preset) => (
                  <button
                    key={preset.bg}
                    type="button"
                    className={`rail-hl-swatch${hl === preset.bg ? ' active' : ''}`}
                    style={{ background: preset.bg }}
                    aria-label={`高亮色：${preset.name}`}
                    aria-pressed={hl === preset.bg}
                    title={preset.name}
                    onClick={() => { applyHighlight(preset.bg); setHl(preset.bg); }}
                  />
                ))}
                <label className="rail-hl-custom">
                  <span>自定义</span>
                  <input
                    type="color"
                    value={hl}
                    aria-label="自定义高亮色"
                    onChange={(event) => { applyHighlight(event.target.value); setHl(event.target.value); }}
                  />
                </label>
              </div>
            </div>
          </section>

          <section className="settings-sec" aria-label="数据">
            <h3 className="settings-sec__title">数据</h3>
            <p className="settings-note">
              全部数据只存本机。备份文件包含笔记、附件、PDF 书架、题库、生词本与复习进度，换机器时用它恢复。
            </p>
            <div className="settings-actions">
              <button className="btn-small" onClick={p.onBackup}>
                <IconBackup /> 备份到文件
              </button>
              <button className="btn-small" onClick={p.onImport}>
                <IconFile /> 导入（笔记 / 题库 / 内容包）
              </button>
            </div>
          </section>

          <section className="settings-sec" aria-label="关于">
            <h3 className="settings-sec__title">关于</h3>
            <div className="settings-actions">
              <button className="btn-small" onClick={p.onNotice}>
                <IconInfo /> 安全与隐私说明
              </button>
            </div>
          </section>
        </div>
      </DialogSurface>
    </div>
  );
}
