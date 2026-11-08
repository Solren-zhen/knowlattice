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
import { useEffect, useMemo, useState } from 'react';
import DialogSurface from './DialogSurface';
import { useEsc, escThenClose } from './useEsc';
import { IconBackup, IconFile, IconInfo } from './icons';
import {
  applyFont, applyTheme, currentFont, currentTheme, FONT_LABELS,
  type Font, type Theme,
} from '../core/theme';
import { isPetHidden, setPetHidden, subscribePet } from '../core/pet';
import { applyHighlight, currentHighlight, HIGHLIGHT_PRESETS } from '../core/highlight';
import {
  degradationMessage, detectEnvironment, requestPersistence, supportTable,
  type PersistState,
} from '../core/capabilities';
import {
  SHORTCUTS, bindingFromEvent, compactBinding, formatBinding,
  resetAllBindings, resetBinding, saveBinding, type ShortcutId,
} from '../core/keybindings';
import { useKeybindings } from './useKeybindings';
import PanelOverlay from './PanelOverlay';
import { applyRefractMode, currentRefractMode, type RefractMode } from '../core/liquidGlass';

/** 液态玻璃折射的三档：默认交给性能哨兵决定 */
const REFRACT_OPTIONS: RefractMode[] = ['auto', 'on', 'off'];
const REFRACT_LABELS: Record<RefractMode, string> = { auto: '自动', on: '开启', off: '关闭' };

interface Props {
  onClose: () => void;
  /** 整包备份到文件（笔记 + 题库 + 生词本 + 复习进度） */
  onBackup: () => void;
  /** 打开统一导入入口（恢复备份也走这里） */
  onImport: () => void;
  /** 安全与隐私说明 */
  onNotice: () => void;
  /** 打开数据自检（悬空统计 / 收藏 / 断链 / 孤儿附件） */
  onIntegrity: () => void;
  /** 打开桌宠自定义 */
  onCustomizePet: () => void;
}

