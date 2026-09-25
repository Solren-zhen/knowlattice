/**
 * 图标系统：单层描边 + 同路径浅填充（currentColor）。
 *
 * 上一版把每个形状画两遍——一层淡填充 + 一层描边。20px 下那层淡填充就是一片灰，
 * 描边只有 1.4px 有效宽度，整条导航轨于是「一片毛边灰块」，而且各图标描边宽度从
 * 1.4 到 2.1 不等，同一排看不出是一套笔。现在：
 *
 *   1. 一个形状只画一条路径，体量感靠 fillOpacity，边缘因此永远是干净的；
 *   2. 全站统一 24 网格、1.75 描边、圆头圆角——只有勾号/箭头这类小记号用 2；
 *   3. 先认轮廓再认细节：20px 下能靠剪影分辨，内部细节不超过两道、间距不小于 3px。
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
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

/** 浅填充：与描边同路径，表达体量，不再叠第二层 */
const wash = { fill: 'currentColor', fillOpacity: 0.12 } as const;

/** 实心点/实心记号 */
const solid = { fill: 'currentColor', stroke: 'none' } as const;

/* ---------------------------------------------------------------- 导航轨 */

/** 目录：章节树（原先用「文件夹 + 向下箭头」，那是导出，不是目录） */
export const IconTree = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M4.6 4.2v15.6" />
    <rect x="8.4" y="5.4" width="11.4" height="5" rx="1.7" {...wash} />
    <path d="M8.4 14.4h11.4M8.4 18.2h7.4" strokeWidth={1.6} />
  </svg>
);

/** 医学通路：节点与连接箭头，作为通路绘图工具的导航入口图标 */
export const IconPathway = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M6.4 8.6 11 12M13.2 12l4.4-3.4M11 14.2l-2.8 4" strokeWidth={1.5} opacity="0.62" />
    <circle cx="5.1" cy="7.6" r="2.5" {...wash} />
    <circle cx="12" cy="13.1" r="2.5" {...wash} />
    <circle cx="18.9" cy="7.6" r="2.5" {...wash} />
    <path d="m16.9 5.9 2.1 1.7-2.1 1.7" strokeWidth={1.55} />
  </svg>
);

/** 搜索：放大镜（不填色，镜片留白才干净） */
export const IconSearch = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="10.6" cy="10.6" r="6.3" />
    <path d="m19.7 19.7-4.9-4.9" strokeWidth={2} />
  </svg>
);

/** 历史版本：时钟 + 回溯箭头（一圈完整的钟面 + 一只回撇，不再用两只角钩） */
export const IconHistory = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8" />
    <path d="M3.4 4.2v4.6h4.6" strokeWidth={2} />
    <path d="M12 7.8V12l3.1 1.9" strokeWidth={1.6} />
  </svg>
);

/** 解剖图谱：人体 + 断面线（原先的取景角框读成「扫描」，加一道横断面线才指明是「图谱/断层」） */
export const IconBody = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="5.6" r="2.9" {...wash} fillOpacity={0.14} />
    <path
      d="M6.2 21.2c0-4.1.9-6.9 2.4-8.5 1-1.1 2.1-1.6 3.4-1.6s2.4.5 3.4 1.6c1.5 1.6 2.4 4.4 2.4 8.5"
      {...wash} fillOpacity={0.1}
    />
    <path d="M4.4 14.4h15.2" strokeWidth={1.6} opacity="0.6" />
  </svg>
);

/** 脑图谱：大脑。
    这个形状是整套图标里唯一借来的几何——自己按 24 网格手搓的两版在 20px 下分别糊成
    「马克杯」和「药丸」，而大脑的沟回结构没有可简化的规则形状。此处采用 Tabler Icons
    的 brain 轮廓（MIT，见 THIRD-PARTY-NOTICES.md），描边宽度归入本项目的 1.75。 */
