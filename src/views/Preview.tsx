/**
 * 实时预览（M1+M3）：
 * - 「属性: 内容」键值对属性名自动加粗（EasyTyping 思路）
 * - [[双链]] 可点击跳转；未创建的链接显示为灰色占位
 *
 * 安全策略：markdown-it 关闭 html 选项，用户笔记里的原始 HTML 一律按纯文本显示；
 * 属性键加粗与 wikilink 通过「占位标记 → 渲染后替换」实现，点击走事件委托，
 * 不注入内联 onclick 和 window 全局函数。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { renderMarkdown } from '../core/markdown';
import { FORMAT_KEYS } from '../core/formatKeys';
import { isImagePath, parseEmbedSpec, type EmbedSpec } from '../core/imageRef';
import { calloutLabel, isKnownCalloutType } from '../core/callout';
import { IconFile, IconFwd, IconLattice, IconLink, IconSave, IconSearch } from './icons';

/** markdown-it 实例已移至 core/markdown.ts 懒加载（首屏入口包不含它） */

/** 行内格式键的展示文案，从 FORMAT_KEYS 推出——键位只此一处定义，
 *  改键/加键都不会再漏改首页提示（见 core/formatKeys.ts 顶部与 mdFormat 的相关注释）。
 *  直接遍历 FORMAT_KEYS 而不是手写键名数组：手写的那份在新增「挖空（Alt+C）」时
 *  就漏掉了，正是 previewHero 那条「提示与 FORMAT_KEYS 同源」的测试把它抓出来的。
 *  label 形如 'Alt+A'，取 '+' 后半段，按定义顺序拼成 'A S Z X C'。 */
const FORMAT_HINT = `Alt/⌥ + ${Object.values(FORMAT_KEYS)
  .map((k) => k.label.split('+')[1])
  .join(' ')}`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 属性键的内部占位符用私有区字符（U+E000 / U+E001）。
 * 以前用的是 `%%…%%`，那正是 **Obsidian 的注释语法** —— 从 Obsidian 搬过来的
 * `%%私密备注%%` 会被当成属性键渲染成加粗，两边语义打架。私有区字符用户不会打出来。
 */
const PROP_OPEN = '\uE000';
const PROP_CLOSE = '\uE001';

/** 图片嵌入的占位协议：`mv-image://<宽>x<高>/<路径>`（宽高可空）。
 *  渲染成 HTML 之前它只是普通 markdown 图片的 src，postprocess 再换成真实附件 URL —— html:false
 *  的安全策略不变（不给笔记里的原始 HTML 留口子），尺寸也不用内联 HTML 传。
 *
 *  **路径必须整体 encodeURIComponent**：文件名带空格时（`Screenshot 2026-10-17.png`
 *  是 Obsidian 粘贴图的常见默认名），markdown-it 的链接目标遇空格即截断，
 *  整行会退化成字面文本 `![a b.png](mv-image://300x/a b.png)`，图完全不显示。
 *  斜杠一并编码不影响还原：postprocess 端是整体 decodeURIComponent 后按 `/` 切的。 */
function imagePlaceholderSrc(spec: EmbedSpec): string {
  const { width = '', height = '' } = spec.size;
  const box = width || height ? `${width}x${height}` : '';
  return `mv-image://${box}/${encodeURIComponent(spec.name)}`;
}

