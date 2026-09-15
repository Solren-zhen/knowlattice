/**
 * 双色描边图标系统（duotone：淡色填充 + 1.7px 描边，currentColor）。
 * 图形语言：24px 网格、圆角端点、医学语义化造型。
 * 每个图标 = 一层 currentColor 低透明度填充（体积感）+ 一层描边（轮廓清晰度），
 * 因此在 15px 小尺寸下依然可辨，在激活态着色时整枚图标随之变色。
 */
interface P {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

/** 淡色填充层：与描边同形，提供 duotone 的体积感 */
const tint = { fill: 'currentColor', stroke: 'none' } as const;

export const IconSearch = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="10.8" cy="10.8" r="6.4" {...tint} opacity="0.16" />
    <circle cx="10.8" cy="10.8" r="6.4" />
    <path d="m20.4 20.4-4.7-4.7" strokeWidth={1.9} />
  </svg>
);

export const IconPlus = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" strokeWidth={2.1} />
  </svg>
);

/** 间隔复习：层叠记忆卡（后一张衬底 + 前一张卡面） */
export const IconCards = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="7.4" width="13.2" height="13.2" rx="3" {...tint} opacity="0.16" />
    <rect x="3" y="7.4" width="13.2" height="13.2" rx="3" />
    <path d="M8 3.6h9.3A3.5 3.5 0 0 1 20.8 7v9.3" />
    <path d="M6.6 12.2h6M6.6 15.7h3.6" strokeWidth={1.6} />
  </svg>
);

/** 错题本：靶心（薄弱点瞄准） */
export const IconTarget = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8.6" {...tint} opacity="0.14" />
    <circle cx="12" cy="12" r="8.6" />
    <circle cx="12" cy="12" r="4.4" />
    <circle cx="12" cy="12" r="1.3" {...tint} opacity="1" />
  </svg>
);

export const IconBackup = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" />
    <path d="M7 10l5 5 5-5M12 15V3" />
  </svg>
);

export const IconRestore = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" />
    <path d="M7 8l5-5 5 5M12 3v12" />
  </svg>
);

export const IconTrash = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M6.6 6.5 7.5 19a2 2 0 0 0 2 1.9h5a2 2 0 0 0 2-1.9l.9-12.5" {...tint} opacity="0.14" />
    <path d="M3 6.5h18M8.6 6.5V4.4a1.2 1.2 0 0 1 1.2-1.2h4.4a1.2 1.2 0 0 1 1.2 1.2v2.1" />
    <path d="M6.6 6.5 7.5 19a2 2 0 0 0 2 1.9h5a2 2 0 0 0 2-1.9l.9-12.5" />
    <path d="M10.4 10.5v6M13.6 10.5v6" strokeWidth={1.6} />
  </svg>
);

export const IconSave = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" {...tint} opacity="0.15" />
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </svg>
);

/** 解剖图谱：人体扫描取景框 + 头肩轮廓 */
export const IconBody = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="9.6" r="2.7" {...tint} opacity="0.18" />
    <path d="M6.8 18.4a5.4 5.4 0 0 1 10.4 0" {...tint} opacity="0.13" />
    <path d="M3.6 8V6.2a2.6 2.6 0 0 1 2.6-2.6H8M16 3.6h1.8a2.6 2.6 0 0 1 2.6 2.6V8M20.4 16v1.8a2.6 2.6 0 0 1-2.6 2.6H16M8 20.4H6.2a2.6 2.6 0 0 1-2.6-2.6V16" />
    <circle cx="12" cy="9.6" r="2.7" />
    <path d="M6.8 18.4a5.4 5.4 0 0 1 10.4 0" />
  </svg>
);

