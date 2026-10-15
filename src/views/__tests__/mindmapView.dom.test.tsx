// @vitest-environment jsdom
/**
 * 思维导图的「布局 / 主题 / 视图」三组预设（views/MindMapView.tsx）DOM 测试。
 *
 * 守住五件事（都是本轮新增、且最容易静默坏掉的行为）：
 *   ① 默认观感零变化：没存过偏好 = 双向展开 + 跟随应用 + 导图视图，且不往存储里写东西；
 *   ② 布局预设**真的作用到库实例上**（不是只改了个 chip 高亮）：mind-elixir 把主分支分进
 *      `.me-main.lhs` / `.me-main.rhs` / `.me-main.down` 三个组容器，
 *      于是「哪一侧有几个分支」就是方向生效的硬证据；
 *   ③ 主题预设真的换掉了实例的 CSS 变量（changeTheme 把这 22 个变量写在内联 style 上，
 *      直接读 `.map-container` 的属性值即可）；
 *   ④ 大纲视图＝可编辑的纯文本缩进大纲：内容与 treeToMd 的输出逐字一致，
 *      空节点、层级、[[双链]] 原文、非 ASCII 标题一个不丢；保存走
 *      parseOutline → treeToMd → 既有的 onSaveNote（存储格式一字不变、frontmatter 原样拼回）；
 *   ⑤ 切布局/切主题不重建实例：再切回大纲视图，文本仍是原文（编辑内容没被洗掉）。
 *
 * 环境缺口（如实标注，不写假测试）：jsdom 没有布局引擎，offsetWidth/Height 恒为 0，
 * 所以**连线与节点的真实几何（宽高、曲线形状、配色渲染结果）在 jsdom 里测不了**，
 * 这一层留给真机看；能测的是 DOM 结构 + 内联样式变量 + 落盘偏好，也就是上面 ①~⑤。
 * 被测代码一行没为测试让步，缺的运行时接口在两个垫片里补齐（见下）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MindMapView from '../MindMapView';
import { NODE_STYLE_KEY } from '../../core/mindmapNodeStyles';
import { MARK_KEY } from '../../core/mindmapMarks';
import MindElixir from 'mind-elixir';

/**
 * jsdom 里缺的两样东西，在测试里垫上（不改被测代码）：
 *   - window.matchMedia：mind-elixir 构造函数里读 prefers-color-scheme；
 *   - document.fonts：它的 init 会 await document.fonts.ready。
 * 没有这两个垫片，`new MindElixir()` 直接抛，实例根本建不起来。 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
if (!(document as unknown as { fonts?: unknown }).fonts) {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
  });
}
/**
 * 本轮又多了三样 jsdom 缺口（都是「库自己会调、但 jsdom 不实现」，不改被测代码）：
 *   - Element.prototype.scrollIntoView：本机 jsdom 里是 undefined，
 *     而 mind-elixir 的 selectNode / scrollIntoView 都会调它——不垫的话
 *     「点节点选中」「连线取起点」会直接抛，测出来的失败跟被测逻辑无关；
 *   - setPointerCapture / releasePointerCapture / hasPointerCapture：
 *     库的指针状态机直接调用，不垫会在 pointerdown 里抛。
 * 只补「存在但为空」的方法，不改变任何真实行为（jsdom 本来也没有布局可滚）。
 */
Element.prototype.scrollIntoView = () => {};
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.hasPointerCapture = () => false;

const NOTE_PATH = '01-生理学/呼吸/波尔效应.md';
/** 两个 `##` 小节 = 两条主分支：左右方向才分得出来（单条分支时空的那一侧看不出来） */
const NOTE_BODY = [
  '# 波尔效应',
  '',
  'pH 降低时氧解离曲线右移。',
  '',
  '## 机制',
  '',
  '- 二氧化碳升高',
  '  - 与 Hb 结合',
  '- 体温升高',
  '-', // 空节点（用户把节点文字清空后保存过）：以前这一行会被解析器丢掉
  '- [[呼吸性酸中毒]]',
  '',
  '## 表现',
  '',
  '- 发绀',
  '- 头晕',
  '',
].join('\n');
const NOTE = `---\ntitle: 波尔效应\ntype: concept\n---\n\n${NOTE_BODY}`;
/**
 * 写回笔记时的 frontmatter 前缀：与改动前**同一个正则**
 * （/^---\r?\n[\s\S]*?\r?\n---\r?\n?/），它只吃闭合 `---` 后的**一个**换行，
 * 所以正文与 `---` 之间的空行会在保存时消失——这是导图保存一直以来的行为，
 * 本轮没有动它（改它等于改所有笔记的字节）。 */
const FM = '---\ntitle: 波尔效应\ntype: concept\n---\n';

/** 规范大纲：与 treeToMd(parseOutline(正文)) 的输出逐字一致（缩进 2 空格、空节点是光杆 -） */
const OUTLINE = [
  '# 波尔效应',
  '- 机制',
  '  - 二氧化碳升高',
  '    - 与 Hb 结合',
  '  - 体温升高',
  '  -',
  '  - [[呼吸性酸中毒]]',
  '- 表现',
  '  - 发绀',
  '  - 头晕',
  '',
].join('\n');

const PREFS_KEY = 'knowlattice-mindmap-prefs';
const prefs = () => JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

const renderMap = (props: Partial<Parameters<typeof MindMapView>[0]> = {}) => {
  const onSaveNote = vi.fn();
  const onOpenWiki = vi.fn();
  const utils = render(
    <MindMapView
      content={NOTE}
      title="波尔效应"
      noteKey={NOTE_PATH}
      onClose={() => {}}
      onOpenWiki={onOpenWiki}
      onSaveNote={onSaveNote}
      {...props}
    />
  );
  return { ...utils, onSaveNote, onOpenWiki };
};

/** 等到 mind-elixir 真的把节点渲染出来（实例是 queueMicrotask 里建的，不能同步断言） */
const waitMap = (container: HTMLElement) =>
  waitFor(() => {
    if (!container.querySelector('.me-nodes .me-parent .me-tpc')) throw new Error('导图实例还没渲染出节点');
  });

/** 主分支落在哪一侧：库用 .me-main.lhs / .me-main.rhs / .me-main.down 三个组容器承载主分支 */
const branches = (container: HTMLElement) => {
  const n = (sel: string) => container.querySelectorAll(`${sel} > .me-wrapper`).length;
  return { lhs: n('.me-main.lhs'), rhs: n('.me-main.rhs'), down: n('.me-main.down') };
};

const topics = (container: HTMLElement) =>
  [...container.querySelectorAll('.me-tpc')].map((e) => (e.textContent ?? '').trim());

const cssVar = (container: HTMLElement, name: string) =>
  (container.querySelector('.map-container') as HTMLElement).style.getPropertyValue(name);

/** 切到大纲视图（按钮上的文案在两种视图间互为反义） */
const toOutline = async () => {
  fireEvent.click(screen.getByText('大纲视图'));
  return (await screen.findByLabelText('导图大纲文本')) as HTMLTextAreaElement;
};

