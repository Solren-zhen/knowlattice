// @vitest-environment jsdom
/**
 * 格式转换的两处修复：
 * ① 公式：docx 的 OMML 先抽成占位 token、转换后还原成 `$…$` / `$$…$$`（mammoth 会丢弃 OMML）；
 * ② 图片：正文里内联的 base64 图落成附件、改写为 _attachments/（否则「存为笔记」时整批丢）。
 * 另钉住 mdSpace 不再误伤公式（清空白/上下标修补会把公式改成乱码）。
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { applyEquationTokens, extractInlineImages, ATTACH_DIR, substituteDocxEquations } from '../convert';
import { normalizeMarkdownSpacing } from '../mdSpace';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0F+AAAAAElFTkSuQmCC';

const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** 造一个含「行间分式 + 行内 x^2」的真实 docx 字节 */
async function docxWithMath(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const frac = '<m:oMathPara><m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num>'
    + '<m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></m:oMathPara>';
  const sup = '<m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>';
  const doc = `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:m="${M}"><w:body>`
    + `<w:p><w:r><w:t>前</w:t></w:r>${frac}<w:r><w:t>中</w:t></w:r>${sup}<w:r><w:t>后</w:t></w:r></w:p>`
    + `</w:body></w:document>`;
  zip.file('word/document.xml', doc);
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('docx 公式：OMML 抽成 token → 还原 LaTeX', () => {
  it('document.xml 里的公式被替换成 token，公式表拿到 LaTeX', async () => {
    const { bytes, recipes } = await substituteDocxEquations(await docxWithMath());
    expect(recipes).toHaveLength(2);
    expect(recipes[0]).toEqual({ latex: '\\frac{a}{b}', block: true });
    expect(recipes[1]).toEqual({ latex: '{x}^{2}', block: false });

    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');
    expect(xml).toContain('@@KLZ-EQ-0@@');
    expect(xml).toContain('@@KLZ-EQ-1@@');
    expect(xml).not.toContain('m:oMath'); // 原公式元素已被替换，mammoth 不会再丢掉文字
    expect(xml).toContain('前');
    expect(xml).toContain('中');
  });

  it('token 还原：行间 $$…$$、行内 $…$；识别不出的 token 直接删除', async () => {
    const { recipes } = await substituteDocxEquations(await docxWithMath());
    const md = applyEquationTokens('前@@KLZ-EQ-0@@中@@KLZ-EQ-1@@后', recipes);
    expect(md).toBe('前\n\n$$\\frac{a}{b}$$\n\n中${x}^{2}$后');
    expect(applyEquationTokens('a@@KLZ-EQ-9@@b', recipes)).toBe('ab');
  });

  it('没有公式的 docx 原样返回，不产生 token', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>无公式</w:t></w:r></w:p></w:body></w:document>`);
    const bytes = await zip.generateAsync({ type: 'arraybuffer' });
    const r = await substituteDocxEquations(bytes);
    expect(r.recipes).toEqual([]);
    expect(new Uint8Array(r.bytes)).toEqual(new Uint8Array(bytes));
  });
});

describe('内联图片：data URI 落成附件', () => {
  it('base64 图抽成 Blob 并改写为 _attachments/ 路径', () => {
    const { markdown, images } = extractInlineImages(`正文\n![图](data:image/png;base64,${PNG_B64})\n结束`);
    expect(images).toHaveLength(1);
    expect(images[0].filename).toMatch(/^img-[a-z0-9]+-0\.png$/);
    expect(markdown).toContain(`![图](${ATTACH_DIR}img-`);
    expect(markdown).not.toContain('data:image');
  });

  it('jpeg → jpg；无内联图时原样返回', () => {
    expect(extractInlineImages('普通正文')).toEqual({ markdown: '普通正文', images: [] });
    expect(extractInlineImages(`![](data:image/jpeg;base64,${PNG_B64})`).images[0].filename).toMatch(/\.jpg$/);
  });
});

describe('mdSpace 保护公式（不再误伤/紊乱）', () => {
  it('公式里的空格与「字母 数字」不被清理规则改动', () => {
    const out = normalizeMarkdownSpacing('见 $PO 2$ 与 $$a  b$$ 处');
    expect(out).toContain('$PO 2$');
    expect(out).toContain('$$a  b$$');
  });

  it('公式之外的上下标修补照旧生效（没有把保护做过头）', () => {
    expect(normalizeMarkdownSpacing('血氧 PO 2 偏低')).toContain('PO2');
  });
});
