/**
 * OMML（Office Math Markup Language，Word 的公式 XML）→ LaTeX。
 *
 * 为什么需要它：mammoth 完全不认识 OMML —— `m:oMath` 会被当作未知元素**静默丢弃**，
 * 于是 Word 里的公式转成 Markdown 后整段消失，前后文字还会粘在一起（已用真实 .docx 验证）。
 * 公式一旦丢在转换这一步，后面再没有任何补救机会，所以必须在 mammoth 之前把公式先捞出来。
 *
 * 覆盖 Word 公式面板里最常见的结构：分式、上下标、根式、括号、求和/积分、函数、
 * 重音、上划线、矩阵、极限。罕见结构退化为「拼接子式」，至少不丢内容。
 * 解析用 DOMParser（浏览器与 jsdom 都有），按 localName 匹配，不依赖命名空间前缀。
 */

const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** LaTeX 文本里的特殊字符转义（公式里的普通字母不该被转义，只处理真正的元字符） */
function escText(s: string): string {
  return s.replace(/[\\{}_^%$#&]/g, '\\$&');
}

function childByLocal(node: Element, local: string): Element | null {
  for (const c of Array.from(node.children)) if (c.localName === local) return c;
  return null;
}

function childrenByLocal(node: Element, local: string): Element[] {
  return Array.from(node.children).filter((c) => c.localName === local);
}

/** 取后代里第一个 m:t 的文本（m:r 里可能夹着 rPr 等） */
function runText(node: Element): string {
  let out = '';
  for (const c of Array.from(node.getElementsByTagName('*'))) {
    if (c.localName === 't') out += c.textContent ?? '';
  }
  // getElementsByTagName('*') 对 m:t 也会命中；若上面没拿到就直接用 textContent
  return out || (node.textContent ?? '');
}

const NARY: Record<string, string> = {
  '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∮': '\\oint', '∐': '\\coprod',
  '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge',
};

const ACCENT: Record<string, string> = {
  '\u0302': '\\hat', '\u0304': '\\bar', '\u20d7': '\\vec', '\u0303': '\\tilde',
  '\u0307': '\\dot', '\u0308': '\\ddot', '\u030a': '\\mathring', '\u030c': '\\check',
};

/** 子树 → LaTeX */
function latexOf(node: Element): string {
  switch (node.localName) {
    case 'oMath':
    case 'oMathPara': {
      // 可能内含 oMathParaPr；直接拼接所有 oMath/e 子式
      const math = childByLocal(node, 'oMath');
      if (math) return latexOf(math);
      return Array.from(node.children).map(latexOf).join('');
    }
    case 'r': {
      // 一个 run：文字 + 可能的 rPr（这里不处理加粗/斜体，公式里意义不大）
      const t = childByLocal(node, 't');
      return t ? escText(t.textContent ?? '') : escText(runText(node));
    }
    case 't':
      return escText(node.textContent ?? '');
    case 'f': {
      const num = childByLocal(node, 'num');
      const den = childByLocal(node, 'den');
      return `\\frac{${num ? latexOf(num) : ''}}{${den ? latexOf(den) : ''}}`;
    }
    case 'sSup': {
      const e = childByLocal(node, 'e');
      const sup = childByLocal(node, 'sup');
      return `{${e ? latexOf(e) : ''}}^{${sup ? latexOf(sup) : ''}}`;
    }
    case 'sSub': {
      const e = childByLocal(node, 'e');
      const sub = childByLocal(node, 'sub');
      return `{${e ? latexOf(e) : ''}}_{${sub ? latexOf(sub) : ''}}`;
    }
    case 'sSubSup': {
      const e = childByLocal(node, 'e');
      const sub = childByLocal(node, 'sub');
      const sup = childByLocal(node, 'sup');
      return `{${e ? latexOf(e) : ''}}_{${sub ? latexOf(sub) : ''}}^{${sup ? latexOf(sup) : ''}}`;
    }
    case 'rad': {
      const deg = childByLocal(node, 'deg');
      const e = childByLocal(node, 'e');
      const body = `{${e ? latexOf(e) : ''}}`;
      const d = deg ? latexOf(deg).trim() : '';
      // Word 的空 deg 常见是占位符 ◻/空白，视作无次数
      return d && d !== '\\placeholder ' ? `\\sqrt[${d}]${body}` : `\\sqrt${body}`;
    }
    case 'd': {
      const pr = childByLocal(node, 'dPr');
      const beg = pr ? (childByLocal(pr, 'begChr')?.getAttributeNS(MATH_NS, 'val') ?? childByLocal(pr, 'begChr')?.getAttribute('m:val')) : null;
      const end = pr ? (childByLocal(pr, 'endChr')?.getAttributeNS(MATH_NS, 'val') ?? childByLocal(pr, 'endChr')?.getAttribute('m:val')) : null;
      const inner = childrenByLocal(node, 'e').map(latexOf).join('');
      const b = beg ?? '(';
      const en = end ?? ')';
      return `\\left${b}${inner}\\right${en}`;
    }
    case 'nary': {
      const pr = childByLocal(node, 'naryPr');
      const chrEl = pr ? childByLocal(pr, 'chr') : null;
      const chr = chrEl ? (chrEl.getAttributeNS(MATH_NS, 'val') ?? chrEl.getAttribute('m:val')) : null;
      const op = (chr && NARY[chr]) || '\\int';
      const sub = childByLocal(node, 'sub');
      const sup = childByLocal(node, 'sup');
      const e = childByLocal(node, 'e');
      const lower = sub ? `_{${latexOf(sub)}}` : '';
      const upper = sup ? `^{${latexOf(sup)}}` : '';
      return `${op}${lower}${upper}${e ? ` ${latexOf(e)}` : ''}`;
    }
    case 'func': {
      const name = childByLocal(node, 'fName');
      const e = childByLocal(node, 'e');
      return `${name ? latexOf(name) : ''}${e ? `\\left(${latexOf(e)}\\right)` : ''}`;
    }
    case 'acc': {
      const pr = childByLocal(node, 'accPr');
      const chrEl = pr ? childByLocal(pr, 'chr') : null;
      const chr = chrEl ? (chrEl.getAttributeNS(MATH_NS, 'val') ?? chrEl.getAttribute('m:val')) : null;
      const cmd = (chr && ACCENT[chr]) || '\\hat';
      const e = childByLocal(node, 'e');
      return `${cmd}{${e ? latexOf(e) : ''}}`;
    }
    case 'bar': {
      const e = childByLocal(node, 'e');
      return `\\overline{${e ? latexOf(e) : ''}}`;
    }
    case 'limLow': {
      const e = childByLocal(node, 'e');
      const lim = childByLocal(node, 'lim');
      return `${e ? latexOf(e) : ''}_{${lim ? latexOf(lim) : ''}}`;
    }
    case 'limUpp': {
      const e = childByLocal(node, 'e');
      const lim = childByLocal(node, 'lim');
      return `${e ? latexOf(e) : ''}^{${lim ? latexOf(lim) : ''}}`;
    }
    case 'm': {
      // 矩阵 / 方程组分列
      const rows = childrenByLocal(node, 'mr').map((mr) =>
        childrenByLocal(mr, 'e').map(latexOf).join(' & '),
      );
      return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
    }
    case 'box':
    case 'borderBox':
    case 'groupChr': {
      const e = childByLocal(node, 'e');
      return e ? latexOf(e) : Array.from(node.children).map(latexOf).join('');
    }
    case 'oMathParaPr':
    case 'rPr':
    case 'ctrlPr':
    case 'dPr':
    case 'naryPr':
    case 'accPr':
    case 'radPr':
    case 'funcPr':
    case 'fPr':
    case 'sSupPr':
    case 'sSubPr':
    case 'sSubSupPr':
    case 'mPr':
    case 'barPr':
    case 'limLowPr':
    case 'limUppPr':
    case 'argPr':
      return '';
    default:
      return Array.from(node.children).map(latexOf).join('');
  }
}

/** 取 oMath/oMathPara 里真正的公式载体 element（去掉属性/占位） */
function pickMath(root: Element): Element | null {
  if (root.localName === 'oMath' || root.localName === 'oMathPara') return root;
  const direct = childByLocal(root, 'oMath');
  if (direct) return direct;
  // 兜底：深处第一个 oMath
  const all = root.getElementsByTagName('*');
  for (const el of Array.from(all)) {
    if (el.localName === 'oMath' || el.localName === 'oMathPara') return el;
  }
  return root.firstElementChild;
}

/**
 * OMML 片段（`<m:oMath>…</m:oMath>` 或 `<m:oMathPara>…</m:oMathPara>` 或它们的内层）
 * → LaTeX 源码（不含 `$` 定界符）。识别不了返回空串。
 */
export function ommlToLatex(xml: string): string {
  const wrapped = `<root xmlns:m="${MATH_NS}" xmlns:w="${W_NS}">${xml}</root>`;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(wrapped, 'application/xml');
  } catch {
    return '';
  }
  const root = doc.documentElement;
  if (!root || root.getElementsByTagName('parsererror').length > 0) return '';
  const math = pickMath(root);
  if (!math) return '';
  return latexOf(math).replace(/\s+/g, ' ').trim();
}