describe('思维导图 · 默认观感（与改动前一致）', () => {
  it('没存过偏好 = 双向展开 + 跟随应用 + 导图视图，且不往存储里写东西', async () => {
    const { container } = renderMap();

    expect(screen.getByText('布局')).toBeTruthy();
    expect(screen.getByText('主题')).toBeTruthy();
    for (const label of ['双向展开', '大纲向右', '纵向 · 组织结构', '左向展开']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const label of ['跟随应用', '暖阳纸页', '护眼绿', '纯文字大纲']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('双向展开').className).toContain('on');
    expect(screen.getByText('跟随应用').className).toContain('on');
    expect(screen.getByText('大纲向右').className).not.toContain('on');

    // 默认是导图视图：没有大纲文本框
    expect(screen.queryByLabelText('导图大纲文本')).toBeNull();

    // 节点真的渲染出来了，且默认方向 = SIDE：两条主分支一边一条
    await waitMap(container);
    expect(branches(container)).toEqual({ lhs: 1, rhs: 1, down: 0 });
    // 默认主题 = 跟随应用：CSS 变量接的是本项目的 token
    expect(cssVar(container, '--main-border')).toBe('1px solid var(--border)');
    expect(cssVar(container, '--root-bgcolor')).toBe('var(--accent)');
    expect(topics(container)).toEqual(
      expect.arrayContaining(['波尔效应', '机制', '表现', '与 Hb 结合', '[[呼吸性酸中毒]]', '发绀'])
    );

    // 默认主题不是「纯文字大纲」，容器上不该带那个 CSS 钩子
    expect(container.querySelector('.mindmap-elixir')!.className).not.toContain('mm-plain');

    // 只是打开看一眼，不该写任何偏好（默认观感不落盘）
    expect(localStorage.getItem(PREFS_KEY)).toBeNull();
  });
});

describe('思维导图 · 布局预设真的作用到实例', () => {
  it('四个方向各自把主分支放到正确的一侧，且节点内容不丢', async () => {
    const { container } = renderMap();
    await waitMap(container);

    // 纵向 · 组织结构：整棵树切到 down 布局（库在 .me-nodes 与组容器上打 down 类）
    fireEvent.click(screen.getByText('纵向 · 组织结构'));
    expect(container.querySelector('.me-nodes')!.className).toContain('down');
    expect(branches(container).down).toBe(2);
    expect(topics(container)).toContain('与 Hb 结合');
    expect(prefs()).toEqual({ [NOTE_PATH]: { direction: 'down' } });

    // 大纲向右：所有主分支都进 rhs，lhs 组空着
    fireEvent.click(screen.getByText('大纲向右'));
    expect(container.querySelector('.me-nodes')!.className).not.toContain('down');
    expect(branches(container)).toMatchObject({ lhs: 0, rhs: 2 });
    expect(prefs()).toEqual({ [NOTE_PATH]: { direction: 'right' } });

    // 左向展开：全部进 lhs
    fireEvent.click(screen.getByText('左向展开'));
    expect(branches(container)).toMatchObject({ lhs: 2, rhs: 0 });
    expect(prefs()).toEqual({ [NOTE_PATH]: { direction: 'left' } });

    // 双向展开：回到一边一条
    fireEvent.click(screen.getByText('双向展开'));
    expect(branches(container)).toMatchObject({ lhs: 1, rhs: 1 });
    expect(prefs()).toEqual({ [NOTE_PATH]: { direction: 'side' } });

    // 换布局不重建实例（重建就丢编辑与撤销栈）：大纲视图里读到的仍是原文
    expect((await toOutline()).value).toBe(OUTLINE);
  });
});

describe('思维导图 · 主题预设真的作用到实例', () => {
  it('四个主题各自改写实例的 CSS 变量；需要 CSS 钩子的主题另挂类名，内容不丢', async () => {
    const { container } = renderMap();
    await waitMap(container);

    // 暖阳纸页：暖色纸面 + 琥珀，另挂 mm-warm（柔光阴影 / 暖纸画布 / 暖色环由 index.css 给）
    fireEvent.click(screen.getByText('暖阳纸页'));
    expect(cssVar(container, '--main-gap-x')).toBe('74px');
    expect(cssVar(container, '--root-bgcolor')).toContain('var(--amber-text)');
    expect(container.querySelector('.mindmap-elixir')!.className).toContain('mm-warm');
    expect(prefs()).toEqual({ [NOTE_PATH]: { theme: 'warm' } });

    // 护眼绿：纸面/根节点换成绿色 token
    fireEvent.click(screen.getByText('护眼绿'));
    expect(cssVar(container, '--root-bgcolor')).toBe('var(--success)');
    expect(cssVar(container, '--root-color')).toBe('var(--success-ink)');
    expect(cssVar(container, '--main-bgcolor')).toContain('var(--success)');
    expect(container.querySelector('.mindmap-elixir')!.className).not.toContain('mm-plain');
    expect(container.querySelector('.mindmap-elixir')!.className).not.toContain('mm-warm');
    expect(prefs()).toEqual({ [NOTE_PATH]: { theme: 'eye' } });

    // 纯文字大纲：无边框（--main-border: none）+ 容器挂 mm-plain（下划线/无阴影由 index.css 给）
    fireEvent.click(screen.getByText('纯文字大纲'));
    expect(cssVar(container, '--main-border')).toBe('none');
    expect(cssVar(container, '--root-bgcolor')).toBe('transparent');
    expect(container.querySelector('.mindmap-elixir')!.className).toContain('mm-plain');
    expect(container.querySelector('.mindmap-elixir')!.className).not.toContain('mm-warm');
    expect(screen.getByText('纯文字大纲').className).toContain('on');
    expect(prefs()).toEqual({ [NOTE_PATH]: { theme: 'plain' } });

    // 主题来回切不丢内容，也不把 CSS 变量 / CSS 钩子留在上一个主题的值上
    fireEvent.click(screen.getByText('跟随应用'));
    expect(cssVar(container, '--main-gap-x')).toBe('58px');
    expect(cssVar(container, '--root-bgcolor')).toBe('var(--accent)');
    const back = container.querySelector('.mindmap-elixir')!.className;
    expect(back).not.toContain('mm-warm'); // 钩子跟着主题走：切回默认就摘掉
    expect(back).not.toContain('mm-plain');
    expect((await toOutline()).value).toBe(OUTLINE);
  });

  it('每个主题都必须与默认主题有可见差异（防「两个主题看着一样」）', async () => {
    // 真实反馈：旧的「经典圆弧」与「跟随应用」只差 6 个间距/圆角数值，曲线与配色一模一样，
    // 用户看到的就是同一个主题。这条把「差异」变成可判定的：直接看库收到的主题对象
    // （palette 决定分支色、cssVar 决定其余）——四个签名两两不同，且非默认主题至少要在
    // 「换配色」或「改到 4 个以上变量」上动过手。
    const { container } = renderMap();
    await waitMap(container);
    const change = vi.spyOn(MindElixir.prototype, 'changeTheme');
    for (const label of ['暖阳纸页', '护眼绿', '纯文字大纲', '跟随应用']) fireEvent.click(screen.getByText(label));
    type Captured = { name?: string; palette?: string[]; cssVar?: Record<string, string> };
    const seen = change.mock.calls.map((c) => c[0] as Captured);
    change.mockRestore();

    const themes = new Map<string, Captured>();
    for (const t of seen) if (t?.name) themes.set(t.name, t);
    // 默认那套 + 三个具名主题（变体名带 light 后缀：themeFor 按 data-theme 选，测试里是 light）
    expect(themes.size).toBe(4);

    // ① 四个签名两两不同（palette + 全部 cssVar 一起算）
    const sig = (t: Captured) => JSON.stringify([t.palette, t.cssVar]);
    expect(new Set([...themes.values()].map(sig)).size).toBe(4);

    // ② 逐个对比默认主题：必须「换了配色」或「改到 4 个以上变量」
    const base = themes.get('knowlattice-light');
    expect(base).toBeTruthy();
    for (const [name, t] of themes) {
      if (name === 'knowlattice-light') continue;
      const cv = base!.cssVar ?? {};
      const tc = t.cssVar ?? {};
      const keys = new Set([...Object.keys(cv), ...Object.keys(tc)]);
      const diff = [...keys].filter((k) => cv[k] !== tc[k]).length;
      const paletteDiff = JSON.stringify(base!.palette) !== JSON.stringify(t.palette);
      expect(diff >= 4 || paletteDiff, `${name} 与默认主题差异太小（diff=${diff}）`).toBe(true);
    }
  });
});