export const IconBrain = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M15.5 13a3.5 3.5 0 0 0-3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8" />
    <path d="M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1-7 0v-1.8" />
    <path d="M17.5 16a3.5 3.5 0 0 0 0-7h-.5" />
    <path d="M19 9.3V6.5a3.5 3.5 0 0 0-7 0" />
    <path d="M6.5 16a3.5 3.5 0 0 1 0-7h.5" />
    <path d="M5 9.3V6.5a3.5 3.5 0 0 1 7 0v10" />
  </svg>
);

/** 知识图谱：三节点互连 */
export const IconGraph = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M8.7 7.4 15 8.2M7.3 8.9l3.6 6.8M16.4 10.9l-3.2 5" strokeWidth={1.5} opacity="0.5" />
    <circle cx="6.2" cy="6.2" r="2.8" {...wash} fillOpacity={0.16} />
    <circle cx="17.8" cy="8.1" r="2.8" {...wash} fillOpacity={0.16} />
    <circle cx="12" cy="17.9" r="2.8" {...wash} fillOpacity={0.16} />
  </svg>
);

/** 间隔复习：两张叠放的记忆卡 */
export const IconCards = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M8.4 3.8h9.2c1.9 0 3.4 1.5 3.4 3.4v9.2" />
    <rect x="3.4" y="7.8" width="13" height="12.6" rx="3" {...wash} fillOpacity={0.12} />
  </svg>
);

/** 错题本：靶心 */
export const IconTarget = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8.4" {...wash} fillOpacity={0.1} />
    <circle cx="12" cy="12" r="4.4" strokeWidth={1.6} />
    <circle cx="12" cy="12" r="1.5" {...solid} />
  </svg>
);

/** 题库练习：答题卡（卡片 + 单选圈 + 两道题行） */
export const IconQuiz = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <rect x="4.4" y="3.4" width="15.2" height="17.2" rx="3.2" {...wash} fillOpacity={0.1} />
    <circle cx="8.9" cy="9" r="1.6" strokeWidth={1.6} />
    <circle cx="8.9" cy="9" r="0.6" {...solid} />
    <path d="M12.4 9h3.6M8 15h8" strokeWidth={1.6} />
  </svg>
);

/** 待办清单：勾选框 + 条目（不套外框，免得和题库那张卡片糊成同一个方框图标） */
export const IconTodo = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <rect x="3.4" y="4.8" width="6.6" height="6.6" rx="1.8" {...wash} />
    <path d="m5 8.2 1.6 1.7 2.6-2.9" strokeWidth={1.8} />
    <path d="M13 6.4h7.6M13 11.6h7.6" strokeWidth={1.6} />
    <path d="M5 16.6h15.6" strokeWidth={1.6} />
  </svg>
);

/** 标签：吊牌 */
export const IconTag = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path
      d="M11.6 3.6H19a1.4 1.4 0 0 1 1.4 1.4v7.4a2 2 0 0 1-.6 1.4l-6.6 6.6a1.4 1.4 0 0 1-2 0l-6.6-6.6a1.4 1.4 0 0 1 0-2l6.6-6.6a2 2 0 0 1 1.4-.6z"
      {...wash} fillOpacity={0.1}
    />
    <circle cx="15.6" cy="8.4" r="1.5" {...solid} />
  </svg>
);

/** 学习统计：柱状图（只画柱子与基线，不再套外框——外框会把它变成第四个「方框图标」） */
export const IconChart = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M3.8 20.4h16.4" />
    <path d="M7.4 20.4v-6.2M12 20.4V7.4M16.6 20.4v-9.2" strokeWidth={2} />
  </svg>
);

/** 番茄钟：表盘 + 指针 + 顶部小柄（剪影先认得出是计时器） */
export const IconTimer = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="13.6" r="7.6" {...wash} />
    <path d="M9.4 2.8h5.2M12 2.8v3.4" strokeWidth={2} />
    <path d="M12 13.6V9.4M12 13.6l3.1 1.9" />
  </svg>
);

/** 开始 */
export const IconPlay = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M8.4 5.4 18.6 12 8.4 18.6z" {...solid} />
  </svg>
);

/** 暂停 */
export const IconPause = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M9 5.6v12.8M15 5.6v12.8" strokeWidth={2.4} />
  </svg>
);

