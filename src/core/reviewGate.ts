/**
 * 解析门控（review gate）：答完不立刻给解析，先让用户把「为什么」说出来。
 *
 * 口径：只有「答对且很确定」才允许直接看解析；答错、没报把握度、把握度不足的
 * 都先过一道反思闸门——写够 10 字，或明确勾「我想过了」。理由是解析一旦展开，
 * 记忆就把「看懂」误记成「会做」，而错题的真实缺口在推理链上。
 *
 * 另一个口径是自证（rationale）：做对了也可能靠蒙，所以「对但可疑」要写 30 字推理。
 * 全部是纯判定 + 文案，不依赖 DOM，方便在题卡里直接调。
 */
import type { Confidence } from './qbankCalib';

/** 反思闸门最少字数：够写一句完整判断，又不至于变成作文 */
export const REFLECTION_MIN_CHARS = 10;
/** 自证最少字数 */
export const RATIONALE_MIN_CHARS = 30;
/** 只有这一档算「确定」，其余档位都按没把握处理 */
export const SURE_CONFIDENCE: Confidence = 5;

/** 是否要把解析挡在反思后面 */
export function shouldGateExplanation(isCorrect: boolean, confidence: Confidence | null): boolean {
  if (!isCorrect) return true;
  // 不报把握度是允许的（本仓自报是可选项），不当成「没把握」来惩罚
  return confidence !== null && confidence !== SURE_CONFIDENCE;
}

/** 反思是否够格放行：写够字数，或用户明确表示「我想过了」 */
export function reflectionReady(text: string, ack = false): boolean {
  return ack || text.trim().length >= REFLECTION_MIN_CHARS;
}

/** 闸门上的字数计数：7/10 字 或 12/10 字 ✓ */
export function reflectionCounter(text: string): string {
  const n = text.trim().length;
  const hit = n >= REFLECTION_MIN_CHARS ? ' ✓' : '';
  return n + '/' + REFLECTION_MIN_CHARS + ' 字' + hit;
}

/** 闸门提示语：答错问「错在哪」，答对问「推理链怎么走的」 */
export function gatePrompt(isCorrect: boolean): string {
  if (!isCorrect) return '这题错在哪？先写下你的判断依据，再对解析。';
  return '有把握也值得再走一遍：写出推理链，再看解析。';
}

/**
 * 自证触发：做对了，但「没把握」或「还没练熟」（stage < 2）。
 * stage 用错题本的晋级阶段当熟练度代理：连对两次以上才免自证。
 */
export function needsRationale(isCorrect: boolean, confidence: Confidence | null, stage: number): boolean {
  return isCorrect && (confidence !== SURE_CONFIDENCE || stage < 2);
}

export function rationaleReady(text: string): boolean {
  return text.trim().length >= RATIONALE_MIN_CHARS;
}

/** 自证门槛旁的按钮文案，未达标时也要说清还差多少 */
export function rationaleHint(text: string): string {
  const n = text.trim().length;
  return n >= RATIONALE_MIN_CHARS ? '提交自证' : '还差 ' + (RATIONALE_MIN_CHARS - n) + ' 字';
}