describe('思维导图 · 大纲视图', () => {
  it('切到大纲视图：出现可编辑文本，内容与 treeToMd 的规范输出逐字一致', async () => {
    renderMap();
    const box = await toOutline();

    expect(box.tagName).toBe('TEXTAREA');
    expect(box.value).toBe(OUTLINE);
    // 空节点、层级、[[双链]] 原文、非 ASCII 标题一个不丢
    expect(box.value).toContain('  -\n');
    expect(box.value).toContain('[[呼吸性酸中毒]]');
    expect(box.value).toContain('    - 与 Hb 结合');
    // 视图偏好按笔记落盘（键 = 笔记路径）
    expect(prefs()).toEqual({ [NOTE_PATH]: { view: 'outline' } });

    // 可编辑：改层级、加一行、清空一个节点都直接写进文本框
    fireEvent.change(box, {
      target: { value: '# 波尔效应\n- 机制\n  - 二氧化碳升高\n  -\n    - 体温升高\n- [[呼吸性酸中毒]]\n' },
    });
    expect((screen.getByLabelText('导图大纲文本') as HTMLTextAreaElement).value).toContain('    - 体温升高');
  });

  it('保存走 parseOutline → treeToMd：frontmatter 原样拼回、缩进规范化、空节点保留', async () => {
    const utils = renderMap();
    const box = await toOutline();
    // 输入用 4 空格缩进 + `*` 记号：保存时一律规范成 treeToMd 的形状
    fireEvent.change(box, {
      target: { value: '# 波尔效应\n- 机制\n    * 二氧化碳升高\n  -\n- [[呼吸性酸中毒]]\n' },
    });
    fireEvent.click(screen.getByText('保存并写回笔记'));

    const want = ['# 波尔效应', '- 机制', '  - 二氧化碳升高', '  -', '- [[呼吸性酸中毒]]', ''].join('\n');
    expect(utils.onSaveNote).toHaveBeenCalledTimes(1);
    expect(utils.onSaveNote.mock.calls[0][0]).toBe(FM + want);
    // 保存后文本框同步成刚写回的那份（否则用户会以为没保存）
    expect((screen.getByLabelText('导图大纲文本') as HTMLTextAreaElement).value).toBe(want);
  });

  it('非标题/列表行在保存时被丢弃——这是导图视图本来就有的规则，大纲视图不另立一套', async () => {
    const utils = renderMap();
    await toOutline();
    fireEvent.click(screen.getByText('保存并写回笔记'));
    const md = utils.onSaveNote.mock.calls[0][0] as string;
    expect(md).toBe(FM + OUTLINE);
    expect(md).not.toContain('pH 降低时氧解离曲线右移。');
  });

  it('大纲里改的字会带进导图实例，来回切换都不丢', async () => {
    const utils = renderMap();
    const box = await toOutline();
    fireEvent.change(box, { target: { value: '# 波尔效应\n- 新加的节点\n' } });

    // 切回导图：实例用大纲文本重建（不是回到笔记正文）
    fireEvent.click(screen.getByText('导图视图'));
    expect(screen.getByText('布局')).toBeTruthy();
    await waitMap(utils.container);
    expect(topics(utils.container)).toEqual(expect.arrayContaining(['波尔效应', '新加的节点']));

    expect((await toOutline()).value).toBe('# 波尔效应\n- 新加的节点\n');
    expect(prefs()).toEqual({ [NOTE_PATH]: { view: 'outline' } });
  });
});

describe('思维导图 · 既有联动没被改坏', () => {
  it('导图视图保存仍走 getData → mindToMd（与改动前同一条链路）', async () => {
    const utils = renderMap();
    await waitMap(utils.container);
    fireEvent.click(screen.getByText('保存并写回笔记'));
    expect(utils.onSaveNote.mock.calls[0][0]).toBe(FM + OUTLINE);
  });

  it('点击 [[双链]] 节点仍然跳转对应笔记', async () => {
    // 专门的短笔记：[[双链]] 自己是**一级分支**（既有实现的截取范围是 .me-main 这个分支组，
    // 点到更深处的节点会解析成该分支的第一条主题——见报告里的「既有实现边界」，本轮没动那段逻辑）
    const utils = renderMap({ content: '# 索引\n\n- [[呼吸性酸中毒]]\n- 别的条目\n' });
    await waitMap(utils.container);
    const link = [...utils.container.querySelectorAll('.me-tpc')].find((e) =>
      (e.textContent ?? '').includes('[[呼吸性酸中毒]]')
    )!;
    fireEvent.click(link);
    expect(utils.onOpenWiki).toHaveBeenCalledWith('呼吸性酸中毒');
  });

  it('按笔记隔离：另一篇笔记打开时用各自的偏好，且不改动上一篇的存储', async () => {
    const first = renderMap();
    fireEvent.click(screen.getByText('护眼绿'));
    fireEvent.click(screen.getByText('左向展开'));
    expect(prefs()).toEqual({ [NOTE_PATH]: { theme: 'eye', direction: 'left' } });
    cleanup();

    renderMap({ noteKey: '01-生理学/呼吸/氧解离曲线.md', title: '氧解离曲线' });
    expect(screen.getByText('护眼绿').className).not.toContain('on');
    expect(screen.getByText('双向展开').className).toContain('on');
    expect(prefs()[NOTE_PATH]).toEqual({ theme: 'eye', direction: 'left' });
    expect(first.onSaveNote).not.toHaveBeenCalled();
  });
});

describe('思维导图 · 双链跳转（回归）', () => {
  /**
   * 回归：点击处理原先先 `closest('.me-main')` 再 `querySelector('.me-tpc')`。
   * 但整条分支的分组容器也带 `.me-main`（`.me-main.lhs/.rhs/.down`），于是拿到的是该分支的
   * **第一条**主题 —— 深层节点里的 [[双链]] 点了要么不跳、要么跳到同分支第一条的笔记。
   * 上面那条用例只覆盖一级列表项，正好落在这个盲区之外，所以这里专门钉深层节点。
   */
  it('深层（二级）节点的 [[双链]] 也能跳转', async () => {
    const utils = renderMap({ content: '# 索引\n\n- 一级条目\n  - 深层条目（[[呼吸性酸中毒]]）\n' });
    await waitMap(utils.container);

    const deep = [...utils.container.querySelectorAll('.me-tpc')].find((e) =>
      (e.textContent ?? '').includes('[[呼吸性酸中毒]]')
    );
    expect(deep).toBeTruthy();

    fireEvent.click(deep!);
    expect(utils.onOpenWiki).toHaveBeenCalledWith('呼吸性酸中毒');
  });
});

