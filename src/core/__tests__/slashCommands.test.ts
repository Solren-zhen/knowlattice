/**
 * 斜杠命令纯函数测试。
 * 钉两处容易写错的地方：触发判定（行中随便一个 `/` 就弹菜单＝灾难）与匹配排序
 * （用户敲 `表` 时「表格」必须排在「今天的日期」前面）。
 */
import { describe, expect, it } from 'vitest';
import { detectSlash, matchSlash, slashCommands, todayStamp } from '../slashCommands';

describe('matchSlash', () => {
  it('空查询按表内顺序返回，表格排第一', () => {
    const list = matchSlash('');
    expect(list.length).toBe(8);
    expect(list[0].id).toBe('table');
  });

  it('中文标签命中', () => {
    expect(matchSlash('表格').map((c) => c.id)).toEqual(['table']);
    expect(matchSlash('待办')[0].id).toBe('todo');
  });

  it('别名命中（拼音与英文）', () => {
    expect(matchSlash('gongshi')[0].id).toBe('math');
    expect(matchSlash('code')[0].id).toBe('code');
  });

  it('标签命中排在别名命中之前', () => {
    // `date` 既是「今天的日期」的别名，也出现在别的标签里；标签命中必须靠前
    const ids = matchSlash('date').map((c) => c.id);
    expect(ids[0]).toBe('date');
    // 无命中返回空数组（调用方据此不弹菜单，也不会吞掉回车）
    expect(matchSlash('zzzz')).toEqual([]);
  });
});

describe('detectSlash', () => {
  it('行首敲 / 触发，query 是斜杠后的内容', () => {
    expect(detectSlash('/表', 0, 2)).toEqual({ query: '表', from: 0, to: 2 });
  });

  it('列表/引用标记后面也算行首', () => {
    const hit = detectSlash('- /todo', 100, 107);
    expect(hit?.query).toBe('todo');
    expect(hit?.from).toBe(102);
  });

  it('正文中间出现的斜杠不触发（否则打分数、路径就弹菜单）', () => {
    expect(detectSlash('血压 120/80', 0, 9)).toBeNull();
    expect(detectSlash('见附录/A', 0, 6)).toBeNull();
  });

  it('斜杠后已有空格就不再触发（视为普通文字）', () => {
    expect(detectSlash('/ 表格', 0, 4)).toBeNull();
  });
});

describe('todayStamp', () => {
  it('补零到 YYYY-MM-DD', () => {
    expect(todayStamp(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('命令表里的日期命令用同一个格式', () => {
    const cmd = slashCommands(new Date(2026, 11, 31)).find((c) => c.id === 'date');
    expect(cmd?.insert).toBe('2026-12-31');
  });
});
