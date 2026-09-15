/**
 * 统一载入语汇：一条会扫光的骨架条 + 一句说明。
 * 用于面板内部的异步等待（PDF 渲染 / OCR 识别 / 内嵌页加载），
 * 与整片浮层级的 .loading 同源，不再各写各的灰字。
 */
interface Props {
  label: string;
  /** 紧凑模式：用于已有内边距的容器（如空态、文件投放区） */
  compact?: boolean;
}

export default function Loading({ label, compact }: Props) {
  return (
    <div className={`loading-inline${compact ? ' loading-inline--compact' : ''}`} role="status">
      <span className="loading-inline__bar" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
