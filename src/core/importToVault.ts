/**
 * 把「导入进来的资料」组装成 vault 文件（md 文本 + vault 相对路径）。
 *
 * 为什么单独一个模块：Anki 反向导入、同业题库的通用映射、结构化数据集导入
 * 三条入口**必须走同一条写盘通道**（views/Workspace 的 `vault.importMdFiles`），
 * 才能自动获得既有的全部联动：
 *   L1 笔记 → 复习卡（core/srsCards）
 *   L3 笔记 → Anki 导出（含 `{{挖空}}` 的走 Cloze 卡型）
 *   L4/L6 错题归位（按笔记路径归档）
 *   L13 全文检索 / 统计 / 图谱
 * 各写一套写盘逻辑必然分叉——"从 A 入口进来的能抽查，从 B 入口进来的不能"这类不一致，
 * 事后极难向使用者解释。
 *
 * **来源标注是预防措施，不是装饰**：每个文件都强制写 frontmatter 的 `source` 字段
 * （该字段本来就有，见 core/parser.ts 的 NoteMeta，复习界面与统计面板都在读它），
 * 于是"这份资料从哪来"永远跟着笔记走、在任何界面都看得见，
 * 以后要导出、分享或再分发时也不会被误认成自己的原创。
 * 导入器一律**不改写原始内容**，只做格式搬运：不删字、不改写、不"顺手润色"。
 *
 * **标题里的非法字符是「清洗」，不是「丢弃」——为什么：**
 * 早期实现把含 `/ \ : * ? " < > |` 的标题**连正文一起**跳过。对 Anki 这类英文卡组是灾难：
 * `What is P50?`、`A/B 分型` 这种标题成片命中，用户看到的是"导入完成、新增 3 篇"，
 * 而几十条卡的正文一条没落盘——**静默丢正文是本项目最忌讳的失败形态**。
 * 所以现在的口径是：
 *   - **字符层面**的不安全 → 替换成 `_` 后照常导入，清洗结果逐条报进 `renamed`
 *     （用户必须看得见"我的卡片叫什么名字了"，否则会以为卡丢了）。
 *   - 只有清洗后**仍然**不能当文件名（空串、只剩点号）才计入 `skipped`，并说明原因。
 *   - **目录（`dir`）不适用清洗**：目录不是从卡片内容里抽出来的，是调用方/包作者给的分类；
 *     清洗它等于悄悄把资料挪进别人没指定的目录，而且一条目录错会让整批资料散落多处，
 *     事后无法向用户解释。所以目录不安全就整批拒绝（既有且正确的行为，不放宽 safeSegment）。
 */
import { serializeFrontmatter } from './parser';
import { safeSegment, safeDir } from './knowledgePack';

/** 一个待写入 vault 的文件（path 是 vault 相对路径，含 .md） */
export interface VaultFile {
  path: string;
  content: string;
}

/** 一条待导入的资料（与具体来源无关的中间形态） */
export interface ImportNoteItem {
  title: string;
  body: string;
  tags?: string[];
  chapter?: string;
  /** 该项自己的来源（优先于整体来源）；留空则用 opts.sourceNote */
  source?: string;
}

export interface ImportToVaultResult {
  files: VaultFile[];
  /** 逐条报出被跳过的项与原因——静默丢弃是最糟的反馈（用户不知道少了什么） */
  skipped: Array<{ title: string; reason: string }>;
  /**
   * 标题被清洗过的条目（`from` = 原始标题，`to` = 实际落盘用的标题）。
   *
   * 为什么不塞进 `skipped`：这些条目**成功导入了**，混进 skipped 会让"跳过 N 篇"的计数
   * 说谎（用户以为正文丢了），而计数是用户判断导入是否成功的第一依据。
   * 为什么是可选字段：core/ankiImport.ts 的 apkgToVaultFiles 目前直接返回 `{ files, skipped }`，
   * 把它设成必填会迫使那个文件同步改动（本次改动范围不含它）；
   * 那边补上 `renamed: res.renamed` 之后，这里就可以去掉问号。
   */
  renamed?: Array<{ from: string; to: string }>;
  /**
   * 本次因「库里已有同名笔记」而跳过的**篇数**（资料侧增量导入的聚合结果）。
   *
   * 为什么要有这个数字：这些条目也在 `skipped` 里（带同一句中文原因），但让界面去
   * 过滤 skipped 数数太脆，也让「新增 N 篇 / 已存在 M 篇」这句话没法一次说出来。
   * 于是纯函数层直接把计数给出：界面用 `files.length` 说新增、用它说已存在。
   * 未传 `existing`（或一篇都没撞上）时该字段**不出现**（undefined），
   * 既有调用方（core/ankiImport、core/datasetImport）拿到的形状与内容逐字不变。
   */
  existingSkipped?: number;
}