/* ============================================================ 本轮新增（画布可拖拽 / 节点操作 / 插入 / 查找替换）
   与上面的用例同一套环境缺口说明：jsdom 没有布局引擎，节点几何、指针捕获的真实行为都测不了，
   所以「拖空白真的平移了」用**实例方法被调用**来钉（spy 在 MindElixir.prototype 上），
   「落到节点上的拖动不被我们抢走」用「平移方法没被调用」来钉——这两条正是本轮的验收点。 */
const nodeEl = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('.me-tpc')].find((e) => (e.textContent ?? '').trim() === text) as HTMLElement;
/**
 * 工具栏按钮：按文案取，但只认 <button>。
 * 为什么不能直接 getByText：库自带的（隐藏的）右键菜单里也有同名项（例如「概要」），
 * 直接按文本取会命中两个元素。
 */
const toolBtn = (label: string) =>
  [...screen.getAllByText(label)].find((e) => e.tagName === 'BUTTON') as HTMLButtonElement;

describe('思维导图 · 画布可拖拽 / 可缩放', () => {
  it('左键拖空白处平移画布；落在节点上的拖动不抢（拖节点换父级照旧走库）', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const move = vi.spyOn(MindElixir.prototype, 'move').mockImplementation(() => true);
    const wrapper = container.querySelector('.mindmap-elixir') as HTMLElement;
    const blank = container.querySelector('.map-container') as HTMLElement;

    fireEvent.pointerDown(blank, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    expect(wrapper.className).toContain('mm-panning'); // 抓手指针的钩子
    fireEvent.pointerMove(window, { clientX: 40, clientY: 25, pointerId: 1 });
    expect(move).toHaveBeenCalledWith(30, 15, false);
    fireEvent.pointerUp(window, { clientX: 40, clientY: 25, pointerId: 1 });
    expect(wrapper.className).not.toContain('mm-panning');

    // 节点上按下：我们直接放行，库自己的「拖动节点换父级」逻辑才接得到
    move.mockClear();
    fireEvent.pointerDown(nodeEl(container, '机制'), { button: 0, clientX: 10, clientY: 10, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 25, pointerId: 2 });
    // 不接管：容器不进平移态。（不能拿 move 当判据——库拖动节点时自己也会调 move）
    expect(wrapper.className).not.toContain('mm-panning');
    move.mockRestore();
  });

  it('连线的文字标签算「可点元素」：按在它上面不接管平移（否则库的双击改字收不到事件）', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const move = vi.spyOn(MindElixir.prototype, 'move').mockImplementation(() => true);
    const wrapper = container.querySelector('.mindmap-elixir') as HTMLElement;

    // 造一个与库同构的标签：.label-container > .svg-label（库的 CSS 里 .svg-label 是 pointer-events: auto）
    const box = document.createElement('div');
    box.className = 'label-container';
    const label = document.createElement('div');
    label.className = 'svg-label';
    label.textContent = '因为';
    box.appendChild(label);
    wrapper.appendChild(box);

    fireEvent.pointerDown(label, { button: 0, clientX: 10, clientY: 10, pointerId: 7 });
    expect(wrapper.className).not.toContain('mm-panning');
    fireEvent.pointerMove(window, { clientX: 40, clientY: 25, pointerId: 7 });
    expect(move).not.toHaveBeenCalled();

    move.mockRestore();
  });

  it('缩放：± 走库的 scale、读数跟着走；适应 / 居中 各调库自己的方法', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const scale = vi.spyOn(MindElixir.prototype, 'scale').mockImplementation(() => {});
    const fit = vi.spyOn(MindElixir.prototype, 'scaleFit').mockImplementation(() => {});
    const center = vi.spyOn(MindElixir.prototype, 'toCenter').mockImplementation(() => {});

    // 读数按钮显示当前倍数（默认 100%），点它回 100%
    const readout = screen.getByText('100%');
    fireEvent.click(readout);
    expect(scale).toHaveBeenCalledWith(1);

    scale.mockClear();
    fireEvent.click(screen.getByLabelText('放大'));
    expect(scale).toHaveBeenCalledWith(1.25); // ZOOM_STEP
    fireEvent.click(screen.getByLabelText('缩小'));
    expect(scale).toHaveBeenLastCalledWith(0.8); // 1 ÷ ZOOM_STEP，且夹在 0.3 ~ 3 内

    fireEvent.click(screen.getByText('适应'));
    expect(fit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('居中'));
    expect(center).toHaveBeenCalledTimes(1);

    scale.mockRestore();
    fit.mockRestore();
    center.mockRestore();
  });

  it('滚轮 = 缩放：以指针为锚点调库的 scale 并吞掉事件；Shift+滚轮仍是横向平移', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const scale = vi.spyOn(MindElixir.prototype, 'scale').mockImplementation(() => {});
    const move = vi.spyOn(MindElixir.prototype, 'move').mockImplementation(() => true);
    const canvas = container.querySelector('.map-container') as HTMLElement;
    const lastScale = () => (scale.mock.calls[0] as unknown as [number])[0];

    // 向下滚 = 缩小。fireEvent 返回 false 正说明我们 preventDefault 了（页面不会跟着滚）
    expect(fireEvent.wheel(canvas, { deltaY: 100, deltaMode: 0, clientX: 60, clientY: 40 })).toBe(false);
    expect(scale).toHaveBeenCalledTimes(1);
    const [v, anchor] = scale.mock.calls[0] as unknown as [number, { x: number; y: number }];
    expect(v).toBeLessThan(1);
    expect(v).toBeGreaterThan(0.8); // 一格约 12%，不是「一格跳一档」
    // 锚点必须是鼠标位置：库的 scale(v, {x,y}) 以该点为不动点，否则缩放在画布角落「飘」
    expect(anchor).toEqual({ x: 60, y: 40 });

    // 向上滚 = 放大（方向不能反）
    scale.mockClear();
    fireEvent.wheel(canvas, { deltaY: -100, deltaMode: 0, clientX: 10, clientY: 10 });
    expect(lastScale()).toBeGreaterThan(1);

    // 夹上下限：库的 scale() 自己不夹，极端 delta 也只能到 0.3 / 3
    scale.mockClear();
    fireEvent.wheel(canvas, { deltaY: 1e6, deltaMode: 0, clientX: 5, clientY: 5 });
    expect(lastScale()).toBe(0.3);
    scale.mockClear();
    fireEvent.wheel(canvas, { deltaY: -1e6, deltaMode: 0, clientX: 5, clientY: 5 });
    expect(lastScale()).toBe(3);

    // Shift+滚轮 = 横向平移：不缩放，走库的 move（导图很宽时这条比缩放常用）
    scale.mockClear();
    fireEvent.wheel(canvas, { deltaY: 100, deltaMode: 0, shiftKey: true, clientX: 5, clientY: 5 });
    expect(scale).not.toHaveBeenCalled();
    expect(move).toHaveBeenCalledWith(-100, 0);

    move.mockRestore();
    scale.mockRestore();
  });
});