/** 预处理：属性键占位 + 图片嵌入占位 + wikilink 内部协议 */
function transformSegment(src: string): string {
  // 1. 属性键："- 定义: xxx" → 私有区占位（渲染后替换为带样式的 <strong>）
  const out = src.replace(/^(\s*-\s*)([^:\n\s][^:\n]{0,11}?)(\s*):(\s|$)/gm, (m, indent, key, space, tail) => {
    if (/[[\]]/.test(key)) return m;
    return `${indent}${PROP_OPEN}${key}${PROP_CLOSE}${space}:${tail}`;
  });
  // 1b. Obsidian 注释 %%…%%：reading 视图里不显示（与 Obsidian 一致，注释不该出现在正文里）。
  //     必须跨行：整段私密备注写成 `%%\n多行\n%%` 是常见用法，用 `.*?` 不跨行会
  //     把标记连同内容原样漏到正文里。未闭合时保留原文（不吞后文）。
  const noComments = out.replace(/%%[\s\S]*?%%/g, '');

  // 2. 图片嵌入 ![[图.png|300]] → 图片占位协议（渲染后换成真图并带上尺寸）。
  //    必须排在双链规则前面：否则 ![[图.png]] 会被下面那条当成 [[…]] 吞掉，
  //    右侧预览只剩一个带感叹号的链接，而编辑器里明明显示的是图片。
  const withImages = noComments.replace(/!\[\[([^\]\n]+?)\]\]/g, (m, inner: string) => {
    const spec = parseEmbedSpec(inner.trim());
    // ![[笔记]]：不做整篇嵌入（编辑器里也只显示成可点的双链），去掉感叹号交给下面的双链规则。
    // 留着 `!` 的话 markdown-it 会把它当图片，渲染出一张 src 指向双链协议的破图。
    if (!isImagePath(spec.name)) return m.replace(/^!/, '');
    return `![${spec.alt.replace(/[[\]]/g, '')}](${imagePlaceholderSrc(spec)})`;
  });

  // 3. [[目标]] 或 [[目标|别名]] → 内部协议链接（渲染后统一替换成可点击锚点）
  return withImages.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const t = target.trim();
    const label = (alias ?? t).trim();
    return `[${label}](mv-wikilink://${encodeURIComponent(t)})`;
  });
}

/** 预处理入口：围栏代码块与行内代码原样保留，其余段落做属性键/双链替换，
 *  避免代码里的 [[x]] 被改成链接语法后以原文形式显示。 */
function preprocess(src: string): string {
  return src
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : transformSegment(seg)))
    .join('');
}

