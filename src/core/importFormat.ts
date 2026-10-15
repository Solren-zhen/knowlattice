/**
 * 统一导入：**一份文件该走哪条导入通道**——只看文件名与内容形状自动判断。
 *
 * 背景：原来「导入」散落成好几个按钮（导入题库 / 导入 Anki 牌组 / 导入数据集 /
 * 导入知识包 / 从备份恢复 / 导入 md 文件夹 / 格式转换），用户必须先自己知道
 * 「我这个文件属于哪一类」才点得对。这里把判断收敛成一个纯函数：
 * 调用方只管把文件丢进来，由它决定分派。
 *
 * 纯函数、无副作用、不碰存储，便于单测；真正的落库由调用方按返回的 format 分派。
 * JSON 的形状识别复用既有探测器（题库 qbankMapper / 数据集 datasetImport / 知识包 format 标记 /
 * 备份的 app 标记），不另起一套判断，避免与各导入器口径分叉。
 */
import { detectQbankSchema } from './qbankMapper';
import { detectDataset } from './datasetImport';
import { PACK_FORMAT } from './knowledgePack';

export type ImportFormat =
  | 'vault-backup'   // 晶格/medvault 备份 .json（笔记 + 题库 + 复习进度）
  | 'knowledge-pack' // 晶格知识包 .json（一组现成笔记）
  | 'qbank-json'     // 题库 .json（本项目格式或同业可映射形状）
  | 'dataset-json'   // 结构化数据集 .json（症状→疾病 / 口诀 / 术语表）
  | 'anki-apkg'      // Anki 牌组包 .apkg
  | 'anki-tsv'       // Anki「导出为 .txt」的制表符文本
  | 'note-md'        // Markdown 笔记
  | 'qbank-sheet'    // Excel / CSV 题库
  | 'document'       // PDF / Word：先走格式转换
  | 'unknown';

export const IMPORT_FORMAT_LABELS: Record<ImportFormat, string> = {
  'vault-backup': '笔记备份',
  'knowledge-pack': '知识包',
  'qbank-json': '题库',
  'dataset-json': '数据集',
  'anki-apkg': 'Anki 牌组',
  'anki-tsv': 'Anki 文本',
  'note-md': 'Markdown 笔记',
  'qbank-sheet': '表格题库',
  document: 'PDF / Word 文档',
  unknown: '无法识别',
};

/**
 * 「可导入格式」清单：菜单条目与导入失败提示共用这一份文案。
 *
 * 与 detectImportFormat 的判定保持一一对应（.markdown 归入 .md、.doc/.xls 归入 .docx/.xlsx），
 * 免得出现「菜单上写着支持 pdf、真丢进 pdf 又说不支持」这种自相矛盾的说法。
 */
export const IMPORT_FORMATS_HINT = '.md / .json / .apkg / .txt / .docx / .pdf / .xlsx / .csv';

const BACKUP_APPS = new Set(['knowlattice', 'medvault']);

/** 扩展名（小写，不含点） */
export function extOf(name: string): string {
  const m = /\.([^.]+)$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** JSON 文本 → 具体格式（解析失败返回 unknown）。顺序即优先级：显式标记 → 形状探测。 */
export function detectJsonFormat(text: string): ImportFormat {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'unknown';
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as { app?: unknown; format?: unknown; files?: unknown };
    if (typeof o.app === 'string' && BACKUP_APPS.has(o.app) && Array.isArray(o.files)) return 'vault-backup';
    if (o.format === PACK_FORMAT) return 'knowledge-pack';
  }
  if (detectDataset(raw).kind !== 'unknown') return 'dataset-json';
  if (detectQbankSchema(raw).kind !== 'unknown') return 'qbank-json';
  return 'unknown';
}

/**
 * 判定一份文件属于哪条导入通道。
 * `text` 只在需要读内容的类型（.json / .md / .txt）才需要传；二进制类型按扩展名判定即可。
 */
export function detectImportFormat(name: string, text?: string): ImportFormat {
  switch (extOf(name)) {
    case 'md':
    case 'markdown':
      return 'note-md';
    case 'apkg':
      return 'anki-apkg';
    case 'txt':
    case 'tsv':
      return 'anki-tsv';
    case 'doc':
    case 'docx':
    case 'pdf':
      return 'document';
    case 'xlsx':
    case 'xls':
    case 'csv':
      return 'qbank-sheet';
    case 'json':
      return text === undefined ? 'unknown' : detectJsonFormat(text);
    default:
      return 'unknown';
  }
}
