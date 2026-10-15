/**
 * 题库文件解析：把一份文件（JSON / Word / Excel·CSV）变成题目数组。
 *
 * 从 views/QuizView 里抽出来，为的是让「统一导入」入口与「题库练习」面板走**同一条解析通道**——
 * 两处各写一份解析必然分叉（同一个文件从一个入口进得了、从另一个进不了），
 * 这正是本项目反复强调要避免的。落库仍由调用方负责（这里只解析，不碰存储）。
 *
 * 解析顺序（JSON）：先走本项目格式 parseQbankJson；只有当它失败、或成功但一道题都没产出时，
 * 才动用 core/qbankMapper 的形状探测（短键 / 富文本字段名）把同业题库吃进来；都认不出就抛
 * 面向使用者的中文原因（缺哪些字段），绝不猜。
 */
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import {
  normalizeQuestions, parseQbankJson, parseQuestionsFromText, rowsToQuestions, type QuizQuestion,
} from './qbank';
import { detectQbankSchema, mapToQuestions, mappingSummary } from './qbankMapper';

export interface QbankParseOk {
  kind: 'ok';
  name: string;
  questions: QuizQuestion[];
  /** 走了自动识别形状通道时的说明（识别成什么、置信度、跳过哪几条） */
  note?: string;
}

/** 没识别出题目：把原文交回给调用方（粘贴框手动整理） */
export interface QbankParseRaw {
  kind: 'raw';
  text: string;
}

export type QbankParseResult = QbankParseOk | QbankParseRaw;

/** JSON 里写了题库名就用它，没有就用文件名（与 parseQbankJson 同一约定） */
function bankNameOf(raw: unknown, fallback: string): string {
  const named =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as { name?: unknown }).name
      : undefined;
  return typeof named === 'string' && named.trim() ? named.trim() : fallback;
}

/** JSON 文本 → 题库（本项目格式优先，失败再走形状映射）。认不出抛中文原因。 */
export function parseQbankJsonText(text: string, fallbackName: string): QbankParseOk {
  let firstError: Error | null = null;
  try {
    const { name, questions } = parseQbankJson(text, fallbackName);
    if (questions.length) return { kind: 'ok', name, questions };
  } catch (err) {
    firstError = err as Error; // 旧路径的报错留着：映射也认不出时，两句话一起给用户看
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw firstError ?? new Error('这个文件不是有效的 JSON。');
  }
  const det = detectQbankSchema(raw);
  const mapped = mapToQuestions(raw);
  if (det.kind === 'unknown') {
    const why = det.evidence.join('；');
    throw new Error(
      `${firstError ? `${firstError.message}；` : ''}也没识别出已知的题库形状（${why}）。原始文件没有被改动。`,
    );
  }
  if (mapped.items.length === 0) {
    throw new Error(mappingSummary(det, mapped));
  }
  return {
    kind: 'ok',
    name: bankNameOf(raw, fallbackName),
    questions: normalizeQuestions(mapped.items),
    note: mappingSummary(det, mapped),
  };
}

/** Word 抽取文本 → 题库 */
export function parseQbankText(text: string, fallbackName: string): QbankParseOk {
  return { kind: 'ok', name: fallbackName, questions: parseQuestionsFromText(text) };
}

/** 表格行 → 题库 */
export function parseQbankRows(rows: Record<string, unknown>[], fallbackName: string): QbankParseOk {
  const questions = rowsToQuestions(rows);
  if (!questions.length) throw new Error('表里没解析出题目（表头需含「题干/答案」，选项列用 A/B/C/D 或 选项1..4）');
  return { kind: 'ok', name: fallbackName, questions };
}

/** 题库类文件的扩展名 */
export const QBANK_EXT = /\.(json|docx?|xlsx?|csv)$/i;

/** 按扩展名分派解析一份题库文件（mammoth / SheetJS 按需加载）。失败抛中文说明。 */
export async function parseQbankFile(file: File): Promise<QbankParseResult> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.json')) {
    return parseQbankJsonText(await file.text(), file.name.replace(/\.json$/i, ''));
  }
  if (lower.endsWith('.docx') || lower.endsWith('.doc')) {
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    const questions = parseQuestionsFromText(value);
    return questions.length
      ? { kind: 'ok', name: file.name.replace(/\.docx?$/i, ''), questions }
      : { kind: 'raw', text: value.trim() };
  }
  if (/\.(xlsx|xls|csv)$/.test(lower)) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const first = wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[first], { defval: '' });
    const parsed = parseQbankRows(rows, file.name.replace(/\.(xlsx?|csv)$/i, ''));
    // 只读第一张工作表。多表题库（单选/多选/判断分表）**静默少导**是本项目最忌讳的失败形态，
    // 所以把「还有哪几张没读」说出来（复用既有的 note 字段，调用方会把它显示在导入报告里）。
    // 不自动合并：合并要定义章节归属与去重口径，那是另一个决定，不能顺手替用户定。
    const rest = wb.SheetNames.slice(1);
    if (!rest.length) return parsed;
    const sheetNote = `只读了第一张工作表「${first}」，另有 ${rest.length} 张未读取：${rest.slice(0, 5).join('、')}${rest.length > 5 ? ' 等' : ''}`;
    return { ...parsed, note: [parsed.note, sheetNote].filter(Boolean).join('；') };
  }
  throw new Error('不支持的文件类型（只吃 .json / .docx / .xlsx / .csv）');
}
