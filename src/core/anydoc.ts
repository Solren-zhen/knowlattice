/**
 * anydoc-wasm engine: docx / pdf (plus pptx / xlsx / csv / epub / rtf / odt)
 * to GitHub-Flavored Markdown, fully offline in the browser.
 *
 * The wasm bundle is about 6.7 MB, so it is imported lazily: it only loads when
 * the user converts a file, and Vite code-splits it out of the main chunk.
 * anydoc does not OCR, so scanned PDFs throw an error with code 'needsOcr'.
 */
import { tidyMarkdown, type ConvertResult } from './convert';
import { normalizeMarkdownSpacing } from './mdSpace';

type AnydocModule = typeof import('@firecrawl/anydoc-wasm');

let modPromise: Promise<AnydocModule> | null = null;

/** Load and initialize the wasm module once; concurrent callers share it. */
export function loadAnydoc(): Promise<AnydocModule> {
  if (modPromise === null) {
    const p = import('@firecrawl/anydoc-wasm').then(async (mod) => {
      await mod.default();
      return mod;
    });
    modPromise = p;
    void p.catch(() => { modPromise = null; });
  }
  return modPromise;
}

/** anydoc errors carry a string code: unsupported / needsOcr / malformed ... */
export function anydocErrorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export interface AnydocResult extends ConvertResult {
  engine: 'anydoc';
  detected: string;
}

/** Convert a file with anydoc. Throws on unsupported / scanned / malformed input. */
export async function anydocToMarkdown(file: File): Promise<AnydocResult> {
  const mod = await loadAnydoc();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const detected = mod.formatFromBytes(bytes) ?? mod.formatFromExtension(ext);
  if (detected === undefined) throw new Error('anydoc can not detect this file format');
  const markdown = normalizeMarkdownSpacing(tidyMarkdown(mod.toMarkdownBytes(bytes, detected)));
  if (markdown.trim().length === 0) throw new Error('anydoc produced no content');
  return {
    title: file.name.replace(/\.[^.]+$/, ''),
    markdown,
    engine: 'anydoc',
    detected,
  };
}
