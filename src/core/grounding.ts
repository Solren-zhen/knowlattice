/**
 * 生成内容的 grounding（落地校验）：模型写出来的引用必须指向库里真实存在的东西。
 *
 * 为什么需要：提示词里写「尽量带 [[双链]]」只是建议，模型会顺手编一个不存在的笔记名。
 * 日志、卡片、学习建议一旦落库，坏链就成了用户的知识库里要自己收拾的垃圾。
 * 所以在**写盘前**用真实索引核对一次：解析不出来就回填错误让模型改，而不是静默存下。
 *
 * 判定口径与 Obsidian 一致：`[[目标]]`、`[[目标|显示名]]`、`[[目标#小节]]` 都只校验 `目标`。
 * 解析器由调用方注入（通常是 `vault.resolveLink`），这样纯函数层不依赖库实现。
 */

/** 抽取 `[[目标]]` / `[[目标|别名]]` / `[[目标#小节]]` 里的**目标**部分（去重、保序）。 */
export function extractWikilinkTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const index = m.index ?? 0;
    if (index > 0 && text[index - 1] === '!') continue; // 嵌入 `![[图.png]]` 不是双链
    const inner = m[1];
    // 先摘锚点再摘别名：`[[A#x|y]]` 的目标是 A
    const target = inner.split('#')[0].split('|')[0].trim();
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

export interface GroundingOptions {
  /**
   * 该目标是否存在。缺省视为「无法校验」→ 直接通过（调用方没给索引时不要假装校验过）。
   */
  resolve?: (target: string) => boolean;
  /** 最多在错误文案里列几个（剩下的只报数量，避免一条工具结果刷屏） */
  maxListed?: number;
}

/**
 * 找出**解析不出来**的引用目标。返回空数组 = 全部落地。
 * `resolve` 缺省时永远返回空数组（无法校验不等于校验通过，但这里不制造假阳性）。
 */
export function missingWikilinks(texts: readonly string[], options: GroundingOptions = {}): string[] {
  const resolve = options.resolve;
  if (!resolve) return [];
  const missing: string[] = [];
  for (const text of texts) {
    for (const target of extractWikilinkTargets(text)) {
      if (missing.includes(target)) continue;
      let ok = false;
      try {
        ok = resolve(target);
      } catch {
        // 索引实现抛错不应让「写日志」整条链失败：按无法确认处理，交给模型改
        ok = false;
      }
      if (!ok) missing.push(target);
    }
  }
  return missing;
}

/** 给模型的错误文案（中文、可执行：说清哪几个、以及下一步该做什么）。 */
export function missingLinksMessage(missing: readonly string[], options: GroundingOptions = {}): string {
  const maxListed = options.maxListed ?? 3;
  const listed = missing.slice(0, maxListed).map((t) => `「${t}」`).join('、');
  const rest = missing.length > maxListed ? ` 等 ${missing.length} 个` : '';
  return (
    `错误：这些双链指向的笔记在库里不存在：${listed}${rest}。`
    + '请先用 list_notes / search_notes 确认真实存在的笔记名，改成真实标题（或去掉链接只留文字）再提交；'
    + '不要凭印象编一个笔记名。'
  );
}

/**
 * 一次校验：全落地返回 null，否则返回给模型的错误文案。
 * 用法：`const err = groundingIssue([topic, ...weakPoints], { resolve }); if (err) return err;`
 */
export function groundingIssue(texts: readonly string[], options: GroundingOptions = {}): string | null {
  const missing = missingWikilinks(texts, options);
  return missing.length ? missingLinksMessage(missing, options) : null;
}