/** 后处理：占位标记 → 真实 HTML。code 块内的内容不做替换 */
function postprocess(
  html: string,
  resolve: (name: string) => string | null,
  readFile?: (path: string) => string | undefined
): string {
  return html
    .split(/(<code[\s\S]*?<\/code>)/g)
    .map((seg) => {
      if (seg.startsWith('<code')) return seg;
      return seg
        // 属性键加粗（markdown-it 已对文本做过转义，这里可安全包一层标签）
        .replace(/\uE000(.{1,24}?)\uE001/g, (_m, key: string) => `<strong class="prop-key">${key}</strong>`)
        // Callout：markdown-it 出来的是普通引用块，这里按类型换成带标题的提示块。
        //
        // 匹配整个**首段落**再自己拆标题：只吃到标题末尾的写法有两个坑——
        // ① 标题里带行内格式（`**加粗**`、`[[双链]]`）时，`[^<]*` 会停在第一个
        //    `<strong>`/`<a>` 上，把后半截标题漏进正文；② breaks:true 把标题后的
        //    换行转成了 `<br>`，不吃掉它正文首行就会多一个空行。
        // 现在按 `<br>` 拆：第一段是标题（允许内联 HTML），其余是正文，一次到位。
        //
        // 折叠标记 `-`（默认收起）/ `+`（默认展开）：不处理的话 `> [!question]- 答案`
        // 这种自测写法会把答案直接摊开，与 Obsidian 的预期相反。折叠状态存 class，
        // 切换在 Preview 的 handleClick / handleKeyDown 里（同一个事件委托，不注入内联 onclick）。
        // 可折叠的标题挂 role=button + tabindex + aria-expanded：只做鼠标点击的话，
        // 键盘用户完全打不开收起的答案。
        .replace(/<blockquote>\s*<p>\[!([A-Za-z][\w-]*)\]([+-]?)([\s\S]*?)<\/p>/g,
          (_m, type: string, fold: string, rest: string) => {
            const t = type.toLowerCase();
            const cls = ['mv-callout', isKnownCalloutType(t) ? `mv-callout-${t}` : 'mv-callout-default'];
            if (fold) cls.push('mv-callout--fold');
            if (fold === '-') cls.push('mv-callout--collapsed');
            const chevron = fold ? '<span class="mv-callout-chevron" aria-hidden="true">▾</span>' : '';
            const a11y = fold
              ? ` role="button" tabindex="0" aria-expanded="${fold === '-' ? 'false' : 'true'}"`
              : '';
            // 首段落里的 `<br>` 就是原笔记的换行；第一段当标题，其余原样拼回正文
            const lines = rest.split(/<br\s*\/?>\s*\n?/i);
            const title = lines[0].trim();
            const body = lines.slice(1).join('<br>');
            const head = `<blockquote class="${cls.join(' ')}">`
              + `<p class="mv-callout-title"${a11y}>${calloutLabel(t)}${title ? `：${title}` : ''}${chevron}</p>`;
            return body ? `${head}<p class="mv-callout-body">${body}</p>` : head;
          })
        // 图片嵌入：占位 src → 附件真实 URL（+ 尺寸）；找不到就明说缺图，不留破图
        .replace(/<img([^>]*?)src="mv-image:\/\/([^"]*)"([^>]*?)\/?>/g, (_m, before: string, payload: string, after: string) => {
          let p = payload;
          try { p = decodeURIComponent(payload); } catch { /* 保持原样 */ }
          const box = /^(\d*)x(\d*)\//.exec(p);
          const name = box ? p.slice(box[0].length) : p.replace(/^\//, '');
          if (!readFile) return `<span class="mv-img-missing">${escapeHtml(name)}（图片未导入）</span>`;
          const url = readFile(name);
          if (!url) return `<span class="mv-img-missing">${escapeHtml(name)}（图片未导入）</span>`;
          const alt = /alt="([^"]*)"/.exec(before + after)?.[1] ?? escapeHtml(name);
          const dims = box
            ? [box[1] && `width="${box[1]}"`, box[2] && `height="${box[2]}"`].filter(Boolean).join(' ')
            : '';
          return `<img src="${escapeHtml(url)}" alt="${alt}"${dims ? ` ${dims}` : ''} loading="lazy">`;
        })
        // wikilink 锚点
        .replace(/href="mv-wikilink:\/\/([^"]*)"/g, (_m, enc: string) => {
          let t = enc;
          try { t = decodeURIComponent(enc); } catch { /* 保持原样 */ }
          const cls = resolve(t) !== null ? 'wikilink' : 'wikilink missing';
          return `href="javascript:void(0)" class="${cls}" data-mv-target="${escapeHtml(t)}"`;
        });
    })
    .join('');
}

interface Props {
  content: string | null;
  /** 解析链接名 → vault 路径（null 表示未创建） */
  resolve?: (name: string) => string | null;
  onOpenLink?: (name: string) => void;
  /** vault 相对路径 → 文件内容，用于图片渲染 */
  readFile?: (path: string) => string | undefined;
  /** 空状态 Hero 主 CTA */
  onSearch?: () => void;
  onGraph?: () => void;
  /**
   * 正文渲染完成（含失败回退）后回调。
   * 卡片这类「按内容高度落位」的宿主必须靠它重算位置：正文是异步渲染的，
   * 首帧只有骨架高度，等 markdown-it 就绪后卡片会突然长高，仅靠 ResizeObserver
   * 观察卡片自身并不可靠（外框尺寸不随内部内容变化时不触发）。
   */
  onRendered?: () => void;
}