/**
 * 文件名里不允许出现的字符（与 knowledgePack.BAD_IN_NAME 同一套：Windows 非法字符 + 路径分隔符）。
 * 用 Set 逐字符判断而不是正则字符类：控制字符也要一起挡（见 isUnsafeChar），
 * 而 oxlint 的 no-control-regex 会为 `[\u0000-\u001f]` 报警告，逐字符判断更直白也不增加告警噪声。
 */
const UNSAFE_CHARS = new Set('\\/:*?"<>|'.split(''));

/** 单个字符是否不能出现在文件名里（非法字符，或控制字符 C0/DEL） */
function isUnsafeChar(ch: string): boolean {
  if (UNSAFE_CHARS.has(ch)) return true;
  const c = ch.charCodeAt(0);
  return c < 0x20 || c === 0x7f;
}

/**
 * 标题 → 可用的文件名段（**清洗，不丢弃**）。
 *
 * 规则（连续的一串非法字符合并成一个 `_`，最后去掉首尾的空白/点号/下划线）：
 *   `What is P50?` → `What is P50`
 *   `A/B 分型`     → `A_B 分型`
 *   `肺:通气/血流`  → `肺_通气_血流`（只换 ASCII 的 `:` `/`；全角「：」是合法文件名字符，保持原样）
 * 合并成单个 `_` 而不是逐字符替换，是为了避免 `??` 变成 `__` 这种噪声名字；
 * 去首尾下划线是因为那里的 `_` 几乎总是清洗留下的痕迹（`P50?` 不该叫 `P50_`）。
 *
 * **幂等**：清洗结果里已不含非法字符，再次清洗逐字不变——导入产生的路径不会因为
 * "再导一次/后面又清洗一遍"而改变（路径是错题本、复习卡的键，改了就等于丢历史）。
 * 已是安全标题的输入由调用方走快路径（见 notesToVaultFiles），逐字不变。
 */
function cleanTitleSegment(title: string): string {
  let out = '';
  let replaced = false; // 上一字符是被替换掉的非法字符？
  for (const ch of title) {
    if (isUnsafeChar(ch)) {
      if (!replaced) out += '_'; // 连续非法字符合并成一个 `_`
      replaced = true;
    } else {
      out += ch;
      replaced = false;
    }
  }
  return out.replace(/^[\s._]+/, '').replace(/[\s._]+$/, '');
}

/**
 * 「库里已存在同名笔记」的跳过原因。
 *
 * 为什么是**导出常量**而不是在两处各写一遍这句话：它既由纯函数层（skipExistingNotes）
 * 生成，也被界面层用来从 `skipped` 里认出「哪几篇是因为已存在而跳过的」。
 * 抄一份就会漂移——某天有人改了措辞，界面上的分类就悄悄失配（已存在被混进「跳过」里），
 * 计数看着正常、含义却错了，属于事后极难发现的一类不一致。
 */
export const EXISTING_NOTE_REASON = '已存在同名笔记（增量导入跳过，不会覆盖你的内容）';

/** 路径 → 文件名段（去掉 .md）：skipped 报给用户的是「哪一篇」，文件名最直观 */
function baseNameOf(path: string): string {
  return path.replace(/\.md$/i, '').split('/').pop() ?? path;
}

