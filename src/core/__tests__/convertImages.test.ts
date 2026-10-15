/**
 * 格式转换的内嵌图片保真。
 *
 * 修的是「转换后图片全丢」：原来 turndown 上挂着一条 dropImages 规则，把每个 <img> 换成
 * 「（图：alt）」或空串 —— 转换看起来成功、笔记也入库了，图却全没了，且没有任何提示。
 *
 * 分两层钉：
 *  1) 真实层：htmlToMarkdown 对 <img> 的处理（这就是当初丢图的**那一步**，改坏会直接红）。
 *  2) 接线层：docxToMarkdown 把图片抽成 Blob、并把 vault 路径写进正文。
 *     mammoth 的 Node 构建只认 path/buffer/file，不认 arrayBuffer（浏览器构建才认），
 *     所以这一层用替身顶掉 mammoth，只验我们自己那半段接线。
 *     真实 mammoth（浏览器构建）的端到端验证在浏览器里做，见本轮验证记录。
 */
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { extractInlineImages, htmlToMarkdown } from '../convert';

/** 1×1 透明 PNG */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0F+AAAAAElFTkSuQmCC';

/** 一个最小 .docx（一段正文 + 一张内嵌图），用于喂给替身 mammoth */
async function makeDocxBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('word/media/image1.png', PNG_B64, { base64: true });
  return zip.generateAsync({ type: 'uint8array' });
}

describe('htmlToMarkdown：图片不再被丢掉（根因所在的那一步）', () => {
  it('vault 附件路径原样保留成 Markdown 图片', () => {
    const md = htmlToMarkdown('<p>正文</p><p><img src="_attachments/img-abc-0.png" alt="示意图" /></p>');
    expect(md).toContain('![示意图](_attachments/img-abc-0.png)');
    expect(md).not.toContain('（图：');
  });

  it('无 alt 时也保留路径（alt 为空不能连图一起丢）', () => {
    const md = htmlToMarkdown('<img src="_attachments/img-abc-1.png" />');
    expect(md).toContain('![](_attachments/img-abc-1.png)');
  });

  it('非附件路径（外链 / 残留 data URI）降级为可读占位，不留必然 404 的坏链接', () => {
    const external = htmlToMarkdown('<img src="https://example.com/a.png" alt="外链图" />');
    expect(external).toContain('（图：外链图）');
    expect(external).not.toContain('https://example.com/a.png');

    const dataUri = htmlToMarkdown('<img src="data:image/png;base64,AAAA" />');
    expect(dataUri).not.toContain('data:image/png');
  });

  it('同一段正文里的多张图都保留，且顺序不变', () => {
    const md = htmlToMarkdown(
      '<img src="_attachments/a.png" alt="一" /><p>中间</p><img src="_attachments/b.png" alt="二" />'
    );
    expect(md.indexOf('a.png')).toBeLessThan(md.indexOf('中间'));
    expect(md.indexOf('中间')).toBeLessThan(md.indexOf('b.png'));
  });
});

describe('docxToMarkdown：图片抽成 Blob 并把 vault 路径写进正文', () => {
  it('返回 images（文件名 + 字节），正文引用同一文件名', async () => {
    const docxBytes = await makeDocxBytes();
    let seenSrc = '';
    vi.resetModules();
    vi.doMock('mammoth', () => {
      const images = {
        imgElement: (fn: unknown) => ({ __fn: fn }),
      };
      return {
        images,
        convertToHtml: async (
          input: { arrayBuffer: ArrayBuffer },
          options?: { convertImage?: { __fn: (image: unknown) => Promise<{ src: string }> } }
        ) => {
          // 真从 docx 里读那张图的字节，避免替身造一份假数据
          const zip = await JSZip.loadAsync(new Uint8Array(input.arrayBuffer));
          const png = await zip.file('word/media/image1.png')!.async('uint8array');
          const { src } = await options!.convertImage!.__fn({
            contentType: 'image/png',
            readAsArrayBuffer: async () => png.slice().buffer,
          });
          seenSrc = src;
          return { value: `<p>图片保真测试</p><img src="${src}" alt="示意图" />`, messages: [] };
        },
      };
    });
    const { docxToMarkdown, ATTACH_DIR: dir } = await import('../convert');

    const r = await docxToMarkdown(
      new File([docxBytes.slice()], '带图的讲义.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
    );

    expect(r.title).toBe('带图的讲义');
    expect(r.markdown).toContain('图片保真测试');
    // 正文里的路径 = mammoth 拿到的 src = images 里的文件名
    expect(r.markdown).toContain(`![示意图](${dir}img-`);
    const images = r.images ?? [];
    expect(images).toHaveLength(1);
    expect(images[0].filename).toMatch(/^img-[a-z0-9]+-0\.png$/);
    expect(images[0].blob.type).toBe('image/png');
    expect(seenSrc).toBe(`${dir}${images[0].filename}`);
    // 字节与文档内原图一致：写回附件后不会变成坏图
    const bytes = new Uint8Array(await images[0].blob.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(Buffer.from(PNG_B64, 'base64')));

    vi.doUnmock('mammoth');
  });

  it('扩展名跟着 content-type 走（jpeg → jpg）', async () => {
    vi.resetModules();
    vi.doMock('mammoth', () => ({
      images: { imgElement: (fn: unknown) => ({ __fn: fn }) },
      convertToHtml: async (
        _input: unknown,
        options?: { convertImage?: { __fn: (image: unknown) => Promise<{ src: string }> } }
      ) => {
        const { src } = await options!.convertImage!.__fn({
          contentType: 'image/jpeg',
          readAsArrayBuffer: async () => new ArrayBuffer(4),
        });
        return { value: `<img src="${src}" />`, messages: [] };
      },
    }));
    const { docxToMarkdown } = await import('../convert');
    const r = await docxToMarkdown(new File([new Uint8Array([1])], 'x.docx'));
    expect((r.images ?? [])[0].filename).toMatch(/\.jpg$/);
    expect(r.markdown).toContain('.jpg)');
    vi.doUnmock('mammoth');
  });
});

describe('图片文件名的唯一性（同一毫秒里转两份）', () => {
  /**
   * 名字戳只用 Date.now() 的话，同一毫秒里两份正文会得到同一个前缀，而图片序号都从 0 开始
   * ——后一份的 img-…-0 会覆盖前一份（vault 同路径写盘就是覆盖），前一份正文的引用指向别人的图。
   * 这里把时间钉死，只验证「戳里还有别的变化量」。
   */
  it('extractInlineImages 两次调用的文件名不同，且形状不变', () => {
    const fixed = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const src = `![甲](data:image/png;base64,${PNG_B64})`;
    const a = extractInlineImages(src);
    const b = extractInlineImages(src);

    expect(a.images).toHaveLength(1);
    expect(b.images).toHaveLength(1);
    expect(a.images[0].filename).not.toBe(b.images[0].filename);
    // 形状不变（其它地方按 `img-<戳>-<序号>.<ext>` 这个形状引用）
    expect(a.images[0].filename).toMatch(/^img-[a-z0-9]+-0\.png$/);
    fixed.mockRestore();
  });
});
