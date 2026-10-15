import { describe, expect, it } from 'vitest';
import { hasCloze } from '../cloze';
import {
  cueAt,
  cueIndexAt,
  formatTime,
  parseSubtitle,
  parseTimestamp,
  subtitleToCardText,
} from '../subtitle';

describe('subtitle · parseTimestamp', () => {
  it('接受 SRT 逗号毫秒写法', () => {
    expect(parseTimestamp('00:00:01,200')).toBeCloseTo(1.2, 6);
  });

  it('接受 VTT 点号毫秒写法', () => {
    expect(parseTimestamp('00:00:01.200')).toBeCloseTo(1.2, 6);
  });

  it('接受省略小时位的写法', () => {
    expect(parseTimestamp('00:01:01.2')).toBeCloseTo(61.2, 6);
  });

  it('接受纯秒数', () => {
    expect(parseTimestamp('61.2')).toBeCloseTo(61.2, 6);
    expect(parseTimestamp('90')).toBe(90);
  });

  it('小数位按毫秒右补零：.2 = 200ms', () => {
    expect(parseTimestamp('00:00:01.2')).toBeCloseTo(1.2, 6);
    expect(parseTimestamp('00:00:01.02')).toBeCloseTo(1.02, 6);
  });

  it('两侧空白不影响解析', () => {
    expect(parseTimestamp(' 00:00:02,000 ')).toBe(2);
  });

  it('空串 / 非数字 / 段数超过 3 都返回 null', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('   ')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
    expect(parseTimestamp('1:2:3:4')).toBeNull();
  });

  it('缺段或时间字段不是数字时返回 null', () => {
    expect(parseTimestamp('00:00:')).toBeNull();
    expect(parseTimestamp('00:xx:01,000')).toBeNull();
    expect(parseTimestamp('00:00:01,')).toBeNull();
  });
});

describe('subtitle · parseSubtitle（SRT）', () => {
  it('标准三行块（序号 + 时间行 + 正文）', () => {
    const cues = parseSubtitle(
      '1\n00:00:01,000 --> 00:00:04,000\n第一句\n\n2\n00:00:05,000 --> 00:00:08,000\n第二句'
    );
    expect(cues).toEqual([
      { start: 1, end: 4, text: '第一句' },
      { start: 5, end: 8, text: '第二句' },
    ]);
  });

  it('末尾没有空行也能收尾', () => {
    const cues = parseSubtitle('1\n00:00:01,000 --> 00:00:04,000\n只有一句');
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('只有一句');
  });

  it('多行正文合并成一句，用 \\n 连接', () => {
    const cues = parseSubtitle('1\n00:00:01,000 --> 00:00:04,000\n第一行\n第二行\n\n2\n00:00:05,000 --> 00:00:08,000\n收尾');
    expect(cues[0].text).toBe('第一行\n第二行');
    expect(cues[0]).toEqual({ start: 1, end: 4, text: '第一行\n第二行' });
  });

  it('空行即块结束：其后没有时间行的散行当垃圾丢弃', () => {
    // SRT/VTT 的规范就是"空行分隔块"，所以块内正文是连续行；孤立散行没有归属，丢掉比硬塞进上一句安全
    const cues = parseSubtitle('1\n00:00:01,000 --> 00:00:04,000\n第一行\n\n第二行');
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('第一行');
  });

  it('时间行带 --> 两侧多余空格也吃', () => {
    const cues = parseSubtitle('1\n00:00:01,000   -->   00:00:04,000\n句子');
    expect(cues).toEqual([{ start: 1, end: 4, text: '句子' }]);
  });

  it('CRLF 换行', () => {
    const cues = parseSubtitle(
      '1\r\n00:00:01,000 --> 00:00:04,000\r\n第一句\r\n\r\n2\r\n00:00:05,000 --> 00:00:08,000\r\n第二句\r\n'
    );
    expect(cues.map((c) => c.text)).toEqual(['第一句', '第二句']);
    expect(cues[0].start).toBe(1);
  });

  it('时间行前的 SRT 序号不属于正文', () => {
    const cues = parseSubtitle('42\n00:00:01,000 --> 00:00:04,000\n正文');
    expect(cues).toEqual([{ start: 1, end: 4, text: '正文' }]);
  });
});