/**
 * 资料侧增量导入：把「目标路径在库里已存在」的条目从待写文件里摘出来，改记为跳过。
 *
 * 为什么必须有这一步：落盘通道 `vault.importMdFiles` 是**无条件覆盖写**
 * （storage/web.ts 的 writeMany 直接 `db.put`，桌面端 writeAtomic 同理），写之前既不问
 * 库里有没有同名文件，也不推历史快照。于是「同一份资料再导一遍」会把用户改过的笔记
 * 整篇换掉，而且在「历史版本」里也找不回来。导入器只该**补新篇**，不该覆盖用户已经
 * 动过的东西——这就是本函数存在的全部理由。
 *
 * 命中判定用**完整路径精确匹配**（不按标题、不忽略目录、不做大小写折叠）：路径是复习卡、
 * 错题本、双链的键，同名不同目录是两篇不同的笔记；模糊匹配要么把别人的修改误判成
 * 「已存在」而漏导新篇，要么把本该拒写的当成新的而覆盖用户内容。
 *
 * `existing` 未传 / 为空 / 一篇都没撞上时**原对象原样返回**：向后兼容是硬要求，
 * 既有调用方（core/ankiImport、core/datasetImport）拿到的返回值必须逐字不变。
 */
// 返回类型显式并上 existingSkipped 而不是只写 T：T 由调用方传入的结果类型推断，若那个类型是
// 对象字面量（有 files/skipped 但没有这个新字段），只写 T 会把新字段藏起来，界面就读不到
// 「已存在几篇」。并上可选字段后，任何调用方都能看到它。
export function skipExistingNotes<T extends ImportToVaultResult>(
  result: T,
  existing?: ReadonlySet<string>
): T & { existingSkipped?: number } {
  if (!existing || existing.size === 0 || result.files.length === 0) return result;
  const files: VaultFile[] = [];
  const existingTitles: string[] = [];
  for (const file of result.files) {
    if (existing.has(file.path)) existingTitles.push(baseNameOf(file.path));
    else files.push(file);
  }
  if (existingTitles.length === 0) return result;
  const keptNames = new Set(files.map((f) => baseNameOf(f.path)));
  return {
    ...result,
    files,
    skipped: [
      ...result.skipped,
      ...existingTitles.map((title) => ({ title, reason: EXISTING_NOTE_REASON })),
    ],
    // renamed 记的是「这个名字被清洗过」，只能报**真正写出去**的篇目。
    // 被增量跳过的那篇根本没落盘，跟着报改名只会让用户以为库里多了一篇/变了一篇。
    // 用文件名比对即可：同一批里标题不重复（见 notesToVaultFiles 的 seen 去重）。
    renamed: result.renamed?.filter((r) => keptNames.has(r.to)),
    existingSkipped: existingTitles.length,
  };
}

/**
 * 资料列表 → 可直接交给 `vault.importMdFiles` 的文件列表（纯函数，可单测）。
 *
 * 跳过规则（每条都会出现在结果里）：
 *   - 标题为空，或清洗后仍不能作为文件名（只剩空白/点号）
 *   - 目录名不安全（整批拒绝，见模块注释：目录不适用清洗）
 *   - 正文为空
 *   - 同一批里重名（否则第二次会覆盖第一次写出来的文件）
 *   - `opts.existing` 里已有的路径（资料侧增量导入：库里已经有同名笔记，不覆盖）
 * 标题含非法字符**不再**导致跳过：先清洗再用，清洗过的条目逐条报进 `renamed`。
 */
export interface ImportToVaultOptions {
  dir?: string;
  sourceNote: string;
  /**
   * 库里**已存在**的笔记路径集合（可选）。传入即启用「资料侧增量导入」：同一份资料
   * 更新后再次导入时只补新篇，已存在的进 `skipped`（原因见 EXISTING_NOTE_REASON）
   * 并计入 `existingSkipped`，**不会**覆盖用户已编辑的内容。
   *
   * 为什么由调用方传、本模块不自己查：这里是纯函数层（可单测、三条导入通道共用），
   * 读 IndexedDB/localStorage 会把存储后端和「哪些路径存在」的细节耦合进来，
   * 单测就得搭一套假数据库；调用方（界面）本来就拿着当前目录树，顺手就能给出这份集合。
   * **不传时行为与加这个参数之前逐字一致**（向后兼容的关键）。
   */
  existing?: ReadonlySet<string>;
}