/** 知识图谱：三节点互连（边线淡、节点重） */
/** Brain atlas: brain outline plus a central sulcus */
export const IconBrain = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M12 4.6c-2 0-3.3.9-4.1 1.7-.9-.5-2.2-.3-3 .6-.8.9-.7 2.1-.2 2.9-.9.6-1.2 1.9-.7 2.9.4.8 1.2 1.3 2.1 1.4-.2 1.1.4 2.3 1.5 2.7 1.1.4 2.2.1 2.9-.6.8.9 2.1 1.3 3.3 1 1.4-.4 2.3-1.7 2.1-3.1 1.1-.3 2-1.3 2.1-2.5.1-1.2-.7-2.4-1.8-2.8.3-1.2-.4-2.6-1.6-3.1-.9-.3-1.8-.2-2.6.2-.6-.6-1.5-1-2.3-1Z" {...tint} opacity="0.16" />
    <path d="M12 4.6c-2 0-3.3.9-4.1 1.7-.9-.5-2.2-.3-3 .6-.8.9-.7 2.1-.2 2.9-.9.6-1.2 1.9-.7 2.9.4.8 1.2 1.3 2.1 1.4-.2 1.1.4 2.3 1.5 2.7 1.1.4 2.2.1 2.9-.6.8.9 2.1 1.3 3.3 1 1.4-.4 2.3-1.7 2.1-3.1 1.1-.3 2-1.3 2.1-2.5.1-1.2-.7-2.4-1.8-2.8.3-1.2-.4-2.6-1.6-3.1-.9-.3-1.8-.2-2.6.2-.6-.6-1.5-1-2.3-1Z" />
    <path d="M12 4.9v14M12 9.6c1.3-1 2.6-.9 3.6-.2M12 13.8c-1.1-.8-2.4-.8-3.4-.1" opacity="0.5" strokeWidth={1.4} />
  </svg>
);

export const IconGraph = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M8.5 6.7 15.4 7.5M7 8.4l3.9 7.3M16.6 10.4l-3.5 5.4" opacity="0.45" strokeWidth={1.5} />
    <circle cx="6.2" cy="6.2" r="2.9" {...tint} opacity="0.2" />
    <circle cx="17.8" cy="8" r="2.9" {...tint} opacity="0.2" />
    <circle cx="12" cy="18" r="2.9" {...tint} opacity="0.2" />
    <circle cx="6.2" cy="6.2" r="2.9" />
    <circle cx="17.8" cy="8" r="2.9" />
    <circle cx="12" cy="18" r="2.9" />
  </svg>
);

/** 题库练习：答卷勾选 */
export const IconQuiz = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <rect x="4.6" y="3" width="14.8" height="18" rx="3" {...tint} opacity="0.14" />
    <rect x="4.6" y="3" width="14.8" height="18" rx="3" />
    <path d="M8.5 7.8h7M9 13.6l2.1 2.1 4-4.2" strokeWidth={1.8} />
  </svg>
);

/** AI 助手：四角星光 + 伴星 */
export const IconAi = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3.2 14.1 9 20 11l-5.9 2L12 18.8 9.9 13 4 11l5.9-2z" {...tint} opacity="0.2" />
    <path d="M12 3.2 14.1 9 20 11l-5.9 2L12 18.8 9.9 13 4 11l5.9-2z" />
    <path d="M18.4 15.2l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" {...tint} opacity="0.55" strokeWidth={1.3} />
  </svg>
);

/** 实时预览开关：眼睛 */
export const IconEye = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M2.5 12S6.2 5.6 12 5.6 21.5 12 21.5 12 17.8 18.4 12 18.4 2.5 12 2.5 12z" {...tint} opacity="0.13" />
    <path d="M2.5 12S6.2 5.6 12 5.6 21.5 12 21.5 12 17.8 18.4 12 18.4 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.7" {...tint} opacity="0.4" />
    <circle cx="12" cy="12" r="2.7" />
  </svg>
);

/** PDF 对照：书本 */
export const IconBook = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M4 5.6A2.6 2.6 0 0 1 6.6 3H20v15.4H6.6A2.6 2.6 0 0 0 4 21z" {...tint} opacity="0.15" />
    <path d="M4 5.6A2.6 2.6 0 0 1 6.6 3H20v15.4H6.6A2.6 2.6 0 0 0 4 21z" />
    <path d="M4 18.4A2.6 2.6 0 0 1 6.6 16H20" />
  </svg>
);

/** 导出 md 文件夹：文件夹 + 向下箭头 */
export const IconFolder = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M3.5 7.4A2.4 2.4 0 0 1 5.9 5h3.4l2 2.4h6.8a2.4 2.4 0 0 1 2.4 2.4v7.8a2.4 2.4 0 0 1-2.4 2.4H5.9a2.4 2.4 0 0 1-2.4-2.4z" {...tint} opacity="0.15" />
    <path d="M3.5 7.4A2.4 2.4 0 0 1 5.9 5h3.4l2 2.4h6.8a2.4 2.4 0 0 1 2.4 2.4v7.8a2.4 2.4 0 0 1-2.4 2.4H5.9a2.4 2.4 0 0 1-2.4-2.4z" />
    <path d="M12 10.4v5.8M9.6 13.8 12 16.2l2.4-2.4" />
  </svg>
);