describe('subtitle · parseSubtitle（WebVTT）', () => {
  const vtt = [
    'WEBVTT',
    'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000',
    '',
    '1',
    '00:00:01.000 --> 00:00:04.000',
    '<v 张三>你好</v>',
    '',
    '00:00:05.000 --> 00:00:08.000 align:start position:10%',
    "{\\an8}<i>斜体</i>与<b>粗体</b><c.yellow>强调</c>",
  ].join('\n');

  it('WEBVTT 头与 X-TIMESTAMP-MAP 被忽略，正文照常解析', () => {
    const cues = parseSubtitle(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ start: 1, end: 4, text: '你好' });
  });

  it('去掉 <v 说话人> / <i> / <b> / <c...> 标签与 {\\an8} 定位标记', () => {
    const cues = parseSubtitle(vtt);
    expect(cues[1].text).toBe('斜体与粗体强调');
    expect(cues[1]).toEqual({ start: 5, end: 8, text: '斜体与粗体强调' });
  });

  it('时间行右侧的 align/position 设置不影响解析', () => {
    const cues = parseSubtitle(vtt);
    expect(cues[1].end).toBe(8);
  });
});

describe('subtitle · parseSubtitle 异常块丢弃', () => {
  it('起点或终点时间非法 → 整块丢弃', () => {
    expect(parseSubtitle('1\n00:00:xx --> 00:00:04,000\n正文')).toEqual([]);
    expect(parseSubtitle('1\n00:00:01,000 --> 无\n正文')).toEqual([]);
    expect(parseSubtitle('1\n--> 00:00:04,000\n正文')).toEqual([]);
  });

  it('正文去掉标签与空白后为空 → 整块丢弃', () => {
    expect(parseSubtitle('1\n00:00:01,000 --> 00:00:04,000\n<i></i>')).toEqual([]);
    expect(parseSubtitle('1\n00:00:01,000 --> 00:00:04,000\n<v 张三></v>')).toEqual([]);
    expect(parseSubtitle('1\n00:00:01,000 --> 00:00:04,000\n   ')).toEqual([]);
  });

  it('正常块旁边的坏块被丢掉，好块保留', () => {
    const cues = parseSubtitle(
      '1\n00:00:xx --> 00:00:02,000\n坏块\n\n2\n00:00:05,000 --> 00:00:08,000\n好块'
    );
    expect(cues).toEqual([{ start: 5, end: 8, text: '好块' }]);
  });
});

describe('subtitle · parseSubtitle 区间与排序', () => {
  it('end <= start 时兜成下一句的 start', () => {
    const cues = parseSubtitle(
      '1\n00:00:01,000 --> 00:00:01,000\n第一句\n\n2\n00:00:05,000 --> 00:00:08,000\n第二句'
    );
    expect(cues).toEqual([
      { start: 1, end: 5, text: '第一句' },
      { start: 5, end: 8, text: '第二句' },
    ]);
  });

  it('最后一句 end <= start 时兜成 start（不造负区间）', () => {
    expect(parseSubtitle('1\n00:00:05,000 --> 00:00:04,000\n唯一一句')).toEqual([
      { start: 5, end: 5, text: '唯一一句' },
    ]);
  });

  it('输入乱序也能得到 start 升序', () => {
    const cues = parseSubtitle(
      '1\n00:00:09,000 --> 00:00:10,000\n后\n\n2\n00:00:02,000 --> 00:00:03,000\n先\n\n3\n00:00:05,000 --> 00:00:06,000\n中'
    );
    expect(cues.map((c) => c.text)).toEqual(['先', '中', '后']);
    expect(cues.map((c) => c.start)).toEqual([2, 5, 9]);
  });

  it('完整 SRT 走一遍：区间合法且升序', () => {
    const cues = parseSubtitle(
      '1\n00:00:09,000 --> 00:00:09,000\n退化的中间句\n\n2\n00:00:02,000 --> 00:00:03,000\n开头\n\n3\n00:00:20,000 --> 00:00:22,000\n结尾'
    );
    expect(cues.map((c) => [c.start, c.end])).toEqual([
      [2, 3],
      [9, 20],
      [20, 22],
    ]);
    for (const c of cues) expect(c.end).toBeGreaterThanOrEqual(c.start);
  });
});

