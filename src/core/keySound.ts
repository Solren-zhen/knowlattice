/**
 * 键盘音效：用 WebAudio 现场合成，不引入任何音频资源。
 *
 * 为什么不放 mp3：一个按键音要 20ms 内响，音频文件要下载、解码、还得处理首次交互策略；
 * 合成三个振荡器就够了，也不增加包体与 CDN 依赖。
 *
 * 三条纪律：
 * 1. 静默失败：浏览器不支持 AudioContext、被自动播放策略拦、AudioContext 抛错，一律不打扰用户；
 * 2. 音量固定很小（0.02–0.05）：这是键盘反馈，不是提示音；
 * 3. 开关存本地（`knowlattice-word-drill-sound`），默认开。
 */
import { defineStore } from '../storage/kv';

export type SoundKind = 'key' | 'right' | 'wrong';

const soundStore = defineStore<boolean>({
  key: 'knowlattice-word-drill-sound',
  fallback: true,
  decode: (raw, fallback) => (typeof raw === 'boolean' ? raw : fallback),
});

export const soundEnabled = (): boolean => soundStore.read();
export const setSoundEnabled = (on: boolean): void => soundStore.write(on);

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  return ctx;
}

/** 一次衰减音：频率可扫（from → to），时长与音量按音效类型给定 */
function blip(ac: AudioContext, type: OscillatorType, from: number, to: number, dur: number, peak: number): void {
  const now = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, now);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), now + dur);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

/**
 * 播放一个音效。
 * - `key`：敲键（跟随输入的每个字符）
 * - `right`：答对（两个上行音）
 * - `wrong`：答错（一个短促下行音）
 */
export function playSound(kind: SoundKind): void {
  if (!soundEnabled()) return;
  const ac = audio();
  if (!ac) return;
  try {
    if (kind === 'key') {
      // 频率轻微抖动，连打时不像电子节拍器
      blip(ac, 'triangle', 1500 + Math.random() * 400, 1100, 0.035, 0.022);
      return;
    }
    if (kind === 'right') {
      blip(ac, 'sine', 660, 660, 0.09, 0.045);
      window.setTimeout(() => {
        const again = audio();
        if (again) blip(again, 'sine', 990, 990, 0.12, 0.04);
      }, 90);
      return;
    }
    blip(ac, 'sine', 320, 180, 0.18, 0.05);
  } catch {
    /* 音频失败不影响练习 */
  }
}
