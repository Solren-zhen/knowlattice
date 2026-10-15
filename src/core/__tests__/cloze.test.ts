import { describe, expect, it } from 'vitest';
import { CLOZE_PLACEHOLDER, countCloze, hasCloze, maskCloze, revealCloze, wrapCloze } from '../cloze';

describe('cloze · 计数与判定', () => {
  it('一行可以有多处挖空', () => {
    expect(countCloze('心输出量 = {{每搏输出量}} × {{心率}}')).toBe(2);
    expect(hasCloze('心输出量 = {{每搏输出量}} × {{心率}}')).toBe(true);
  });

  it('没有挖空时为 0', () => {
    expect(countCloze('普通正文，没有标记')).toBe(0);
    expect(hasCloze('')).toBe(false);
  });

  it('空花括号与单层花括号都不是挖空', () => {
    expect(countCloze('{{}}')).toBe(0);
    expect(countCloze('{心率}')).toBe(0);
  });

  it('不支持嵌套：{{{{x}}}} 只会认出里面那一层', () => {
    // 这是已知边界（wrapCloze 会拦住重复包一层的情况），在此固定住行为免得被误改
    expect(countCloze('{{{{x}}}}')).toBe(1);
  });

  it('跨行的两处挖空都算', () => {
    expect(countCloze('- 定义: {{a}}\n- 机制: {{b}}')).toBe(2);
  });
});

describe('cloze · 遮罩（题面）', () => {
  it('遮住内容并保留上下文', () => {
    expect(maskCloze('心输出量 = {{每搏输出量}} × {{心率}}')).toBe(
      `心输出量 = ${CLOZE_PLACEHOLDER} × ${CLOZE_PLACEHOLDER}`
    );
  });

  it('没有挖空时原样返回', () => {
    const s = '普通正文\n第二行';
    expect(maskCloze(s)).toBe(s);
  });

  it('跳过围栏代码块：笔记里抄的代码不会被改坏', () => {
    const s = '前\n```\n{{不要遮}}\n```\n后 {{要遮}}';
    expect(maskCloze(s)).toBe(`前\n\`\`\`\n{{不要遮}}\n\`\`\`\n后 ${CLOZE_PLACEHOLDER}`);
  });

  it('跳过行内代码：Anki 模板写法不会被遮', () => {
    const s = '模板是 `{{正面}}` 而这里 {{要遮}}';
    expect(maskCloze(s)).toBe(`模板是 \`{{正面}}\` 而这里 ${CLOZE_PLACEHOLDER}`);
  });

  it('可自定义占位符', () => {
    expect(maskCloze('{{x}}', '[]')).toBe('[]');
  });
});

describe('cloze · 还原（答案面）', () => {
  it('只去掉标记、保留内容', () => {
    expect(revealCloze('心输出量 = {{每搏输出量}} × {{心率}}')).toBe('心输出量 = 每搏输出量 × 心率');
  });

  it('没有挖空时原样返回（含代码块内的花括号）', () => {
    const s = '```\n{{正面}}\n```\n`{{afmt}}`';
    expect(revealCloze(s)).toBe(s);
  });

  it('两道工序各司其职：遮罩出题面、还原出答案', () => {
    const s = '- 定义: {{甲}}\n- 鉴别: 与{{乙}}相鉴别';
    expect(maskCloze(s)).toBe(`- 定义: ${CLOZE_PLACEHOLDER}\n- 鉴别: 与${CLOZE_PLACEHOLDER}相鉴别`);
    expect(revealCloze(s)).toBe('- 定义: 甲\n- 鉴别: 与乙相鉴别');
    // 遮罩丢掉了内容，所以从题面反推不出答案——这是设计选择（题面不该泄漏答案），不是缺陷
    expect(revealCloze(maskCloze(s))).toBe(`- 定义: ${CLOZE_PLACEHOLDER}\n- 鉴别: 与${CLOZE_PLACEHOLDER}相鉴别`);
  });
});

describe('cloze · 编辑器包装', () => {
  it('把选区包成挖空', () => {
    expect(wrapCloze('心率')).toBe('{{心率}}');
  });

  it('已经是挖空的内容不重复包一层', () => {
    expect(wrapCloze('{{心率}}')).toBe('{{心率}}');
  });

  it('空选区给出一对空花括号，光标可落进去', () => {
    expect(wrapCloze('   ')).toBe('{{}}');
  });
});