/** 导入 md 文件夹：文件夹 + 进入箭头 */
export const IconFolderIn = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M3.5 7.4A2.4 2.4 0 0 1 5.9 5h3.4l2 2.4h6.8a2.4 2.4 0 0 1 2.4 2.4v7.8a2.4 2.4 0 0 1-2.4 2.4H5.9a2.4 2.4 0 0 1-2.4-2.4z" {...tint} opacity="0.15" />
    <path d="M3.5 7.4A2.4 2.4 0 0 1 5.9 5h3.4l2 2.4h6.8a2.4 2.4 0 0 1 2.4 2.4v7.8a2.4 2.4 0 0 1-2.4 2.4H5.9a2.4 2.4 0 0 1-2.4-2.4z" />
    <path d="M12 10.4v5.8M9.6 13.8 12 16.2l2.4-2.4" />
  </svg>
);

/** 更多操作：三个圆点（收纳低频的数据操作） */
export const IconMore = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="5" cy="12" r="1.5" {...tint} opacity="1" />
    <circle cx="12" cy="12" r="1.5" {...tint} opacity="1" />
    <circle cx="19" cy="12" r="1.5" {...tint} opacity="1" />
  </svg>
);

export const IconBatch = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M8 6h12M8 12h12M8 18h12" />
    <path d="M3.5 6 4.9 7.4 7 5.4" strokeWidth={1.6} />
    <path d="M3.5 12 4.9 13.4 7 11.4" strokeWidth={1.6} />
    <path d="M3.5 18 4.9 19.4 7 17.4" strokeWidth={1.6} />
  </svg>
);

/** 反链 / 双链关联：两段链环 */
export const IconLink = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M11.2 6.4l1.9-1.9a4.4 4.4 0 0 1 6.2 6.2l-1.9 1.9" />
    <path d="M12.8 17.6l-1.9 1.9a4.4 4.4 0 0 1-6.2-6.2l1.9-1.9" />
    <path d="M9.6 14.4 14.4 9.6" strokeWidth={1.9} />
  </svg>
);

/** 品牌标：晶体网格（晶格 · KnowLattice）—— 深色圆角砖 + 发光节点与连线 */
export const IconLogo = ({ size = 24 }: P) => {
  const id = 'lg';
  return (
    <svg {...base(size)} stroke="none" fill="none">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4b3fd8" />
          <stop offset="1" stopColor="#8a6bff" />
        </linearGradient>
      </defs>
      {/* 深色圆角底 */}
      <rect x="1.4" y="1.4" width="21.2" height="21.2" rx="6.2" fill="#0c0c20" />
      {/* 晶体便签（两条渲染面） */}
      <path d="M7 9h7v2.2H7zM7 12.4h5v2.2H7zM7 15.8h6v2.2H7z" fill={`url(#${id}-g)`} opacity="0.5" />
      <path d="M11 6.2L17.6 9.2 15.6 18 10 15.6Z" fill="rgba(140,120,255,0.20)" stroke="rgba(160,140,255,0.5)" strokeWidth="0.8" />
      {/* 网格连线 */}
      <g stroke="rgba(175,164,255,0.55)" strokeWidth="0.8">
        <path d="M15.2 9.4L11.4 12.4M15.2 9.4L14.8 15.6M11.4 12.4L14.8 15.6M14.8 15.6L18 17.4" />
      </g>
      {/* 发光节点 */}
      <circle cx="15.2" cy="9.4" r="2.1" fill="#a98bff" />
      <circle cx="11.4" cy="12.4" r="2.5" fill="#7db6ff" />
      <circle cx="14.8" cy="15.6" r="2.3" fill="#b39bff" />
      <circle cx="18" cy="17.4" r="1.5" fill="#8b7bff" />
    </svg>
  );
};

/** 主题切换：太阳 / 月亮 */
export const IconSun = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4.2" {...tint} opacity="0.2" />
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
  </svg>
);
export const IconMoon = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M20 14.4A8.6 8.6 0 0 1 9.6 4a8.6 8.6 0 1 0 10.4 10.4z" {...tint} opacity="0.18" />
    <path d="M20 14.4A8.6 8.6 0 0 1 9.6 4a8.6 8.6 0 1 0 10.4 10.4z" />
  </svg>
);

/** 智能草稿：魔棒 */
export const IconWand = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M13.4 7.4 16.6 10.6 19.5 7.7a2.3 2.3 0 0 0-3.2-3.2z" {...tint} opacity="0.2" />
    <path d="M4.5 19.5 15 9" strokeWidth={1.8} />
    <path d="M13.4 7.4 16.6 10.6 19.5 7.7a2.3 2.3 0 0 0-3.2-3.2z" />
    <path d="M5.5 5.4v3M4 6.9h3M18.4 16.6v2.8M17 18h2.8" strokeWidth={1.6} />
  </svg>
);