/** AI 助手：四角星光 + 伴星 */
export const IconAi = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M10.6 3.4 12.4 8.4 17.4 10.2 12.4 12 10.6 17 8.8 12 3.8 10.2 8.8 8.4z" {...wash} fillOpacity={0.16} />
    <path d="M17.8 14.6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" {...solid} opacity="0.75" />
  </svg>
);

/** 智能草稿：魔棒 + 一颗星（原先三处碎火星，20px 下只是噪点） */
export const IconWand = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M4.6 19.4 14 10" strokeWidth={2} />
    <path d="M15.4 8.6l2.2-2.2" strokeWidth={1.6} />
    <path d="M18.4 3.2l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z" {...solid} opacity="0.8" />
    <path d="M6.6 5.2v2.6M5.3 6.5h2.6" strokeWidth={1.6} />
  </svg>
);

/** PDF 对照：摊开的书（左右两页），与「单页 + 勾」的题库图标分得开 */
export const IconBook = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M12 7.2C10.3 5.6 7.9 5 5.5 5.4c-.6.1-1.1.6-1.1 1.2v10.8c0 .7.6 1.3 1.4 1.2 2-.3 4.1.2 5.6 1.5" {...wash} fillOpacity={0.1} />
    <path d="M12 7.2c1.7-1.6 4.1-2.2 6.5-1.8.6.1 1.1.6 1.1 1.2v10.8c0 .7-.6 1.3-1.4 1.2-2-.3-4.1.2-5.6 1.5" {...wash} fillOpacity={0.1} />
  </svg>
);

/** 格式转换：双向箭头（去掉外圈圆环——环会读成「刷新」） */
export const IconConvert = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M4.4 9.2h13.8" />
    <path d="m15.2 6.2 3 3-3 3" strokeWidth={2} />
    <path d="M19.6 14.8H5.8" />
    <path d="m8.8 11.8-3 3 3 3" strokeWidth={2} />
  </svg>
);

/** 主题切换：太阳 / 月亮 */
export const IconSun = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4" {...wash} fillOpacity={0.16} />
    <path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.4 5.4l1.9 1.9M16.7 16.7l1.9 1.9M18.6 5.4l-1.9 1.9M7.3 16.7l-1.9 1.9" strokeWidth={1.6} />
  </svg>
);
export const IconMoon = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8z" {...wash} fillOpacity={0.14} />
  </svg>
);

/* ---------------------------------------------------------------- 编辑器 / 面板 */

export const IconPlus = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" strokeWidth={2} />
  </svg>
);

/** 选项批注：铅笔（与「魔棒 = 智能草稿」分得开，不叠任何附加记号） */
export const IconPencil = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M16.8 3.2a2.8 2.8 0 0 1 3.9 3.9L8 19.8l-5.2 1.3 1.3-5.2z" {...wash} fillOpacity={0.1} />
  </svg>
);

export const IconBackup = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M20.4 15v3.2a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2V15" />
    <path d="M7.4 10.4 12 15l4.6-4.6M12 15V3.6" />
  </svg>
);

export const IconRestore = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M20.4 15v3.2a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2V15" />
    <path d="M7.4 8.6 12 4l4.6 4.6M12 4v11.4" />
  </svg>
);

export const IconTrash = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M6.6 6.8 7.5 19a2 2 0 0 0 2 1.9h5a2 2 0 0 0 2-1.9l.9-12.2" {...wash} fillOpacity={0.1} />
    <path d="M3.4 6.8h17.2M8.8 6.8V4.6a1.2 1.2 0 0 1 1.2-1.2h4a1.2 1.2 0 0 1 1.2 1.2v2.2" />
    <path d="M10.4 10.6v6M13.6 10.6v6" strokeWidth={1.6} />
  </svg>
);

export const IconSave = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" {...wash} fillOpacity={0.1} />
    <path d="M17 21v-8H7v8M7 3v5h8" strokeWidth={1.6} />
  </svg>
);

/** 实时预览开关：眼睛 */
export const IconEye = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M2.6 12S6.3 5.8 12 5.8 21.4 12 21.4 12 17.7 18.2 12 18.2 2.6 12 2.6 12z" {...wash} fillOpacity={0.1} />
    <circle cx="12" cy="12" r="2.7" {...wash} fillOpacity={0.35} />
  </svg>
);