export default function SettingsPanel(p: Props) {
  const [font, setFont] = useState<Font>(currentFont);
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [petOff, setPetOff] = useState(() => isPetHidden());
  const [hl, setHl] = useState<string>(currentHighlight);
  const [refract, setRefract] = useState<RefractMode>(currentRefractMode);
  const env = useMemo(() => detectEnvironment(), []);
  const support = useMemo(() => supportTable(env), [env]);
  const [persist, setPersist] = useState<PersistState | null>(null);
  const bindings = useKeybindings();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [keyError, setKeyError] = useState('');
  useEsc(escThenClose(p.onClose));

  // 桌宠被右上角关掉时，设置面板里的开关跟着同步
  useEffect(() => subscribePet(() => setPetOff(isPetHidden())), []);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        setKeyError('');
        return;
      }
      const key = bindingFromEvent(event);
      if (!key) return;
      const result = saveBinding(recording, key);
      if (!result.ok) {
        setKeyError(result.reason);
        return;
      }
      setKeyError('');
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  return (
    <PanelOverlay tone="plain" onClose={p.onClose}>
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
                {(['light', 'dark', 'guofeng'] as Theme[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`chip${theme === t ? ' on' : ''}`}
                    aria-pressed={theme === t}
                    title={
                      t === 'guofeng'
                        ? '国风：宣纸 · 墨 · 花青；深墨卷轴导航轨 + 衬线标题'
                        : undefined
                    }
                    onClick={(event) => {
                      // 传点击坐标：主题切换会做一次从按钮扩散的圆形揭示
                      applyTheme(t, { x: event.clientX, y: event.clientY });
                      setTheme(t);
                    }}
                  >
                    {t === 'dark' ? '深色' : t === 'guofeng' ? '国风' : '浅色'}
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

            <div className="settings-row">
              <span className="settings-row__label">液态玻璃</span>
              <div className="settings-chips" role="group" aria-label="液态玻璃折射">
                {REFRACT_OPTIONS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`chip${refract === m ? ' on' : ''}`}
                    aria-pressed={refract === m}
                    onClick={() => setRefract(applyRefractMode(m))}
                  >
                    {REFRACT_LABELS[m]}
                  </button>
                ))}
              </div>
            </div>
            <p className="settings-note">
              折射会把玻璃背后的画面推开几像素。「自动」在启动后测 2 秒帧率，低于 45fps 就关掉；
              机器够快又想一直看到厚度感时选「开启」。
            </p>

            <div className="settings-row">
              <span className="settings-row__label">桌宠</span>
              <div className="settings-chips" role="group" aria-label="桌宠">
                <button
                  type="button"
                  className={`chip${!petOff ? ' on' : ''}`}
                  aria-pressed={!petOff}
                  onClick={() => { setPetHidden(false); setPetOff(false); }}
                >
                  显示
                </button>
                <button
                  type="button"
                  className={`chip${petOff ? ' on' : ''}`}
                  aria-pressed={petOff}
                  onClick={() => { setPetHidden(true); setPetOff(true); }}
                >
                  隐藏
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={p.onCustomizePet}
                >
                  自定义…
                </button>
              </div>
            </div>
            <p className="settings-note">
              晶格精灵待在右下角；拖到别处会记住位置，点它换一句提示。「自定义」可改名字、主色、体型、表情和头顶配饰。
            </p>
          </section>

          <section className="settings-sec" aria-label="快捷键">
            <h3 className="settings-sec__title">快捷键</h3>
            <p className="settings-note">
              点键位后按下新的组合键即可改键；Esc 取消。冲突会直接拒绝，不会悄悄覆盖另一个动作。
            </p>
            {(['全局', '编辑器格式'] as const).map((group) => (
              <div className="settings-keys" key={group}>
                <div className="settings-keys__group">{group}</div>
                {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
                  <div className="settings-key-row" key={shortcut.id}>
                    <span className="settings-key-row__label">
                      {shortcut.label}
                      <em>{shortcut.hint}</em>
                    </span>
                    <button
                      type="button"
                      className={`settings-key-chip${recording === shortcut.id ? ' is-recording' : ''}`}
                      aria-pressed={recording === shortcut.id}
                      onClick={() => { setRecording(shortcut.id); setKeyError(''); }}
                      title={`当前：${compactBinding(bindings[shortcut.id])}；点击后按下新组合键`}
                    >
                      {recording === shortcut.id ? '按下新键…' : formatBinding(bindings[shortcut.id])}
                    </button>
                    <button
                      type="button"
                      className="btn-small"
                      onClick={() => { resetBinding(shortcut.id); setKeyError(''); }}
                      disabled={bindings[shortcut.id] === shortcut.defaultKey}
                      title="恢复这个动作的默认键"
                    >
                      恢复
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {keyError && <p className="settings-key-error" role="alert">{keyError}</p>}
            <div className="settings-actions">
              <button type="button" className="btn-small" onClick={() => { resetAllBindings(); setKeyError(''); }}>
                全部恢复默认
              </button>
            </div>
          </section>

          <section className="settings-sec" aria-label="数据">
            <h3 className="settings-sec__title">数据</h3>
            <p className="settings-note">
              全部数据只存本机。备份文件包含笔记、附件、PDF 书架与摘录、题库、生词本、复习进度、单词工坊、医学速查、导师掌握度、每日小结、成就与快捷键，换机器时用它恢复。
            </p>
            <div className="settings-actions">
              <button className="btn-small" onClick={p.onBackup}>
                <IconBackup /> 备份到文件
              </button>
              <button className="btn-small" onClick={p.onImport}>
                <IconFile /> 导入（笔记 / 题库 / 内容包）
              </button>
              <button className="btn-small" onClick={p.onIntegrity}>
                <IconInfo /> 数据自检
              </button>
            </div>
          </section>

          <section className="settings-sec" aria-label="运行环境">
            <h3 className="settings-sec__title">运行环境</h3>
            <p className="settings-note">{degradationMessage(env) ?? '当前环境支持下列全部能力。'}</p>
            <ul className="settings-cap-list">
              {support.map((item) => (
                <li key={item.id} className={`settings-cap${item.supported ? ' is-ok' : ' is-off'}`}>
                  <span className="settings-cap__dot" aria-hidden="true" />
                  <span className="settings-cap__label">{item.label}</span>
                  <span className="settings-cap__state">{item.supported ? '可用' : '降级'}</span>
                  <span className="settings-cap__hint">{item.supported ? (item.note ?? '') : item.fallback}</span>
                </li>
              ))}
            </ul>
            {support.find((item) => item.id === 'idbPersist')?.supported && (
              <div className="settings-actions">
                <button
                  className="btn-small"
                  onClick={() => { void requestPersistence(env).then(setPersist); }}
                >
                  {persist === 'granted' ? '已申请持久化存储' : persist === 'denied' ? '申请被拒绝（仍可备份）' : '申请持久化存储'}
                </button>
              </div>
            )}
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
    </PanelOverlay>
  );
}
