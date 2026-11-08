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
    expect(pdfWorkerSrc()).toBe('/pdfjs/pdf.worker.min.mjs');
  });

  it('getDocument 参数同时带上 CMap、标准字体、WASM 与 ICC 资源地址', () => {
    const params = pdfDocumentParams();
    expect(params.cMapUrl).toBe('/pdfjs/cmaps/');
    expect(params.cMapPacked).toBe(true);
    expect(params.standardFontDataUrl).toBe('/pdfjs/standard_fonts/');
    expect(params.wasmUrl).toBe('/pdfjs/wasm/');
    expect(params.iccUrl).toBe('/pdfjs/iccs/');
  });
});