describe('思维导图 · 节点操作按钮', () => {
  it('没选中节点时按钮禁用且点了不动作；选中后逐个按钮落到库对应方法上', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const ops = {
      sibling: vi.spyOn(MindElixir.prototype, 'insertSibling').mockResolvedValue(undefined),
      child: vi.spyOn(MindElixir.prototype, 'addChild').mockResolvedValue(undefined),
      parent: vi.spyOn(MindElixir.prototype, 'insertParent').mockResolvedValue(undefined),
      remove: vi.spyOn(MindElixir.prototype, 'removeNodes').mockResolvedValue(undefined),
    };

    // 还没选中：四个动作按钮都是禁用的（点了不会有反应，所以也不会调用库）
    const btn = (label: string) => screen.getByText(label) as HTMLButtonElement;
    for (const label of ['同级', '子级', '上级', '删除']) {
      expect(btn(label).disabled).toBe(true);
      fireEvent.click(btn(label));
    }
    expect(ops.child).not.toHaveBeenCalled();

    // 选中「机制」这一支：按钮解禁（选中数的同步见组件里的 click 监听）
    fireEvent.pointerDown(nodeEl(container, '机制'), { button: 0, pointerId: 3 });
    fireEvent.click(nodeEl(container, '机制'));
    await waitFor(() => expect(btn('子级').disabled).toBe(false));

    fireEvent.click(btn('子级'));
    fireEvent.click(btn('同级'));
    fireEvent.click(btn('上级'));
    fireEvent.click(btn('删除'));
    fireEvent.click(btn('撤销'));
    expect(ops.child).toHaveBeenCalledTimes(1);
    expect(ops.sibling).toHaveBeenCalledWith('after');
    expect(ops.parent).toHaveBeenCalledTimes(1);
    expect(ops.remove).toHaveBeenCalledTimes(1);
    // 「撤销」不在这里断言：库把它挂在实例上（不是原型方法），间接断言留给真机点一下

    for (const op of Object.values(ops)) op.mockRestore();
  });
});

describe('思维导图 · 关系线与概要', () => {
  it('关系线：进入两步模式后点起点 + 终点 → createArrow；再点按钮可取消', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const arrow = vi.spyOn(MindElixir.prototype, 'createArrow').mockImplementation(() => {});

    fireEvent.click(screen.getByText('关系线'));
    expect(screen.getByRole('status').textContent).toContain('点一个节点作为起点');

    fireEvent.click(nodeEl(container, '机制'));
    expect(screen.getByRole('status').textContent).toContain('再点终点节点完成连线');
    fireEvent.click(nodeEl(container, '表现'));
    expect(arrow).toHaveBeenCalledTimes(1);
    // 连完自动退出模式（提示条消失）
    expect(screen.queryByRole('status')).toBeNull();

    // 再点一次按钮＝取消，不产生关系线
    fireEvent.click(screen.getByText('关系线'));
    fireEvent.click(screen.getByText('关系线'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(arrow).toHaveBeenCalledTimes(1);
    arrow.mockRestore();
  });

  it('概要：选中不足两个节点时给提示不调用；选中两个同级节点后调用库的 createSummary', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const summary = vi.spyOn(MindElixir.prototype, 'createSummary').mockImplementation(() => {});

    fireEvent.click(toolBtn('概要'));
    expect(summary).not.toHaveBeenCalled();

    // 选中两条同级主分支（机制 / 表现）
    const a = nodeEl(container, '机制');
    const b = nodeEl(container, '表现');
    fireEvent.pointerDown(a, { button: 0, ctrlKey: true, pointerId: 4 });
    fireEvent.click(a);
    fireEvent.pointerDown(b, { button: 0, ctrlKey: true, pointerId: 5 });
    fireEvent.click(b);
    await waitFor(() => expect(toolBtn('概要').disabled).toBe(false));

    fireEvent.click(toolBtn('概要'));
    expect(summary).toHaveBeenCalledTimes(1);
    summary.mockRestore();
  });
});

describe('思维导图 · 查找替换', () => {
  it('命中计数对得上；全部替换真的改掉节点文字，并重算剩余命中', async () => {
    const { container } = renderMap({ content: '# 索引\n\n- 甲术语\n- 乙术语\n- 丙\n' });
    await waitMap(container);

    fireEvent.click(screen.getByText('查找替换'));
    expect(screen.getByTestId('mm-find-count').textContent).toBe('输入要查找的文字');

    fireEvent.change(screen.getByLabelText('查找'), { target: { value: '术语' } });
    await waitFor(() => expect(screen.getByTestId('mm-find-count').textContent).toBe('第 1 / 2 处'));

    fireEvent.change(screen.getByLabelText('替换为'), { target: { value: '名词' } });
    fireEvent.click(screen.getByText('全部替换'));

    await waitFor(() => expect(topics(container)).toEqual(expect.arrayContaining(['甲名词', '乙名词'])));
    await waitFor(() => expect(screen.getByTestId('mm-find-count').textContent).toBe('没有匹配的节点'));
    // 查找替换只改节点文字：没有匹配的节点仍然原样在图上
    expect(topics(container)).toContain('丙');
  });

  it('替换单个：只改当前那一处，剩下的继续躺在命中里', async () => {
    const { container } = renderMap({ content: '# 索引\n\n- 甲术语\n- 乙术语\n- 丙\n' });
    await waitMap(container);

    fireEvent.click(screen.getByText('查找替换'));
    fireEvent.change(screen.getByLabelText('查找'), { target: { value: '术语' } });
    fireEvent.change(screen.getByLabelText('替换为'), { target: { value: '名词' } });
    await waitFor(() => expect(screen.getByTestId('mm-find-count').textContent).toBe('第 1 / 2 处'));

    fireEvent.click(screen.getByText('替换'));
    await waitFor(() => expect(topics(container)).toContain('甲名词'));
    expect(topics(container)).toContain('乙术语'); // 第二处没被动
    expect(screen.getByTestId('mm-find-count').textContent).toBe('第 1 / 1 处');
  });
});

describe('思维导图 · 连线样式（与方向正交的第二轴）', () => {
  it('选「直角」把直角折线生成器交给实例；切回「曲线」时交回库默认（不给生成器）', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const change = vi.spyOn(MindElixir.prototype, 'changeTheme');
    /** changeTheme 收到的主题对象：库就是按它决定用不用我们自己的连线生成器 */
    const lastTheme = () => change.mock.calls.at(-1)?.[0] as unknown as { generateMainBranch?: unknown };

    expect(prefs()).toEqual({}); // 默认不写偏好（观感与改动前一致）
    fireEvent.click(screen.getByText('直角'));
    expect(typeof lastTheme().generateMainBranch).toBe('function');
    expect(prefs()).toEqual({ [NOTE_PATH]: { line: 'ortho' } });

    fireEvent.click(screen.getByText('曲线'));
    expect(lastTheme().generateMainBranch).toBeUndefined();
    expect(prefs()).toEqual({ [NOTE_PATH]: { line: 'curve' } });

    // 换连线形状不碰内容：节点文字照旧
    expect(topics(container)).toContain('机制');
    change.mockRestore();
  });

  it('直角连线真的画成折线（d 里出现 H…V），与曲线的贝塞尔不是同一串', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const mainD = () => (container.querySelector('.lines path') as SVGPathElement | null)?.getAttribute('d') ?? '';

    const curved = mainD();
    fireEvent.click(screen.getByText('直角'));
    const ortho = mainD();
    // jsdom 没有布局引擎（节点尺寸恒为 0），所以这里只钉「指令形状」；
    // 具体拐点坐标由 core/__tests__/mindmapStyles.test.ts 用真实几何逐字钉住。
    expect(ortho).toMatch(/H[\s\d.-]*V/);
    expect(ortho).not.toBe(curved);
  });
});

