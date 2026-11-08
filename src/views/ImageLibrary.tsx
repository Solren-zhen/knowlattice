/**
 * 图片库面板：把 vault 里的附件图片集中浏览、就地识别文字、并把选中的图/字插进当前笔记。
 *
 * 为什么要有这个面板：插图之后图片只活在 `_attachments/` 里，笔记树只列 .md，
 * 用户于是没有任何地方能「看到自己一共插了哪些图、想复用一张旧图」——
 * 复用的唯一办法是记得它在哪篇笔记里，翻回去复制路径。
 *
 * 为什么识别文字放在这里而不是格式转换：讲义截图里的表格和公式，用户要的是
 * 「这一刻能看懂、能搜到、能抄下来」，跑到另一个视图去转换一圈反而更慢。
 * 识别是本地 tesseract（首次会加载约 3.5 MB 语言包），所以按需触发、不放后台预跑。
 *
 * 交互取舍：
 * - 用缩略图墙而不是列表：图片按内容找比按文件名找快得多；
 * - 点图放大用面板内的 lightbox，不弹新窗口；
 * - 「插入到当前笔记」要在没打开笔记时禁用并说明原因——不解释的按钮最招人骂。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../core/feedback';
import { filterImages, imageLibSummary, imageMarkdown, type ImageEntry } from '../core/imageLib';
import { escThenClose, useEsc } from './useEsc';
import { copyText } from './clipboard';
import { IconClose } from './icons';
import PanelOverlay from './PanelOverlay';

interface Props {
  entries: ImageEntry[];
  /** 附件路径 → 可显示的 URL（vault.readFile 结果）；拿不到返回 undefined */
  resolveAsset: (path: string) => string | undefined;
  /** 插入到当前笔记；没有打开笔记时传 undefined */
  onInsert?: (markdown: string) => void;
  onClose: () => void;
}

export default function ImageLibrary({ entries, resolveAsset, onInsert, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState<ImageEntry | null>(null);
  const [ocrText, setOcrText] = useState('');
  const [ocrBusy, setOcrBusy] = useState('');
  useEsc(escThenClose(onClose));
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);


  const shown = useMemo(() => filterImages(entries, query), [entries, query]);
  const zoomUrl = zoom ? resolveAsset(zoom.path) : undefined;

  const insert = (e: ImageEntry) => {
    if (!onInsert) {
      toast('先打开一篇笔记，再点插入（图片默认插到光标处）', 'info', 5000);
      return;
    }
    onInsert(imageMarkdown(e.path, e.name.replace(/\.[^.]+$/, '')));
    toast(`已插入 ${e.name}`, 'ok', 3000);
  };

  const recognize = async (e: ImageEntry) => {
    const url = resolveAsset(e.path);
    if (!url) {
      toast('读不到这张图的内容，无法识别', 'err', 5000);
      return;
    }
    setOcrBusy('准备识别…');
    try {
      // 按需加载：tesseract 只在真正点识别时才进内存
      const { ocrImageToText } = await import('../core/ocr');
      const blob = await (await fetch(url)).blob();
      const text = await ocrImageToText(blob, (p) => setOcrBusy(`${p.label} ${Math.round(p.ratio * 100)}%`));
      setOcrText(text);
      toast(`识别完成：${text.length} 字`, 'ok', 3500);
    } catch (err) {
      toast(`识别失败：${(err as Error).message}`, 'err', 8000);
    } finally {
      setOcrBusy('');
    }
  };

  const insertText = () => {
    const text = ocrText.trim();
    if (!text) return;
    if (!onInsert) {
      toast('先打开一篇笔记，再插入文字', 'info', 5000);
      return;
    }
    // 前后留空行：识别出来的多是独立段落，紧贴上一段会被当成同一段
    onInsert(`\n\n${text}\n\n`);
    toast(`已插入识别文字（${text.length} 字）`, 'ok', 3000);
  };

  return (
    <PanelOverlay tone="plain" onClose={onClose}>
      <div
        className="panel panel--full img-lib"
        role="dialog"
        aria-label="图片库"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="panel__head">
          <span className="panel__title">图片库</span>
          <span className="muted img-lib__summary">{imageLibSummary(entries)}</span>
          <div className="spacer" />
          <input
            ref={searchRef}
            className="img-lib__search"
            type="search"
            placeholder="按文件名过滤…"
            aria-label="图片库搜索"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
          />
          <button className="btn-icon" aria-label="关闭图片库" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        {shown.length === 0 ? (
          <p className="muted img-lib__empty">
            {entries.length === 0
              ? '还没有图片。导入内容包（勾上「连图片一起导」），或在编辑器里插图后，图片会出现在这里。'
              : `没有匹配「${query}」的图片。`}
          </p>
        ) : (
          <div className="img-lib__grid">
            {shown.map((e) => {
              const url = resolveAsset(e.path);
              return (
                <figure key={e.path} className="img-lib__item">
                  <button
                    className="img-lib__thumb"
                    title={e.path}
                    aria-label={`查看 ${e.name}`}
                    onClick={() => {
                      // 换图就把上一张的识别结果清掉：留着会让人以为这张已经识别过了
                      setOcrText('');
                      setOcrBusy('');
                      setZoom(e);
                    }}
                  >
                    {url ? <img src={url} alt={e.name} loading="lazy" /> : <span className="muted">读不到</span>}
                  </button>
                  <figcaption className="img-lib__cap" title={e.path}>
                    <span className="img-lib__name">{e.name}</span>
                    <button className="btn-small" disabled={!onInsert} onClick={() => insert(e)}>
                      插入
                    </button>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}

        {zoom && (
          <div className="img-lib__lightbox" role="dialog" aria-label={`${zoom.name} 大图`} onClick={() => setZoom(null)}>
            <div className="img-lib__lightbox-body" onClick={(ev) => ev.stopPropagation()}>
              <img src={zoomUrl} alt={zoom.name} />
              <div className="img-lib__side">
                <div className="img-lib__side-head">
                  <span className="img-lib__side-name" title={zoom.path}>
                    {zoom.name}
                  </span>
                  <button className="btn-small" disabled={!onInsert} onClick={() => insert(zoom)}>
                    插入图片
                  </button>
                </div>
                <div className="img-lib__ocr">
                  <div className="img-lib__ocr-bar">
                    <button className="btn-small" disabled={Boolean(ocrBusy)} onClick={() => void recognize(zoom)}>
                      {ocrBusy ? ocrBusy : '提取文字（OCR）'}
                    </button>
                    <button
                      className="btn-small"
                      disabled={!ocrText}
                      onClick={() => void copyText(ocrText).then((ok) => toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中复制', ok ? 'ok' : 'err'))}
                    >
                      复制文字
                    </button>
                    <button className="btn-small" disabled={!ocrText || !onInsert} onClick={insertText}>
                      插入文字
                    </button>
                  </div>
                  <textarea
                    className="img-lib__ocr-text"
                    aria-label="识别出的文字"
                    placeholder="点「提取文字」把这张图里的文字识别出来，可以直接改，再插入笔记。"
                    value={ocrText}
                    onChange={(ev) => setOcrText(ev.target.value)}
                    spellCheck={false}
                  />
                </div>
                <button className="btn-small img-lib__close" onClick={() => setZoom(null)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PanelOverlay>
  );
}
