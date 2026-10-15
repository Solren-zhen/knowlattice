/**
 * 恢复 / 导入的合并规划（**纯函数**，不读 IndexedDB、不碰 localStorage）。
 *
 * 用户要求：**「备份与恢复时不要覆盖已有内容，新增的内容单独增加」**。落到本模块，
 * 每次恢复 / 导入一批文件时按「路径是否存在、现有内容是什么」做三分类（不写盘、不查库，
 * 存在性与现有内容由调用方通过一个查询接口 `lookup` 提供）：
 *
 *   add      —— 路径不存在 → 正常写入（新增）
 *   same     —— 路径已存在且内容**逐字相同** → 跳过（幂等的关键：再导一遍不会产生副本）
 *   conflict —— 路径已存在但内容不同 → 备份/来源里那一篇**另存**到一个可追溯的冲突目录，
 *               两份都留在库里。
 *
 * **为什么冲突要另存，而不是丢弃或覆盖**：
 *   - 覆盖 = 用户自己改过的正文被静默换掉，且这条通道不推历史快照，覆盖后**不可恢复**；
 *   - 丢弃 = 备份/来源里那一版永久消失，用户以为「恢复成功了」，其实少了一份内容；
 *   - 另存 = 谁的都不丢，用户事后可以自己对比取舍。冲突目录名（`恢复冲突/` / `导入冲突/`）
 *     与文件名后缀（`（恢复 <时间戳>）`）都明确写着「这是另一版本」，不会和正常笔记混淆。
 *
 * 纯函数的意义：单测可以不搭任何存储后端，直接给一个假 `lookup` 就能验证三分类与命名；
 * 真正的落盘与「到哪查存在性」由 core/vault.ts 负责拼接。
 */

/** 一个路径的现状：是否存在；若存在，其内容（未知时给 null）。 */
export interface ExistingFile {
  exists: boolean;
  /** 已知内容；只知存在、拿不到内容时传 null（此时任何非 null 输入都按 conflict 处理，偏保守）。 */
  content: string | null;
}

/** 查询接口：调用方把「内存缓存 / 存储层」的存在性与内容包成这个函数，本模块不关心底层。 */
export type VaultFileLookup = (path: string) => ExistingFile | Promise<ExistingFile>;

/** 待处理的文件条目（path 是 vault 相对路径，content 是要写入 / 比对的内容）。 */
export interface MergeEntry {
  path: string;
  content: string;
}

/** 单条的判定结果。 */
export interface MergePlanEntry extends MergeEntry {
  verdict: 'add' | 'conflict' | 'same';
  /** verdict === 'conflict' 时：本篇另存的目标路径。 */
  conflictPath?: string;
}

export interface MergePlan {
  /** 逐条明细（保持输入顺序）。 */
  entries: MergePlanEntry[];
  /** 要新增写入的条目。 */
  toAdd: MergeEntry[];
  /** 要另存到冲突目录的条目（path 已是冲突目标路径）。 */
  toConflict: MergeEntry[];
  /** 因内容相同而跳过的原路径。 */
  same: string[];
  added: number;
  conflicts: number;
  unchanged: number;
}

/** 冲突命名参数：目录前缀、文件名里标注的词、同一批共用的时间戳。 */
export interface MergeNaming {
  /** 冲突另存目录前缀，如 `恢复冲突` / `导入冲突`。 */
  conflictRoot: string;
  /** 文件名里标注「这是哪来的另一版本」，如 `恢复` / `导入`。 */
  conflictLabel: string;
  /** 同一批共用的时间戳，如 `2026-10-13 2215`（由 formatConflictStamp 生成）。 */
  timestamp: string;
}

/**
 * 时间戳字符串：`YYYY-MM-DD HHmm`（如 `2026-10-13 2215`）。
 * **稳定可复现**：同一批只算一次、传给整批条目，绝不用 Math.random——
 * 冲突文件名要能被测试断言、也要让用户一眼看懂「这是哪次恢复留下的」。
 */
export function formatConflictStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * 冲突目标路径：`<root>/<原相对目录>/<标题>（<label> <时间戳>）.md`。
 * 标题里的 `.md` 去掉后拼后缀；目录部分原样保留，便于用户顺着目录找回原笔记的邻居。
 */