export const IconChevron = ({ size = 14, open }: P & { open?: boolean }) => (
  <svg {...base(size)} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 160ms cubic-bezier(0.16,1,0.3,1)' }}>
    <path d="m9 6 6 6-6 6" strokeWidth={2} />
  </svg>
);

/** 待办清单：勾选清单 */
export const IconTodo = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <rect x="3.4" y="4" width="17.2" height="16.5" rx="3.4" {...tint} opacity="0.14" />
    <rect x="3.4" y="4" width="17.2" height="16.5" rx="3.4" />
    <path d="M8 10.4l1.9 1.9 3.6-3.8M8 16.4h7" strokeWidth={1.8} />
  </svg>
);

/** 标签聚合：吊牌 */
export const IconTag = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M11.6 3.6H19a1.4 1.4 0 0 1 1.4 1.4v7.4a2 2 0 0 1-.6 1.4l-6.6 6.6a1.4 1.4 0 0 1-2 0l-6.6-6.6a1.4 1.4 0 0 1 0-2l6.6-6.6a2 2 0 0 1 1.4-.6z" {...tint} opacity="0.15" />
    <path d="M11.6 3.6H19a1.4 1.4 0 0 1 1.4 1.4v7.4a2 2 0 0 1-.6 1.4l-6.6 6.6a1.4 1.4 0 0 1-2 0l-6.6-6.6a1.4 1.4 0 0 1 0-2l6.6-6.6a2 2 0 0 1 1.4-.6z" />
    <circle cx="15.6" cy="8.4" r="1.5" {...tint} opacity="1" />
  </svg>
);

/** 学习统计：柱状图 */
export const IconChart = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.4" {...tint} opacity="0.13" />
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.4" />
    <path d="M8 16.5v-4M12 16.5v-7M16 16.5v-2.5" strokeWidth={2.1} />
  </svg>
);

/** 导航历史：后退 / 前进 */
export const IconBack = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M14.5 18l-6-6 6-6" strokeWidth={2} />
  </svg>
);
export const IconFwd = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="m9.5 18 6-6-6-6" strokeWidth={2} />
  </svg>
);

/** 格式转换：双向箭头（PDF / Word ⇄ Markdown） */
export const IconConvert = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9.2" {...tint} opacity="0.12" />
    <path d="M5.4 8.6h11.2m0 0-3.1-3.1m3.1 3.1-3.1 3.1" strokeWidth={1.9} />
    <path d="M18.6 15.4H7.4m0 0 3.1-3.1m-3.1 3.1 3.1 3.1" strokeWidth={1.9} />
  </svg>
);

/** 历史版本：时钟回溯箭头 */
export const IconHistory = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8.6" {...tint} opacity="0.13" />
    <path d="M12 7.4V12l3.2 2" strokeWidth={1.9} />
    <path d="M3.8 5.2v4h4M20.2 18.8v-4h-4" strokeWidth={1.8} />
  </svg>
);

/** 关闭：全站浮层统一的「退出/关闭」图形。
    此前 17 处直接用文字字符 ✕——字形宽度、笔画粗细与光学中心都随字体走，
    和这里的 1.7px 描边图标不是同一套笔。 */
export const IconClose = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M7 7 17 17M17 7 7 17" strokeWidth={1.9} />
  </svg>
);

/** 文件：PDF / Word 的选取入口（取代按钮里的 📄 emoji） */
export const IconFile = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M6.6 3.9h7.1l4.7 4.7v11.5a1.9 1.9 0 0 1-1.9 1.9H6.6a1.9 1.9 0 0 1-1.9-1.9V5.8a1.9 1.9 0 0 1 1.9-1.9z" {...tint} opacity="0.16" />
    <path d="M6.6 3.9h7.1l4.7 4.7v11.5a1.9 1.9 0 0 1-1.9 1.9H6.6a1.9 1.9 0 0 1-1.9-1.9V5.8a1.9 1.9 0 0 1 1.9-1.9z" />
    <path d="M13.7 3.9V8.6h4.7" />
  </svg>
);

/** 帮助：圆形问号，用于「格式说明」这类就地提示入口（取代裸字符 ?） */
export const IconHelp = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9.2" {...tint} opacity="0.14" />
    <circle cx="12" cy="12" r="9.2" />
    <path d="M9.7 9.5a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .9-1 1.7v.3" strokeWidth={1.8} />
    <circle cx="12" cy="16.9" r="0.95" {...tint} opacity="1" />
  </svg>
);