describe('subtitle · cueAt / cueIndexAt', () => {
  const sample = [
    { start: 0, end: 2, text: 'a' },
    { start: 5, end: 7, text: 'b' },
  ];

  it('区间内命中', () => {
    expect(cueAt(sample, 1)?.text).toBe('a');
    expect(cueAt(sample, 6)?.text).toBe('b');
    expect(cueIndexAt(sample, 6)).toBe(1);
  });

  it('边界：正好等于 start / 正好等于 end 都算命中', () => {
    expect(cueAt(sample, 0)?.text).toBe('a');
    expect(cueAt(sample, 2)?.text).toBe('a');
    expect(cueAt(sample, 5)?.text).toBe('b');
    expect(cueAt(sample, 7)?.text).toBe('b');
    expect(cueIndexAt(sample, 0)).toBe(0);
    expect(cueIndexAt(sample, 2)).toBe(0);
    expect(cueIndexAt(sample, 5)).toBe(1);
    expect(cueIndexAt(sample, 7)).toBe(1);
  });

  it('落在句间空隙返回 null / -1', () => {
    expect(cueAt(sample, 3)).toBeNull();
    expect(cueIndexAt(sample, 3)).toBe(-1);
    expect(cueAt(sample, 4.999)).toBeNull();
  });

  it('越界、负数、非有限数都算没命中', () => {
    expect(cueAt(sample, -1)).toBeNull();
    expect(cueAt(sample, 100)).toBeNull();
    expect(cueIndexAt(sample, -1)).toBe(-1);
    expect(cueIndexAt(sample, NaN)).toBe(-1);
    expect(cueIndexAt(sample, Infinity)).toBe(-1);
    expect(cueAt([], 0)).toBeNull();
    expect(cueIndexAt([], 0)).toBe(-1);
  });
});

describe('subtitle · formatTime', () => {
  it('0 秒 → 0:00', () => {
    expect(formatTime(0)).toBe('0:00');
  });

  it('小数向下取整，m:ss', () => {
    expect(formatTime(61.2)).toBe('1:01');
    expect(formatTime(59.9)).toBe('0:59');
    expect(formatTime(12)).toBe('0:12');
  });

  it('超过 1 小时用 h:mm:ss', () => {
    expect(formatTime(3661)).toBe('1:01:01');
    expect(formatTime(3600)).toBe('1:00:00');
  });

  it('负数与非有限数按 0 处理', () => {
    expect(formatTime(-3)).toBe('0:00');
    expect(formatTime(NaN)).toBe('0:00');
  });
});

