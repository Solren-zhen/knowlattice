/**
 * AI 助手侧栏：内嵌免费网页 AI 问答，学习时不用来回切窗口。
 * - 预设常用 AI 站点，也可填自定义 URL；选择记忆在 localStorage
 * - 部分站点禁止被网页嵌入（X-Frame-Options），提供「新窗口打开」兜底
 */
import { useEffect, useState } from 'react';
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

interface Props {
  onClose: () => void;
}

export default function AiPanel({ onClose }: Props) {
  const [src, setSrc] = useState<string>(() => localStorage.getItem(KEY) ?? PRESETS[0].url);
  const [custom, setCustom] = useState('');
  // 内嵌页首屏是白屏：用统一载入语汇补上「正在加载」的反馈，换站点时重置
  const [frameLoading, setFrameLoading] = useState(true);

  // Esc 快捷关闭
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const pick = (url: string) => {
    if (url !== src) setFrameLoading(true); // 只有真的换站点才重新进入载入态
    setSrc(url);
    localStorage.setItem(KEY, url);
  };
  const openExternal = () => window.open(src, '_blank', 'noopener');

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
          placeholder="或粘贴其他 AI 网页地址…"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && /^https?:\/\//.test(custom.trim())) pick(custom.trim());
          }}
        />
        <button
          className="btn-small"
          disabled={!/^https?:\/\//.test(custom.trim())}
          onClick={() => custom.trim() && pick(custom.trim())}
        >
          打开
        </button>
      </div>
      <p className="ai-hint muted">站点若显示空白说明其禁止内嵌，点「新窗口打开」并排使用即可</p>
      <div className="ai-frame-wrap">
        {frameLoading && <Loading label="正在载入内嵌页面…" />}
        <iframe
          key={src}
          className="ai-frame"
          src={src}
          title="AI 问答"
          onLoad={() => setFrameLoading(false)}
        />
      </div>
    </div>
  );
}
