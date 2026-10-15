/**
 * 音频条 + 逐句字幕（自包含组件：不依赖 Workspace，也不读 localStorage）。
 *
 * 音频地址由调用方解析好（vault 读 blob → ObjectURL）传进来；字幕文本同理，srt/vtt 原文
 * 丢进来即可，解析全靠 core/subtitle。组件只做「播放 / 点句回跳 / 高亮当前句 / 把字幕转成卡」。
 *
 * 三处刻意的取舍：
 *   1. **高亮下标走 React state，而不是直接改 DOM 的 classList**：字幕通常几十条，
 *      timeupdate（浏览器每秒抛 4 次上下）触发的那点重渲染代价可忽略，换来的是「高亮」
 *      与「点击回跳」共用同一份渲染结果——直接改 classList 的话，任何一次重渲染都会把它冲掉。
 *   2. **卸载时移除 timeupdate 监听**：忘了摘，组件卸载后监听还挂在 audio 元素上，
 *      闭包里揣着旧的 cues 一直算下标（React 不报错，最难查）。
 *   3. **点字幕不自动 play()**：用户点字幕的意图是「回听这一句」，但此刻他可能正在翻笔记，
 *      硬播会突然出声。只跳时间，出不出声交给播放键（浏览器本来也不允许无交互自动播放）。
 *
 * 没有字幕时只渲染音频条，不渲染空列表——空 `<ol>` 会撑出一条空白，看起来像加载失败。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { cueIndexAt, formatTime, parseSubtitle, subtitleToCardText } from '../core/subtitle';
import { IconClose } from './icons';

interface Props {
  /** 音频可播放地址（由调用方用 vault.readFile 解析） */
  audioSrc: string;
  /** 字幕文本（srt/vtt 原文；没有就传空串） */
  subtitleText?: string;
  /** 「转成复习卡」：把字幕挖空文本交给调用方（App 会写进当前笔记，因此自动进复习队列） */
  onMakeCards?: (cardText: string) => void;
  onClose?: () => void;
}

const MAKE_CARDS_TITLE = '把字幕按关键词挖空后写入当前笔记，随后自动进复习队列';

export default function MediaTrack({ audioSrc, subtitleText = '', onMakeCards, onClose }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  /** 当前句下标；-1 = 落在句间空隙（core/subtitle 的约定：宁可不高亮，也不亮错那句） */
  const [active, setActive] = useState(-1);

  const cues = useMemo(() => parseSubtitle(subtitleText ?? ''), [subtitleText]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !cues.length) return;
    const sync = () => setActive(cueIndexAt(cues, audio.currentTime));
    audio.addEventListener('timeupdate', sync);
    return () => audio.removeEventListener('timeupdate', sync);
  }, [cues]);

  // 当前句滚进可视区（block: 'nearest' —— 已经看得见就不动，避免每句都强行居中）。
  // 老引擎 / jsdom 没有 scrollIntoView：缺了就只高亮不滚动，不能因此抛错。
  useEffect(() => {
    if (active < 0) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  /** 点字幕：把播放位置移到这一句。顺便手动对齐高亮——设置 currentTime 不保证立刻抛 timeupdate。 */
  const seek = (seconds: number) => {
    const audio = audioRef.current;
    setActive(cueIndexAt(cues, seconds));
    if (audio) audio.currentTime = seconds;
  };

  return (
    <div>
      <audio ref={audioRef} controls src={audioSrc} className="media-audio" />
      {cues.length > 0 && (
        <button type="button" className="btn-small" title={MAKE_CARDS_TITLE} onClick={() => onMakeCards?.(subtitleToCardText(cues))}>
          转成复习卡
        </button>
      )}
      <button type="button" className="btn-icon" aria-label="关闭音频条" onClick={onClose}>
        <IconClose />
      </button>
      {cues.length > 0 && (
        <ol className="media-cues" role="list" ref={listRef}>
          {cues.map((cue, i) => (
            <li key={`${cue.start}-${i}`}>
              <button type="button" className={'media-cue' + (i === active ? ' on' : '')} onClick={() => seek(cue.start)}>
                {formatTime(cue.start)} {cue.text}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
