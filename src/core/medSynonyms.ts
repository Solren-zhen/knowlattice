/**
 * 「模糊查询」里的语义近似：一张**本地小词表**，把俗称 / 缩写 / 学名连起来。
 *
 * 为什么不用向量：晶格是离线优先的单文件应用，一个中文医学 embedding 模型
 * 动辄上百 MB，装进 41 MB 的离线包里不合适，而且首次加载要等模型下载。
 * 用户要的是「模糊查询语义近似就行」——所以这里只做两件便宜且可验证的事：
 *   ① 缩写 ↔ 全称 ↔ 俗称 的等价词表（本文件）；
 *   ② 笔记自己的 `aliases` 字段进索引（searchIndex.ts）——这才是真正
 *      「随用户数据长出来」的语义层，用户写什么别名就能搜到什么。
 *
 * 词表的纪律：**只收真正等价的**。胃溃疡和十二指肠溃疡都是消化性溃疡，
 * 但彼此不等价，放进来会让搜索指向错的笔记——宁可少收，不可错收。
 */

/** 等价词组。同组内的词互为近似，搜索时一起参与召回。 */
const GROUPS: string[][] = [
  // 心血管
  ['心梗', '心肌梗死', 'AMI', '急性心肌梗死'],
  ['心衰', '心力衰竭', '充血性心力衰竭', 'HF'],
  ['房颤', '心房颤动', 'AF'],
  ['室颤', '心室颤动', 'VF'],
  ['房室传导阻滞', 'AVB'],
  ['冠心病', '冠状动脉粥样硬化性心脏病', 'CHD'],
  ['高血压', '原发性高血压', 'HTN'],
  ['心绞痛', '稳定型心绞痛', 'SA'],
  ['心脏骤停', '心搏骤停'],
  // 内分泌
  ['甲亢', '甲状腺功能亢进', '甲状腺功能亢进症'],
  ['甲减', '甲状腺功能减退', '甲状腺功能减退症'],
  ['糖尿病', 'DM'],
  ['1型糖尿病', 'T1DM', 'I型糖尿病'],
  ['2型糖尿病', 'T2DM', 'II型糖尿病'],
  ['DKA', '糖尿病酮症酸中毒'],
  ['库欣综合征', '皮质醇增多症'],
  // 呼吸
  ['COPD', '慢性阻塞性肺疾病', '慢阻肺'],
  ['ARDS', '急性呼吸窘迫综合征'],
  ['呼衰', '呼吸衰竭'],
  ['呼酸', '呼吸性酸中毒'],
  ['呼碱', '呼吸性碱中毒'],
  ['代酸', '代谢性酸中毒'],
  ['代碱', '代谢性碱中毒'],
  ['肺栓塞', 'PE', '肺动脉栓塞'],
  ['氧解离曲线', '氧离曲线'],
  ['黑-伯反射', 'Hering-Breuer反射', '肺牵张反射'],
  // 神经
  ['脑梗', '脑梗死', '脑梗塞', '缺血性脑卒中'],
  ['脑出血', 'ICH', '脑溢血'],
  ['SAH', '蛛网膜下腔出血'],
  ['TIA', '短暂性脑缺血发作'],
  ['癫痫', '痫性发作'],
  ['帕金森病', 'PD', '震颤麻痹'],
  ['阿尔茨海默病', 'AD', '老年性痴呆'],
  // 泌尿
  ['AKI', '急性肾损伤', '急性肾衰竭'],
  ['CKD', '慢性肾脏病', '慢性肾衰竭'],
  ['肾衰', '肾功能衰竭', '肾衰竭'],
  ['GFR', '肾小球滤过率'],
  ['肾病综合征', 'NS'],
  // 消化
  ['消化性溃疡', 'PU'],
  ['肝硬化', 'LC'],
  ['急性胰腺炎', 'AP'],
  ['GERD', '胃食管反流病'],
  ['肠易激综合征', 'IBS'],
  // 血液
  ['IDA', '缺铁性贫血'],
  ['再障', '再生障碍性贫血', 'AA'],
  ['DIC', '弥散性血管内凝血'],
  ['ITP', '免疫性血小板减少症', '特发性血小板减少性紫癜'],
  // 生化
  ['TCA循环', '三羧酸循环', '柠檬酸循环', 'Krebs循环'],
  ['糖酵解', 'EMP'],
  ['氧化磷酸化', 'OXPHOS'],
  ['PCR', '聚合酶链反应'],
  // 感染 / 其他
  ['SIRS', '全身炎症反应综合征'],
  ['MODS', '多器官功能障碍综合征'],
  ['休克', 'shock'],
];

