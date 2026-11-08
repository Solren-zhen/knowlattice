/**
 * 内嵌图片选择器：复用图片库的数据与搜索，以「内嵌浮层」形式挂在任意面板里，
 * 让其他面板（题库边刷边记、思维导图大纲等）不用切到整屏图片库也能选图。
 *
 * 为什么不做通用「面板内入口」：整屏 imageLib 面板与 quiz/mind 都是模态互斥
 * （RAIL_MODAL），从题库里打开整屏图片库等于丢掉答题上下文，所以选择器必须内嵌。
 *
 * 与 ImageLibrary 的分工：
 * - ImageLibrary = 整屏面板，管理 vault 全部图片（浏览/OCR/插入当前笔记）；
 * - ImagePickerSheet = 轻量选择器，只做「搜索 → 点图 → 返回 Markdown」，
 *   不带 OCR（编辑场景里用户要的是图不是抄图里的字）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../core/feedback';
import { filterImages, imageMarkdown, type ImageEntry } from '../core/imageLib';
import { escThenClose, useEsc } from './useEsc';
import { IconClose } from './icons';

interface Props {
  entries: ImageEntry[];
  /** 附件路径 → 可显示的 URL（vault.readFile 结果）；拿不到返回 undefined */
  resolveAsset: (path: string) => string | undefined;
  /** 选中图片后的回调，拿到可直接写入正文的 Markdown */
  onPick: (markdown: string) => void;
  onClose: () => void;
}

export default function ImagePickerSheet({ entries, resolveAsset, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState<ImageEntry | null>(null);
  useEsc(escThenClose(onClose));
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const shown = useMemo(() => filterImages(entries, query), [entries, query]);
  const zoomUrl = zoom ? resolveAsset(zoom.path) : undefined;

  const pick = (e: ImageEntry) => {
    onPick(imageMarkdown(e.path, e.name.replace(/\.[^.]+$/, '')));
    toast(`已插入 ${e.name}`, 'ok', 3000);
    onClose();
  };

  return (
    <div className="img-picker" role="dialog" aria-label="选择图片" onClick={onClose}>
      <div className="img-picker__card" onClick={(ev) => ev.stopPropagation()}>
        <div className="img-picker__head">
          <span className="img-picker__title">选择图片</span>
          <input
            ref={searchRef}
            className="img-picker__search"
            type="search"
            placeholder="按文件名过滤…"
            aria-label="图片过滤"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
          />
          <button className="btn-icon" aria-label="关闭图片选择" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        {shown.length === 0 ? (
          <p className="muted img-picker__empty">
            {entries.length === 0
              ? '图片库里还没有图片。导入内容包（勾上「连图片一起导」）或在编辑器里插图后，图片会出现在这里。'
              : `没有匹配「${query}」的图片。`}
          </p>
        ) : (
          <div className="img-picker__grid">
            {shown.map((e) => {
              const url = resolveAsset(e.path);
              return (
                <figure key={e.path} className="img-picker__item">
                  <button
                    className="img-picker__thumb"
                    title={e.path}
                    aria-label={`查看 ${e.name}`}
                    onClick={() => setZoom(e)}
                  >
                    {url ? <img src={url} alt={e.name} loading="lazy" /> : <span className="muted">读不到</span>}
                  </button>
                  <figcaption className="img-picker__cap" title={e.path}>
                    <span className="img-picker__name">{e.name}</span>
                    <button className="btn-small" onClick={() => pick(e)}>插入</button>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}
        {zoom && (
          <div className="img-picker__lightbox" role="dialog" aria-label={`${zoom.name} 大图`} onClick={() => setZoom(null)}>
            <div className="img-picker__lightbox-body" onClick={(ev) => ev.stopPropagation()}>
              <img src={zoomUrl} alt={zoom.name} />
              <div className="img-picker__lightbox-side">
                <span className="img-picker__name" title={zoom.path}>{zoom.name}</span>
                <button className="btn-small" onClick={() => pick(zoom)}>插入图片</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