export default function Preview({ content, resolve, onOpenLink, readFile, onSearch, onGraph, onRendered }: Props) {
  // markdown-it 懒加载 → 异步渲染。保持上一份 html 直到新结果就绪（alive 守卫防竞态），
  // 避免切笔记时闪空白；content 为 null 时走 placeholder 分支，不消费 html
  const [html, setHtml] = useState('');
  /** onRendered 走 ref：宿主每次渲染都会传新闭包，不能让它进入 effect 依赖（会无限重渲染） */
  const renderedRef = useRef(onRendered);
  useEffect(() => { renderedRef.current = onRendered; });
  /** 正文已写入 html，但还没提交到 DOM；提交完（layout effect）才通知宿主量尺寸 */
  const pendingNotifyRef = useRef(false);

  useEffect(() => {
    if (!content) return;
    let alive = true;
    // 剥离 frontmatter，元数据不进入正文渲染
    const stripped = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    let src = preprocess(stripped);
    // 图片：![](vault路径) → 用 vault 内容(dataURL)替换 src。
    // 外部地址（http/https/data/blob）原样放过；**占位协议自身必须跳过**——
    // preprocess 已经把 `![[图.png|300]]` 变成 `![图.png](mv-image://…)`，
    // 这条规则若再吃一次，就会拿占位 URL 去 readFile，查不到后把图换成「未导入」。
    // 找不到的本地图不在这里兜底，统一改写成占位协议交给 postprocess 说缺图。
    src = src.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt: string, path: string) => {
      // 标准 Markdown 的可选标题语法 `![](a.png "标题")`：尾部引号段不是路径，先摘掉
      const raw = path.trim().replace(/\s+("[^"]*"|'[^']*')\s*$/, '');
      if (/^(https?:|data:|blob:|mv-image:)/i.test(raw)) return m;
      const data = readFile?.(raw);
      if (!data) return `![${alt}](${imagePlaceholderSrc({ name: raw, alt, size: {} })})`;
      return `![${alt}](${data})`;
    });
    // 渲染失败（chunk 加载失败 / 渲染器抛错）不能让正文永远停在空白：
    // 这里统一兜底成提示文案，并照样通知宿主重算落位。
    renderMarkdown(src)
      .then((raw) => {
        if (!alive) return;
        pendingNotifyRef.current = true;
        setHtml(postprocess(raw, resolve ?? (() => null), readFile));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        console.error('Markdown 渲染失败：', e);
        pendingNotifyRef.current = true;
        setHtml('<p class="preview-error">正文渲染失败，可直接在编辑器中打开查看。</p>');
      });
    return () => { alive = false; };
  }, [content, resolve, readFile]);

  // 正文提交到 DOM 之后再通知宿主：此刻量到的才是最终高度。
  // 放在 .then 里直接调用会早一帧——那时 DOM 还是骨架，宿主按旧高度落位等于没修。
  useLayoutEffect(() => {
    if (!html || !pendingNotifyRef.current) return;
    pendingNotifyRef.current = false;
    renderedRef.current?.();
  }, [html]);

  /**
   * 切换提示块开合，并同步 aria-expanded。
   * 折叠状态只在 class 上（CSS 负责隐藏），aria 由这里手动跟：纯 CSS 方案读不到状态。
   */
  const toggleFold = (title: HTMLElement) => {
    const box = title.parentElement;
    if (!box) return;
    const collapsed = box.classList.toggle('mv-callout--collapsed');
    title.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  };

  // 事件委托：折叠提示块标题 → 切换开合；点击 wikilink 锚点 → onOpenLink(目标名)
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    // 折叠只在标题上生效：点正文里的链接不该顺手把块收起来
    const title = el.closest?.<HTMLElement>('.mv-callout--fold > .mv-callout-title');
    if (title) {
      e.preventDefault();
      toggleFold(title);
      return;
    }
    if (!onOpenLink) return;
    const anchor = el.closest?.('a[data-mv-target]');
    if (anchor) {
      e.preventDefault();
      onOpenLink(anchor.getAttribute('data-mv-target') ?? '');
    }
  };

  /**
   * 键盘开合：标题挂的是 role=button + tabindex，Enter / 空格必须能切换，
   * 否则收起的答案对键盘用户等于不存在。只在焦点落在标题本身时响应——
   * 标题里若嵌了链接，焦点在链接上时空格仍归链接。
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target as HTMLElement;
    if (!el.classList.contains('mv-callout-title')) return;
    const title = el.closest<HTMLElement>('.mv-callout--fold > .mv-callout-title');
    if (!title) return;
    e.preventDefault();
    toggleFold(title);
  };

  if (content === null) {
    // 首页文案纪律：一行只说一件事，每条 ≤ 10 个字（断言在 previewHero.dom.test.tsx，
    // 长度按词计数、忽略分隔符）。40+ 字的文案在两列网格里会被撑成三行、
    // 右边缘参差，首屏被拉长。设计理由（为什么这四个键要挤在左手）属于 README，不属于首屏。
    return (
      <div className="preview placeholder" data-stagger>
        {/* 品牌锁定：晶格图腾与字标同一行。
            旧版是「浮动图腾 + 大写字母距的渐变胶囊」，渐变 / 外发光 / uppercase tracking
            三件套凑齐，正是通用生成器的签名；这里只留一行安静的字标。
            图腾也不再无限呼吸：动效只传达状态，装饰性循环不留给首屏。 */}
        <div className="hero-brand" data-reveal>
          <span className="hero-lattice" aria-hidden="true"><IconLattice size={22} /></span>
          <span className="hero-wordmark">晶格 · KnowLattice</span>
        </div>
        <h1 className="hero-title" data-reveal>你的知识库，从这里开始</h1>
        <p className="hero-sub" data-reveal>笔记沉淀知识 · 层级梳理思路 · 双链串联全局</p>
        {/* 三条能力做成一行发丝分隔的元数据，不再做成三枚各自配色的胶囊：
            同一屏出现三种强调色会破坏「全站一个强调色」，层级反而散掉。 */}
        <div className="hero-proof" data-reveal aria-label="KnowLattice 特性">
          <span><IconSave /> 本地优先</span>
          <span><IconFile /> Markdown 存储</span>
          <span><IconLink /> 全库互联</span>
        </div>
        <div className="hero-cta" data-reveal>
          <button className="btn-primary hero-primary" data-magnet onClick={onSearch}>
            <IconSearch /> 快速搜索 <kbd>Ctrl K</kbd>
            {/* 「按钮里的按钮」：尾随箭头自成一个圆形，悬停时向右上轻移（高级 CTA 的通用细节） */}
            <span className="btn-trail" aria-hidden="true"><IconFwd size={13} /></span>
          </button>
          <button className="btn hero-graph" onClick={onGraph}>知识图谱</button>
        </div>
        <div className="teach-steps" data-reveal>
          <div className="teach-step"><kbd>回车</kbd><span>续写下一条</span></div>
          <div className="teach-step"><kbd>Tab</kbd><span>缩进成子要点</span></div>
          <div className="teach-step"><kbd>[[</kbd><span>链接到其他笔记</span></div>
          <div className="teach-step wide format-hint"><kbd>{FORMAT_HINT}</kbd><span>加粗 / 高亮 / 斜体 / 双链</span></div>
          {/* 第 5 条跨两列：5 个格子在 2 列网格里必然剩一个孤儿格，索性让它整行 */}
          <div className="teach-step wide"><kbd>右键</kbd><span>打开 / 删除整篇笔记</span></div>
        </div>
        <p className="muted shortcut-hint" data-reveal>
          <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存 · <kbd>Alt</kbd>+<kbd>←→</kbd> 后退前进
        </p>
      </div>
    );
  }
  return (
    <div className="preview markdown-body" onClick={handleClick} onKeyDown={handleKeyDown}
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}