describe('subtitle · subtitleToCardText', () => {
  /** 造一条字幕：文本 + 起点秒数 */
  const cue = (start: number, text: string) => ({ start, end: start + 3, text });

  it('括号内的词被挖空（中英文括号都认）', () => {
    expect(subtitleToCardText([cue(12, '心输出量等于（每搏输出量）乘心率')])).toBe(
      '- 0:12 心输出量等于（{{每搏输出量}}）乘心率'
    );
    expect(subtitleToCardText([cue(12, '心输出量等于(每搏输出量)乘心率')])).toBe(
      '- 0:12 心输出量等于({{每搏输出量}})乘心率'
    );
  });

  it('数字+单位被挖空', () => {
    expect(subtitleToCardText([cue(60, '成人静息心率约 60次/分')])).toBe(
      '- 1:00 成人静息心率约 {{60次/分}}'
    );
    expect(subtitleToCardText([cue(60, '疗程 28天')])).toBe('- 1:00 疗程 {{28天}}');
  });

  it('英文术语被挖空', () => {
    expect(subtitleToCardText([cue(75, '动脉血氧分压 PaO2 降低')])).toBe(
      '- 1:15 动脉血氧分压 {{PaO2}} 降低'
    );
  });

  it('没有关键词的句子不挖（宁可少挖，不要乱挖）', () => {
    expect(subtitleToCardText([cue(3, '他说话很快我们都没听清')])).toBe('- 0:03 他说话很快我们都没听清');
    expect(subtitleToCardText([cue(4, '下面我们来看第三个问题')])).toBe('- 0:04 下面我们来看第三个问题');
  });

  it('已经带 {{}} 的句子不重复包一层', () => {
    const out = subtitleToCardText([cue(8, '{{心输出量}} = {{每搏输出量}} × 心率')]);
    expect(out).toBe('- 0:08 {{心输出量}} = {{每搏输出量}} × 心率');
    expect(out).not.toContain('{{{{');
  });

  it('括号里已经是挖空时不重复包（与 wrapCloze 同判定）', () => {
    expect(subtitleToCardText([cue(9, '公式（{{每搏输出量}}）')])).toBe('- 0:09 公式（{{每搏输出量}}）');
  });

  it('每句一行，行首是 formatTime 的时间戳', () => {
    const out = subtitleToCardText([cue(12, '第一句'), cue(20, '第二句')]);
    expect(out).toBe('- 0:12 第一句\n- 0:20 第二句');
    expect(out.split('\n')).toHaveLength(2);
    expect(out.split('\n')[1].startsWith(`- ${formatTime(20)} `)).toBe(true);
  });

  it('一句内部的换行折成一行（保持「一句一行」）', () => {
    expect(subtitleToCardText([cue(1, '上半句\n下半句')])).toBe('- 0:01 上半句 下半句');
  });

  it('maxPerCue 控制每句最多挖几处，同级取更长的', () => {
    const text = '（心输出量）与（心率）的关系';
    expect(subtitleToCardText([cue(5, text)], 2)).toBe('- 0:05 （{{心输出量}}）与（{{心率}}）的关系');
    expect(subtitleToCardText([cue(5, text)], 1)).toBe('- 0:05 （{{心输出量}}）与（心率）的关系');
    expect(subtitleToCardText([cue(5, text)], 0)).toBe(`- 0:05 ${text}`);
  });

  it('空数组返回空串，空正文的句子被跳过', () => {
    expect(subtitleToCardText([])).toBe('');
    expect(subtitleToCardText([cue(1, '   ')])).toBe('');
    expect(subtitleToCardText([cue(1, ''), cue(2, '有内容')])).toBe('- 0:02 有内容');
  });

  it('SRT 解析结果能直接转成卡片正文', () => {
    const cues = parseSubtitle(
      '1\n00:00:12,000 --> 00:00:15,000\n静息心率（60次/分）\n\n2\n00:00:20,000 --> 00:00:23,000\n普通一句'
    );
    expect(subtitleToCardText(cues)).toBe('- 0:12 静息心率（{{60次/分}}）\n- 0:20 普通一句');
  });

  it('挖出来的标记能被 core/cloze 的 hasCloze 认出（否则复习界面不遮答案）', () => {
    expect(hasCloze(subtitleToCardText([cue(12, '静息心率（60次/分）')]))).toBe(true);
    expect(hasCloze(subtitleToCardText([cue(12, '普通的一句')]))).toBe(false);
  });
});