/** 反链 / 双链关联：两段链环 */
export const IconLink = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M11.2 6.4l1.9-1.9a4.4 4.4 0 0 1 6.2 6.2l-1.9 1.9" />
    <path d="M12.8 17.6l-1.9 1.9a4.4 4.4 0 0 1-6.2-6.2l1.9-1.9" />
    <path d="M9.6 14.4 14.4 9.6" strokeWidth={2} />
  </svg>
);

/** 导出 md 文件夹：文件夹 + 向下箭头 */
export const IconFolder = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M3.5 7.4A2.4 2.4 0 0 1 5.9 5h3.4l2 2.4h6.8a2.4 2.4 0 0 1 2.4 2.4v7.8a2.4 2.4 0 0 1-2.4 2.4H5.9a2.4 2.4 0 0 1-2.4-2.4z" {...wash} fillOpacity={0.1} />
    <path d="M12 10.6v5.6M9.7 13.9 12 16.2l2.3-2.3" strokeWidth={1.6} />
  </svg>
);

/** 导入 md 文件夹：文件夹 + 进入箭头（原先与「导出」是同一组路径，箭头方向根本没反过来） */
export const IconFolderIn = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M3.5 7.4A2.4 2.4 0 0 1 5.9 5h3.4l2 2.4h6.8a2.4 2.4 0 0 1 2.4 2.4v7.8a2.4 2.4 0 0 1-2.4 2.4H5.9a2.4 2.4 0 0 1-2.4-2.4z" {...wash} fillOpacity={0.1} />
    <path d="M12 16.4v-5.6M9.7 13.1 12 10.8l2.3 2.3" strokeWidth={1.6} />
  </svg>
);

/** 更多操作：三个圆点 */
export const IconMore = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="5" cy="12" r="1.6" {...solid} />
    <circle cx="12" cy="12" r="1.6" {...solid} />
    <circle cx="19" cy="12" r="1.6" {...solid} />
  </svg>
);

export const IconBatch = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M8.4 6h12M8.4 12h12M8.4 18h12" />
    <path d="M3.6 6l1.4 1.4 2.1-2M3.6 12l1.4 1.4 2.1-2M3.6 18l1.4 1.4 2.1-2" strokeWidth={1.7} />
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

export const IconChevron = ({ size = 14, open }: P & { open?: boolean }) => (
  <svg {...base(size)} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 160ms cubic-bezier(0.16,1,0.3,1)' }}>
    <path d="m9 6 6 6-6 6" strokeWidth={2} />
  </svg>
);

/** 关闭：全站浮层统一的「退出/关闭」图形。
    此前 17 处直接用文字字符 ✕——字形宽度、笔画粗细与光学中心都随字体走，
    和这里的描边图标不是同一套笔。 */
export const IconClose = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M7 7 17 17M17 7 7 17" strokeWidth={2} />
  </svg>
);

/** 文件：PDF / Word 的选取入口（取代按钮里的 📄 emoji） */
export const IconFile = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M6.6 3.9h7.1l4.7 4.7v11.5a1.9 1.9 0 0 1-1.9 1.9H6.6a1.9 1.9 0 0 1-1.9-1.9V5.8a1.9 1.9 0 0 1 1.9-1.9z" {...wash} fillOpacity={0.1} />
    <path d="M13.7 3.9V8.6h4.7" strokeWidth={1.6} />
  </svg>
);

/** 帮助：圆形问号，用于「格式说明」这类就地提示入口（取代裸字符 ?） */
export const IconHelp = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8.8" {...wash} fillOpacity={0.1} />
    <path d="M9.8 9.6a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .9-1 1.7v.2" strokeWidth={1.7} />
    <circle cx="12" cy="16.8" r="1" {...solid} />
  </svg>
);

export const IconInfo = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8.2" {...wash} />
    <path d="M12 10.7v5.1M12 7.6v.2" strokeWidth={2} />
  </svg>
);
