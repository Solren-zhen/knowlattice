import { describe, expect, it } from 'vitest';
import { pdfAssetUrl, pdfDocumentParams, pdfWorkerSrc } from '../pdfLib';

/**
 * 中文 PDF 的文字层靠 CMap 才能解出来。这一组断言防的是「参数被改掉/漏掉」：
 * 漏了不会报错，只会让所有 CID 字体的讲义读成空串（见 pdfLib.ts 的注释）。
 */
describe('pdf.js 资源地址', () => {
  it('cmaps 与 standard_fonts 指向 public/pdfjs 下的本地目录，且带尾部斜杠', () => {
    // 尾部斜杠是硬要求：pdf.js 直接拼 `${cMapUrl}${name}.bcmap`
    expect(pdfAssetUrl('cmaps')).toBe('/pdfjs/cmaps/');
    expect(pdfAssetUrl('standard_fonts')).toBe('/pdfjs/standard_fonts/');
  });

  it('worker 与字体资源同源同目录', () => {
    expect(pdfWorkerSrc()).toBe('/pdfjs/pdf.worker.min.js');
  });

  it('getDocument 参数同时带上资源地址，并禁用字体 JS 编译', () => {
    const params = pdfDocumentParams();
    expect(params.cMapUrl).toBe('/pdfjs/cmaps/');
    expect(params.cMapPacked).toBe(true);
    expect(params.standardFontDataUrl).toBe('/pdfjs/standard_fonts/');
    // 3.x 会为字体字形生成 new Function；恶意 PDF 可借此执行脚本。
    // Web 版没有 Tauri CSP 兜底，必须由参数层显式关闭。
    expect(params.isEvalSupported).toBe(false);
  });
});