/** 归一化：去掉所有空白并转小写（CJK 不受影响，ASCII 统一大小写） */
const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

/** 用户自定义等价词组（设置页维护，localStorage 持久化），与内置 GROUPS 合并生效 */
let USER_GROUPS: string[][] = [];

/** 归一化词 → 该词所在组的全部词（保留原始写法，供高亮时在正文里找） */
const INDEX: Map<string, string[]> = new Map();
/** 按长度降序排好的键：包含式命中要长词优先（否则"心梗"会被更短的键抢走） */
let KEYS_BY_LEN: string[] = [];

function rebuildIndex(): void {
  INDEX.clear();
  for (const group of [...GROUPS, ...USER_GROUPS]) {
    for (const term of group) {
      const k = norm(term);
      if (!k) continue;
      // 一个词出现在多组里时合并，不覆盖
      const prev = INDEX.get(k);
      INDEX.set(k, prev ? [...new Set([...prev, ...group])] : [...group]);
    }
  }
  KEYS_BY_LEN = [...INDEX.keys()].sort((a, b) => b.length - a.length);
}
rebuildIndex();

/** 词表规模（供测试与「设置」页显示，别把数据说大）。含用户自定义词。 */
export function synonymTermCount(): number {
  return INDEX.size;
}

/** localStorage 键：用户自定义等价词组（string[][] 的 JSON） */
export const USER_SYNONYMS_KEY = 'knowlattice.medSynonyms';

/**
 * 设置页的文本框 → 词组：每行一组，行内按空白/逗号/顿号分隔，
 * 组内不足 2 个词的行丢弃。只做解析不落库，落库由调用方负责。
 */
export function parseSynonymLines(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(/[\s,，、]+/).filter(Boolean))
    .filter((parts) => parts.length >= 2);
}

/** 覆盖用户自定义词组并立即生效（下次 expandQuery 就带上）。 */
export function setUserSynonymGroups(groups: string[][]): void {
  USER_GROUPS = groups;
  rebuildIndex();
}

/** 启动时从 localStorage 恢复用户词组；返回恢复的词组数（无存储环境返回 0）。 */
export function loadUserSynonyms(): number {
  try {
    const raw = localStorage.getItem(USER_SYNONYMS_KEY);
    if (!raw) return 0;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return 0;
    const groups = parsed
      .filter((g): g is string[] => Array.isArray(g) && g.every((t) => typeof t === 'string'))
      .filter((g) => g.length >= 2);
    setUserSynonymGroups(groups);
    return groups.length;
  } catch {
    return 0;
  }
}

/** 展开结果的上限：词表命中过多时只取前若干个，避免一次查询召回被稀释成噪声 */
const MAX_EXTRA = 8;

/**
 * 查询 → 参与搜索/高亮的一组词。返回**原始写法**（含空格），
 * 归一化交给下游的 bigramTokenize 与 locateAll。
 *
 * 两种命中方式：
 *   ① 整串就是词表里的词（"心梗"）；
 *   ② 查询里**包含**词表里的词（"心梗的处理"）——此时把等价词追加进来，
 *      因为 MiniSearch 是 OR 召回，追加只会提高召回，不会漏掉原有结果。
 */
export function expandQuery(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const out: string[] = [q];
  const seen = new Set([norm(q)]);

  const push = (term: string): boolean => {
    const k = norm(term);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    out.push(term);
    return true;
  };

  const exact = INDEX.get(norm(q));
  if (exact) {
    let added = 0;
    for (const t of exact) if (push(t) && ++added >= MAX_EXTRA) break;
    return out;
  }

  // 包含式命中：长词优先，避免"心梗"先被"梗"这类短词抢走
  const nq = norm(q);
  let added = 0;
  for (const k of KEYS_BY_LEN) {
    if (added >= MAX_EXTRA) break;
    if (k.length < 2 || !nq.includes(k)) continue;
    for (const t of INDEX.get(k)!) if (push(t) && ++added >= MAX_EXTRA) break;
  }
  return out;
}