export function notesToVaultFiles(
  items: ImportNoteItem[],
  opts: ImportToVaultOptions
): ImportToVaultResult {
  const dir = (opts.dir ?? '').trim().replace(/\/+$/, '');
  const files: VaultFile[] = [];
  const skipped: ImportToVaultResult['skipped'] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  const created = new Date().toISOString().slice(0, 10);

  if (dir && !safeDir(dir)) {
    // 目录本身不安全时整批都不写：宁可一条都不导入，也不要写到库外的路径上
    return {
      files: [],
      skipped: items.map((i) => ({ title: i.title, reason: '目录名不安全' })),
      renamed: [],
    };
  }

  for (const item of items) {
    const rawTitle = (item.title ?? '').trim();
    const body = (item.body ?? '').trim();
    // 已是安全标题 → 快路径**逐字不变**：保证"本来就安全的中文/英文标题不会被改名"。
    // 只有真的含非法字符才走清洗（否则会出现"所有标题都动过"的意外，用户无法信任导入）。
    const title = safeSegment(rawTitle) ? rawTitle : cleanTitleSegment(rawTitle);
    if (!safeSegment(title)) {
      // 清洗后仍不能当文件名的少数情况：标题为空、只剩空白/点号、以 `.` 开头（隐藏目录/系统名）
      skipped.push({
        title: rawTitle || '(空标题)',
        reason: rawTitle ? '标题清洗后不能作为文件名（只剩空白或点号）' : '标题为空',
      });
      continue;
    }
    if (!body) {
      skipped.push({ title, reason: '正文为空' });
      continue;
    }
    const path = dir ? `${dir}/${title}.md` : `${title}.md`;
    if (seen.has(path)) {
      skipped.push({ title, reason: '同一批里重名' });
      continue;
    }
    seen.add(path);
    if (title !== rawTitle) renamed.push({ from: rawTitle, to: title });
    const source = (item.source ?? '').trim() || opts.sourceNote;
    // H1 与文件名用**同一个**清洗后的标题：本项目处处假定"笔记标题（H1）= 文件名"
    // （core/parser 的 title 取自 H1，树/搜索/双链/导出都按它找人）。只清洗文件名会让
    // 树里显示的名字与磁盘上的名字对不上，用户按名字搜反而找不到自己刚导入的卡。
    // 被换掉的只有非法字符本身，正文一字未动（导入器不改写正文）。
    const content =
      serializeFrontmatter({
        aliases: [],
        tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string' && t.trim()) : [],
        chapter: item.chapter ?? '',
        source,
        created,
        exam: [],
      }) + `\n# ${title}\n\n${body}\n`;
    files.push({ path, content });
  }
  // 增量导入放在最后统一处理：**不**动上面「同批重名」「目录拒绝」「标题清洗」的任何一条既有语义。
  // opts.existing 未传时 skipExistingNotes 原样返回这个对象，返回值与加参数之前逐字一致。
  return skipExistingNotes({ files, skipped, renamed }, opts.existing);
}

/**
 * 导入来源的展示文案：给界面用（导入前说清"我要吃进去的是什么、从哪来"）。
 *
 * `renamedCount` 是可选的第四个参数（默认 0）：只有真的清洗过标题时才会多出这句，
 * 于是既有调用方的输出逐字不变，而 A 入口（Anki：`What is P50?` 这类标题最多）能把
 * "有几篇标题被换过名字"一起讲清楚——名字变了不报，用户会以为卡丢了。
 */
export function importSummary(
  fileCount: number,
  skippedCount: number,
  sourceNote: string,
  renamedCount = 0
): string {
  const base = `来源：${sourceNote} · 新增 ${fileCount} 篇`;
  const parts = [base];
  if (skippedCount) parts.push(`跳过 ${skippedCount} 篇`);
  if (renamedCount) parts.push(`${renamedCount} 篇标题含非法字符已清洗`);
  return parts.join('，');
}