function conflictPathFor(entryPath: string, naming: MergeNaming, ordinal: number): string {
  const noExt = entryPath.replace(/\.md$/i, '');
  const slash = noExt.lastIndexOf('/');
  const dir = slash >= 0 ? noExt.slice(0, slash) : '';
  const title = slash >= 0 ? noExt.slice(slash + 1) : noExt;
  const base = `${naming.conflictRoot}/${dir ? `${dir}/` : ''}${title}（${naming.conflictLabel} ${naming.timestamp}）`;
  return `${base}${ordinal > 1 ? ` (${ordinal})` : ''}.md`;
}

/**
 * 规划一批文件的合并：不写盘，只给出「写哪些 / 另存哪些 / 跳过哪些」及计数。
 *
 * 冲突目标路径的去重规则（保证**两份都保留**）：
 *   ① 同批内已占用的目标路径不再复用；
 *   ② 目标路径在库里**已存在**（例如同一分钟内又恢复了一份不同的备份）时也顺延编号，
 *      绝不去覆盖上一次留下的冲突副本——否则「谁都不丢」只在单次内成立。
 * 两条都由入参 `lookup` 判定存在性，本模块不自己碰存储。
 */
export async function planMerge(
  entries: MergeEntry[],
  lookup: VaultFileLookup,
  naming: MergeNaming,
): Promise<MergePlan> {
  const plan: MergePlan = { entries: [], toAdd: [], toConflict: [], same: [], added: 0, conflicts: 0, unchanged: 0 };
  // 事先占用所有原路径：冲突另存的目标不得与任何一篇原路径撞车（撞了就会把别的篇目顶掉）。
  const used = new Set<string>(entries.map((e) => e.path));
  for (const entry of entries) {
    const current = await lookup(entry.path);
    if (!current.exists) {
      plan.toAdd.push({ path: entry.path, content: entry.content });
      plan.added++;
      plan.entries.push({ ...entry, verdict: 'add' });
      continue;
    }
    if (current.content !== null && current.content === entry.content) {
      plan.same.push(entry.path);
      plan.unchanged++;
      plan.entries.push({ ...entry, verdict: 'same' });
      continue;
    }
    // 内容不同（或拿不到现有内容，保守按冲突处理）：另存，绝不覆盖现有。
    let ordinal = 1;
    let target = conflictPathFor(entry.path, naming, ordinal);
    // ordinal 上限只是防御性护栏，正常一批里不会真的数到这么多
    while ((used.has(target) || (await lookup(target)).exists) && ordinal < 1000) {
      ordinal++;
      target = conflictPathFor(entry.path, naming, ordinal);
    }
    used.add(target);
    plan.toConflict.push({ path: target, content: entry.content });
    plan.conflicts++;
    plan.entries.push({ ...entry, verdict: 'conflict', conflictPath: target });
  }
  return plan;
}

/**
 * 对象型存储（键 → 值）的逐键合并：现有键一律保留、不覆盖，只挑出**新键**。
 * 返回 fresh（只含新键，交给存储自己的导入器即可，天然不会碰到现有键）与计数。
 * 现有键的值原样留着——这就是「键已存在则保留现有值」。
 */
export function pickNewObjectKeys(
  incoming: unknown,
  existing: Record<string, unknown>,
): { fresh: Record<string, unknown>; added: number; kept: number } {
  const fresh: Record<string, unknown> = {};
  let added = 0;
  let kept = 0;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { fresh, added, kept };
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    if (Object.prototype.hasOwnProperty.call(existing, k)) {
      kept++;
      continue;
    }
    fresh[k] = v;
    added++;
  }
  return { fresh, added, kept };
}

/**
 * 数组型存储（条目带身份键）的逐项合并：现有键一律保留，只挑出新键。
 * `keyOf` 取不到身份键的条目按新增处理（无法判重，宁可能多也不能漏——漏了就是丢数据）。
 */
export function pickNewListItems(
  incoming: unknown,
  existingKeys: ReadonlySet<string>,
  keyOf: (item: Record<string, unknown>) => string | undefined,
): { fresh: Record<string, unknown>[]; added: number; kept: number } {
  const fresh: Record<string, unknown>[] = [];
  let added = 0;
  let kept = 0;
  if (!Array.isArray(incoming)) return { fresh, added, kept };
  for (const item of incoming) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const key = keyOf(rec);
    if (key !== undefined && existingKeys.has(key)) {
      kept++;
      continue;
    }
    fresh.push(rec);
    added++;
  }
  return { fresh, added, kept };
}
