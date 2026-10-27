/**
 * AI 助手侧栏：内嵌免费网页 AI 问答，学习时不用来回切窗口。
 * - 预设常用 AI 站点，也可填自定义 URL；选择记忆在 localStorage
 * - 部分站点禁止被网页嵌入（X-Frame-Options），提供「新窗口打开」兜底
 */
import { useState } from 'react';
import { useEsc, escThenClose } from './useEsc';
import { IconClose } from './icons';
import Loading from './Loading';
import { usePanelResize } from './usePanelDrag';

const PRESETS = [
  { name: 'Kimi', url: 'https://kimi.moonshot.cn/', embed: true },
  { name: '智谱清言', url: 'https://chatglm.cn/', embed: true },
  { name: '通义千问', url: 'https://tongyi.aliyun.com/', embed: true },
  { name: '腾讯元宝', url: 'https://yuanbao.tencent.com/', embed: true },
  { name: 'DeepSeek', url: 'https://chat.deepseek.com/', embed: false },
];

const KEY = 'knowlattice-ai-src';

function normalizeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

interface Props {
  onClose: () => void;
  /** 一个 AI 入口：面板内切到笔记助手（两个面板共用同一块让位空间，故互斥） */
  onSwitchToAgent?: () => void;
}

export default function AiPanel({ onClose, onSwitchToAgent }: Props) {
  const [src, setSrc] = useState<string>(() => normalizeHttpsUrl(localStorage.getItem(KEY) ?? '') ?? PRESETS[0].url);
  const [custom, setCustom] = useState('');
  // 内嵌页首屏是白屏：用统一载入语汇补上「正在加载」的反馈，换站点时重置
  const [frameLoading, setFrameLoading] = useState(true);
  // 延迟挂 iframe：只有用户真正「打开」过某站点才挂载，避免一开面板就主动连第三方。
  const [frameArmed, setFrameArmed] = useState(false);

  /**
   * 面板尺寸可自由拉伸（横 + 纵），双击左上角抓手复位。
   * 与右侧「视频 + AI 笔记」栏同一套诉求：各功能空间都该能自己调大小，而不是写死 480px。
   * usePanelResize 内部是 window 级 pointermove/up 监听，指针移出抓手也不会断。
   */
  const panelSize = usePanelResize('ai-panel', { minWidth: 320, minHeight: 320 });
  // Esc 快捷关闭。走全局 Esc 栈（只关最上面那一层）；焦点在输入框里时先退出输入框
  useEsc(escThenClose(onClose));

  const pick = (url: string) => {
    setFrameArmed(true); // 用户主动打开过才挂 iframe
    if (url !== src) setFrameLoading(true); // 只有真的换站点才重新进入载入态
    setSrc(url);
    localStorage.setItem(KEY, url);
  };
  const selectedPreset = PRESETS.find((p) => p.url === src);
  const canEmbed = selectedPreset?.embed ?? true;
  const openExternal = () => window.open(src, '_blank', 'noopener,noreferrer');
  const customUrl = normalizeHttpsUrl(custom);

  return (
    <div className="ai-panel" data-panel-drag-root style={panelSize.style}>
      {/* 左上角抓手：横纵都能拖，双击复位（方向键也能调） */}
      <button
        type="button"
        className="panel-resize-grip"
        aria-label="拖动调整 AI 面板大小（双击复位）"
        onPointerDown={panelSize.onHandlePointerDown}
        onKeyDown={panelSize.onHandleKeyDown}
        onDoubleClick={panelSize.reset}
      />
      <div className="ai-header">
        <span className="ai-title">AI 问答</span>
        <button className="btn-small" onClick={openExternal} title="部分站点禁止嵌入，可在新窗口打开">
          新窗口打开
        </button>
        {onSwitchToAgent && (
          <button className="btn-small" onClick={onSwitchToAgent} aria-label="切到笔记助手">
            笔记助手
          </button>
        )}
        <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
      </div>
      <div className="ai-sources">
        {PRESETS.map((p) => (
          <button
            key={p.url}
            className={`type-chip ${src === p.url ? 'on' : ''}`}
            onClick={() => pick(p.url)}
            title={p.embed ? '可内嵌' : '该站禁止嵌入网页，请用「新窗口打开」'}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="ai-custom">
        <input
          placeholder="或粘贴其他 HTTPS AI 地址…"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && customUrl) pick(customUrl);
          }}
        />
        <button
          className="btn-small"
          disabled={!customUrl}
          onClick={() => customUrl && pick(customUrl)}
        >
          打开
        </button>
      </div>
      <p className="ai-hint muted">只允许 HTTPS。内嵌页面中的内容会直接发送给所选第三方平台，请勿输入姓名、病历、未公开资料或受版权限制的题库原文。</p>
      {!frameArmed ? (
        <div className="ai-frame-blocked">
          <strong>尚未打开任何 AI 站点</strong>
          <span>选择上方预设或粘贴地址后再连接第三方；打开前不会发起任何网络请求。</span>
        </div>
      ) : canEmbed ? (
        <div className="ai-frame-wrap">
          {frameLoading && <Loading label="正在载入内嵌页面…" />}
          <iframe
            key={src}
            className="ai-frame"
            src={src}
            title="AI 问答"
            referrerPolicy="no-referrer"
            sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-scripts"
            onLoad={() => setFrameLoading(false)}
          />
        </div>
      ) : (
        <div className="ai-frame-blocked">
          <strong>该站点不支持安全内嵌</strong>
          <span>请在新窗口打开，应用不会读取第三方页面内容。</span>
          <button className="btn-primary" onClick={openExternal}>在新窗口打开</button>
        </div>
      )}
    </div>
  );
}