describe('思维导图 · 标题编号（显示层，不动内容）', () => {
  it('选方案 → 容器挂 mm-num 与三层 CSS 变量；清除编号 → 回到原样，节点文字全程不变', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const box = () => container.querySelector('.mindmap-elixir') as HTMLElement;
    const before = topics(container);

    expect(box().className).not.toContain('mm-num');
    fireEvent.change(screen.getByLabelText('标题编号'), { target: { value: 'cn-dot' } });
    expect(box().className).toContain('mm-num');
    expect(box().style.getPropertyValue('--mm-num1')).toContain('cjk-ideographic');
    expect(box().style.getPropertyValue('--mm-num3')).toContain('counter(mml3');
    expect(prefs()).toEqual({ [NOTE_PATH]: { numbering: 'cn-dot' } });

    // 编号是 ::before 画的：节点数据/文字一个字都没被动（保存回笔记也不会变字节）
    expect(topics(container)).toEqual(before);

    fireEvent.change(screen.getByLabelText('标题编号'), { target: { value: 'none' } });
    expect(box().className).not.toContain('mm-num');
    expect(box().style.getPropertyValue('--mm-num1')).toBe('');
    expect(prefs()).toEqual({ [NOTE_PATH]: { numbering: 'none' } });
  });

  it('编号与连线两轴互不干扰：改了编号不会把连线样式重置', async () => {
    renderMap();
    fireEvent.click(screen.getByText('直角'));
    fireEvent.change(screen.getByLabelText('标题编号'), { target: { value: 'paren' } });
    expect(prefs()).toEqual({ [NOTE_PATH]: { line: 'ortho', numbering: 'paren' } });
    // 下拉里选中的就是刚存的那一项
    expect((screen.getByLabelText('标题编号') as HTMLSelectElement).value).toBe('paren');
  });
});

describe('思维导图 · 节点格式（字体 / 形状 / 颜色）', () => {
  const storedStyles = () =>
    JSON.parse(localStorage.getItem(NODE_STYLE_KEY) ?? '{}') as Record<string, Record<string, Record<string, string>>>;
  /** 选中一个节点（库在 pointerdown 里做选中，click 让我们的监听更新按钮可用性） */
  const select = async (container: HTMLElement, text: string, pointerId: number) => {
    const tpc = nodeEl(container, text);
    fireEvent.pointerDown(tpc, { button: 0, pointerId });
    fireEvent.click(tpc);
    await waitFor(() => expect((screen.getByLabelText('粗体') as HTMLButtonElement).disabled).toBe(false));
    return tpc;
  };

  it('设粗体：节点行内样式真的变粗、按文本路径存进存储、按钮高亮', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const tpc = await select(container, '机制', 21);

    fireEvent.click(screen.getByLabelText('粗体'));
    await waitFor(() => expect(tpc.style.fontWeight).toBe('bold'));

    const perNode = storedStyles()[NOTE_PATH] ?? {};
    const keys = Object.keys(perNode);
    expect(keys).toHaveLength(1);
    // 键 = 祖先主题 + 自己（文本路径），不是会漂移的下标
    expect(keys[0].endsWith('\u0000机制')).toBe(true);
    expect(perNode[keys[0]]).toEqual({ fontWeight: 'bold' });
    expect((screen.getByLabelText('粗体') as HTMLButtonElement).className).toContain('on');

    // 再点一次 = 取消该项：存储里这一项被清掉，元素上的粗体也撤掉
    fireEvent.click(screen.getByLabelText('粗体'));
    await waitFor(() => expect(tpc.style.fontWeight).toBe(''));
    expect(storedStyles()[NOTE_PATH]).toBeUndefined();
  });

  it('重开这篇笔记时样式贴回（初始化就把存下来的 style 写进节点数据）', async () => {
    const first = renderMap();
    await waitMap(first.container);
    await select(first.container, '机制', 22);
    fireEvent.click(screen.getByLabelText('粗体'));
    await waitFor(() => expect(nodeEl(first.container, '机制').style.fontWeight).toBe('bold'));
    // 顺带设一个字号，验证「逐项合并」而不是整体覆盖
    fireEvent.change(screen.getByLabelText('字号'), { target: { value: '20' } });
    await waitFor(() => expect(nodeEl(first.container, '机制').style.fontSize).toBe('20px'));
    cleanup();

    const again = renderMap();
    await waitMap(again.container);
    expect(nodeEl(again.container, '机制').style.fontWeight).toBe('bold');
    expect(nodeEl(again.container, '机制').style.fontSize).toBe('20px');
    // 没设过格式的节点保持主题默认（一个内联样式都不写）
    expect(nodeEl(again.container, '表现').style.fontWeight).toBe('');
  });
});

describe('思维导图 · 重复按钮已清理（库自带图标条 vs 我们的工具栏）', () => {
  it('画布上不再出现库自带的两条图标工具条；我们的「布局」组与补进来的「全屏」都在', async () => {
    const { container } = renderMap();
    await waitMap(container);

    // 库的 .mind-elixir-toolbar：左上角三个方向图标 + 右下角四个缩放/全屏图标，已关掉（toolBar: false）
    expect(container.querySelector('.mind-elixir-toolbar')).toBeNull();

    // 方向照旧由我们的「布局」组给——库那三个图标**没有「纵向」**，所以不能反过来删我们的
    for (const label of ['双向展开', '大纲向右', '纵向 · 组织结构', '左向展开']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // 库独有的「全屏」补进了「画布」组，功能没少
    expect(screen.getByText('全屏')).toBeTruthy();
    expect(screen.getByText('适应')).toBeTruthy();
    expect(screen.getByText('居中')).toBeTruthy();
  });
});

describe('思维导图 · 关系线文字', () => {
  it('画完关系线立刻打开标签输入（用库的 currentArrow，不自己拼 DOM id）', async () => {
    const { container } = renderMap();
    await waitMap(container);

    // 假实现照库的行为来：push 进 arrows + 把新箭头挂到 currentArrow 上。
    // 注意箭头 <g> 的 DOM id 是 `"a-" + arrow.id`（库源码 `C = "a-" + r.id`），
    // 所以「拿 arrow.id 去 getElementById」必然取不到——这正是「画完写不了文字」的第一个原因。
    const fakeArrow = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    fakeArrow.id = 'a-arrow-test-1';
    const arrow = vi.spyOn(MindElixir.prototype, 'createArrow').mockImplementation(function (
      this: { arrows: Array<{ id: string }>; currentArrow: SVGGElement | null },
    ) {
      this.arrows.push({ id: 'arrow-test-1' });
      this.currentArrow = fakeArrow;
    });
    const edit = vi.spyOn(MindElixir.prototype, 'editArrowLabel').mockImplementation(() => {});

    fireEvent.click(screen.getByText('关系线'));
    fireEvent.click(nodeEl(container, '机制'));
    fireEvent.click(nodeEl(container, '表现'));

    expect(arrow).toHaveBeenCalledTimes(1);
    // 输入框直接打开（就在新建的那条上）：不必让用户去猜「选中后按 F2」
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0][0]).toBe(fakeArrow);
    // 屏幕上的提示也说明了这件事（双击关系线/F2）
    expect(screen.getByText(/双击关系线/)).toBeTruthy();

    arrow.mockRestore();
    edit.mockRestore();
  });
});

