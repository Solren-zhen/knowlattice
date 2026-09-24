/**
 * AI 助手侧栏：内嵌免费网页 AI 问答，学习时不用来回切窗口。
 * - 预设常用 AI 站点，也可填自定义 URL；选择记忆在 localStorage
 * - 部分站点禁止被网页嵌入（X-Frame-Options），提供「新窗口打开」兜底
 */
import { useState } from 'react';
import { useEsc, escThenClose } from './useEsc';
import { IconClose } from './icons';
import Loading from './Loading';

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
}

export default function AiPanel({ onClose }: Props) {
  const [src, setSrc] = useState<string>(() => normalizeHttpsUrl(localStorage.getItem(KEY) ?? '') ?? PRESETS[0].url);
  const [custom, setCustom] = useState('');
  // 内嵌页首屏是白屏：用统一载入语汇补上「正在加载」的反馈，换站点时重置
  const [frameLoading, setFrameLoading] = useState(true);

  // Esc 快捷关闭。走全局 Esc 栈（只关最上面那一层）；焦点在输入框里时先退出输入框
  useEsc(escThenClose(onClose));

  const pick = (url: string) => {
    if (url !== src) setFrameLoading(true); // 只有真的换站点才重新进入载入态
    setSrc(url);
    localStorage.setItem(KEY, url);
  };
  const selectedPreset = PRESETS.find((p) => p.url === src);
  const canEmbed = selectedPreset?.embed ?? true;
  const openExternal = () => window.open(src, '_blank', 'noopener,noreferrer');
  const customUrl = normalizeHttpsUrl(custom);

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <span className="ai-title">AI 助手</span>
        <button className="btn-small" onClick={openExternal} title="部分站点禁止嵌入，可在新窗口打开">
          新窗口打开
        </button>
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
      {canEmbed ? (
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