describe('思维导图 · 关系线与概要落盘', () => {
  const ROOT = '波尔效应';
  const stored = () => JSON.parse(localStorage.getItem(MARK_KEY) ?? '{}') as Record<string, { arrows?: unknown[] }>;

  it('画完关系线：立刻按两端节点的**文本路径**存下来（笔记正文一个字节不动）', async () => {
    const { container } = renderMap();
    await waitMap(container);

    // 假实现：按库的规矩 push 箭头 + 发 operation 事件（订阅者据此落盘）
    const arrow = vi.spyOn(MindElixir.prototype, 'createArrow').mockImplementation(function (
      this: {
        arrows: Array<{ id: string; label: string; from: string; to: string }>;
        bus: { fire: (name: string, payload: unknown) => void };
      },
      from: { nodeObj: { id: string } },
      to: { nodeObj: { id: string } },
    ) {
      this.arrows.push({ id: 'arrow-1', label: '', from: from.nodeObj.id, to: to.nodeObj.id });
      this.bus.fire('operation', { name: 'createArrow', target: { id: 'arrow-1' } });
    });
    const edit = vi.spyOn(MindElixir.prototype, 'editArrowLabel').mockImplementation(() => {});

    fireEvent.click(screen.getByText('关系线'));
    fireEvent.click(nodeEl(container, '机制'));
    fireEvent.click(nodeEl(container, '表现'));

    expect(stored()[NOTE_PATH].arrows).toEqual([
      { from: `${ROOT}\u0000机制`, to: `${ROOT}\u0000表现` },
    ]);

    arrow.mockRestore();
    edit.mockRestore();
  });

  it('重新打开这篇笔记：存的线按文本路径还原成库的节点 id 重建，文字一起回来', async () => {
    localStorage.setItem(
      MARK_KEY,
      JSON.stringify({
        [NOTE_PATH]: { arrows: [{ from: `${ROOT}\u0000机制`, to: `${ROOT}\u0000表现`, label: '因为' }] },
      }),
    );
    const rebuild = vi.spyOn(MindElixir.prototype, 'createArrowFrom');
    const { container } = renderMap();
    await waitMap(container);

    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    const arg = rebuild.mock.calls[0][0] as unknown as { from: string; to: string; label?: string };
    // 两端是库的节点 id：与画布上真实节点的 data-nodeid 对得上（说明路径确实解析到了那两个节点）
    const ids = [...container.querySelectorAll('.me-tpc')].map((el) => (el as HTMLElement).dataset.nodeid);
    expect(ids).toContain(`me${arg.from}`);
    expect(ids).toContain(`me${arg.to}`);
    expect(arg.label).toBe('因为');
    rebuild.mockRestore();
  });

  it('端点节点已经不存在时：那条线不画（不猜别的节点、也不报错）', async () => {
    localStorage.setItem(
      MARK_KEY,
      JSON.stringify({ [NOTE_PATH]: { arrows: [{ from: `波尔效应\u0000早就删掉的节点`, to: `${ROOT}\u0000表现` }] } }),
    );
    const rebuild = vi.spyOn(MindElixir.prototype, 'createArrowFrom');
    const { container } = renderMap();
    await waitMap(container);
    // 多等一拍：重建是在 init() 的 then 里跑的
    await waitFor(() => expect(container.querySelectorAll('.me-tpc').length).toBeGreaterThan(0));
    expect(rebuild).not.toHaveBeenCalled();
    rebuild.mockRestore();
  });
});

describe('思维导图 · 工具条收纳', () => {
  const TOOLS_KEY = 'knowlattice-mindmap-tools';
  const toggleOf = (container: HTMLElement) => container.querySelector('.mindmap-tools-toggle') as HTMLButtonElement;
  /** 节点身份（库给每个 .me-tpc 打的 data-nodeid）：用它判断实例有没有被重建 */
  const nodeIds = (container: HTMLElement) =>
    [...container.querySelectorAll('.me-tpc')].map((el) => (el as HTMLElement).dataset.nodeid);

  it('默认展开；收起后两条工具条离开 DOM，画布与节点一个不少，笔记内容不动', async () => {
    const { container } = renderMap();
    await waitMap(container);

    // 默认 = 展开（与加入本功能之前一模一样），且不往存储里写东西
    expect(toggleOf(container).getAttribute('aria-expanded')).toBe('true');
    expect(toggleOf(container).textContent).toContain('收起');
    expect(screen.getByText('适应')).toBeTruthy();
    expect(screen.getByText('格式')).toBeTruthy();
    expect(localStorage.getItem(TOOLS_KEY)).toBeNull();

    const before = nodeIds(container);
    expect(before.length).toBeGreaterThan(0);

    // jsdom 的 fireEvent.click 不会自动聚焦，先手动聚焦，才能验证「收起重排后焦点不丢」
    toggleOf(container).focus();
    fireEvent.click(toggleOf(container));

    // 收起：两条工具条**不在 DOM 里**（不是 CSS 藏起来——隐藏的按钮还会留在 Tab 顺序里）
    expect(toggleOf(container).getAttribute('aria-expanded')).toBe('false');
    expect(toggleOf(container).textContent).toContain('展开');
    expect(container.querySelector('#mm-tools')).toBeNull();
    expect(container.querySelector('#mm-tools-format')).toBeNull();
    expect(screen.queryByText('适应')).toBeNull();
    expect(screen.queryByText('格式')).toBeNull();

    // 收起不碰实例与数据：画布还在，节点身份逐个相同
    expect(container.querySelector('.map-container')).toBeTruthy();
    expect(nodeIds(container)).toEqual(before);
    // 焦点留在细条上（否则接着按 Tab 会从页面开头重新走一遍）
    expect(document.activeElement).toBe(toggleOf(container));
    // 偏好落盘：下次打开还是收起的
    expect(localStorage.getItem(TOOLS_KEY)).toBe('0');

    // 笔记内容一个字没变（这一个动作会切到大纲视图，所以放在最后）
    expect((await toOutline()).value).toBe(OUTLINE);
  });

  it('收起状态下照常做笔记：库自己的 Tab（加子级）仍然生效——这条路径不经过工具条', async () => {
    const { container } = renderMap();
    await waitMap(container);
    const child = vi.spyOn(MindElixir.prototype, 'addChild').mockResolvedValue(undefined);

    fireEvent.click(toggleOf(container));
    expect(container.querySelector('#mm-tools')).toBeNull(); // 工具条确实收起来了

    // 选中「机制」再按 Tab：keydown 由库挂在 .map-container 上（container.onkeydown），
    // 与我们的工具条无关，所以收起后必须照样能加子级
    fireEvent.pointerDown(nodeEl(container, '机制'), { button: 0, pointerId: 9 });
    fireEvent.click(nodeEl(container, '机制'));
    fireEvent.keyDown(container.querySelector('.map-container') as HTMLElement, { key: 'Tab' });
    expect(child).toHaveBeenCalledTimes(1);

    child.mockRestore();
  });

  it('再展开：工具条回来且节点没被重建；收起状态被记住（重新打开仍是收起）', async () => {
    const first = renderMap();
    await waitMap(first.container);
    const before = nodeIds(first.container);

    fireEvent.click(toggleOf(first.container));
    fireEvent.click(toggleOf(first.container));
    expect(toggleOf(first.container).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('适应')).toBeTruthy();
    // 收起/展开前后节点身份相同 → 不重建实例（编辑内容与撤销栈都留着）
    expect(nodeIds(first.container)).toEqual(before);

    // 记住：再收起一次 → 重新挂载（等价于下次打开这篇导图）→ 一开始就是收起的
    fireEvent.click(toggleOf(first.container));
    expect(localStorage.getItem(TOOLS_KEY)).toBe('0');
    cleanup();
    const second = renderMap();
    await waitMap(second.container);
    expect(toggleOf(second.container).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('适应')).toBeNull();
    expect(second.container.querySelector('.map-container')).toBeTruthy();
  });
});

describe('思维导图 · 问 AI（AI 改写 / 改写这支 / 标签总结）', () => {
  it('没传 onAskAi 的调用点：三个入口都不渲染（不新增第二条 AI 通道）', async () => {
    const { container } = renderMap();
    await waitMap(container);
    expect(screen.queryByText('AI 改写')).toBeNull();
    expect(screen.queryByText('改写这支')).toBeNull();
    expect(screen.queryByText('标签总结')).toBeNull();
  });

  it('「AI 改写」：把整张导图的大纲文本 + 这篇笔记的路径交给面板，要求写明「先 diff、写回同一篇」', async () => {
    const onAskAi = vi.fn();
    const utils = renderMap({ onAskAi });
    await waitMap(utils.container);

    fireEvent.click(toolBtn('AI 改写'));

    expect(onAskAi).toHaveBeenCalledTimes(1);
    const quote = onAskAi.mock.calls[0][0] as { text: string; path: string | null; ask?: string };
    expect(quote.path).toBe(NOTE_PATH); // 面板据此把改动写回**这篇**笔记
    expect(quote.text).toBe(OUTLINE); // 送的是大纲文本（与大纲视图里那份同源）
    expect(quote.ask).toContain('propose_note_patch');
    expect(quote.ask).toContain('frontmatter'); // 硬边界写在要求里，不指望模型自觉
    // 只把引用交出去就停手：导图自己不写笔记（写回要用户在面板里点「应用」）
    expect(utils.onSaveNote).not.toHaveBeenCalled();
    // 提示条要说清「写回后导图会跟着刷新」，否则用户会以为导图坏了（toast 挂在 body 上，
    // 所以按文案找而不是取第一个 .mv-toast——前面用例的提示条可能还没消失）
    const toasts = [...document.querySelectorAll('.mv-toast')].map((e) => e.textContent ?? '');
    expect(toasts.some((t) => t.includes('已交给 AI 面板'))).toBe(true);
  });

  it('「标签总结」：要求指向 frontmatter 的 tags、正文一个字不改，走的是同一个引用通道', async () => {
    const onAskAi = vi.fn();
    const { container } = renderMap({ onAskAi });
    await waitMap(container);

    fireEvent.click(toolBtn('标签总结'));
    const quote = onAskAi.mock.calls[0][0] as { text: string; path: string | null; ask?: string };
    expect(quote.path).toBe(NOTE_PATH);
    expect(quote.ask).toContain('tags:');
    expect(quote.ask).toContain('正文一个字都不要改');
    expect(quote.text).toBe(OUTLINE); // 要判断讲的是什么，所以整张大纲一起给
  });

  it('「改写这支」：没选中时禁用；选中「机制」后只把这一支送出去，要求里点名该节点', async () => {
    const onAskAi = vi.fn();
    const { container } = renderMap({ onAskAi });
    await waitMap(container);

    expect(toolBtn('改写这支').disabled).toBe(true);

    fireEvent.pointerDown(nodeEl(container, '机制'), { button: 0, pointerId: 11 });
    fireEvent.click(nodeEl(container, '机制'));
    await waitFor(() => expect(toolBtn('改写这支').disabled).toBe(false));

    fireEvent.click(toolBtn('改写这支'));

    expect(onAskAi).toHaveBeenCalledTimes(1);
    const quote = onAskAi.mock.calls[0][0] as { text: string; path: string | null; ask?: string };
    expect(quote.ask).toContain('机制'); // 点名是哪一支，模型不用猜
    expect(quote.text).toContain('二氧化碳升高'); // 子树内容在里面
    expect(quote.text).not.toContain('发绀'); // 别的分支不在里面（送的不是整篇）
    expect(quote.text).not.toBe(OUTLINE);
  });
});

describe('思维导图 · 节点改名后关系线/概要不再失联', () => {
  const stored = () => JSON.parse(localStorage.getItem(MARK_KEY) ?? '{}') as Record<string, { arrows?: unknown[] }>;

  it('改了节点文字：关系线两端按新文字路径搬过去（存的是路径，改名不能让它静静地不画）', async () => {
    localStorage.setItem(
      MARK_KEY,
      JSON.stringify({ [NOTE_PATH]: { arrows: [{ from: '波尔效应\u0000机制', to: '波尔效应\u0000表现' }] } }),
    );
    /*
     * 拿实例：视图唯一碰实例的入口就是 init，这里只借它的 this 记住实例，原实现照常调用
     * （不改被测代码、也不改库行为）。随后用库自己的 operation 事件驱动 finishEdit ——
     * 与真机上「双击节点改字、失焦」时库发出的那个事件逐字一致（dist: name/origin/target）。
     */
    const orig = MindElixir.prototype.init;
    const box: { inst?: { bus: { fire: (name: string, payload: unknown) => void } } } = {};
    const spy = vi.spyOn(MindElixir.prototype, 'init').mockImplementation(function (
      this: { bus: { fire: (name: string, payload: unknown) => void } },
      data?: unknown,
    ) {
      box.inst = this;
      return orig.call(this as never, data as never);
    });

    const { container } = renderMap();
    await waitMap(container);
    expect(box.inst).toBeTruthy();

    const node = (nodeEl(container, '机制') as unknown as { nodeObj: { topic: string } }).nodeObj;
    node.topic = '机制（通气）';
    box.inst!.bus.fire('operation', { name: 'finishEdit', target: node, origin: '机制' });

    expect(stored()[NOTE_PATH].arrows).toEqual([
      { from: '波尔效应\u0000机制（通气）', to: '波尔效应\u0000表现' },
    ]);
    spy.mockRestore();
  });
});

