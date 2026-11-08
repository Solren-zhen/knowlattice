/**
 * 运行环境能力表：把「这个功能在当前环境能不能用、不能用时走哪条路」
 * 从各处的 `if (window.xxx)` 收成一张可渲染的清单。
 *
 * 没有哪项能力是必须的；降级路径写清楚，用户才知道为什么按钮不见了。
 * 纯函数 + 可注入 scope，测试里不用碰真实 navigator。
 */

export type FeatureId =
  | 'filePicker'
  | 'notification'
  | 'speech'
  | 'decompression'
  | 'serviceWorker'
  | 'idbPersist'
  | 'share'
  | 'clipboard';

export interface SupportEnv {
  showOpenFilePicker?: unknown;
  showSaveFilePicker?: unknown;
  notification?: unknown;
  notificationPermission?: unknown;
  speechSynthesis?: unknown;
  DecompressionStream?: unknown;
  serviceWorker?: unknown;
  storagePersist?: unknown;
  share?: unknown;
  clipboardWrite?: unknown;
}

export interface FeatureSupport {
  id: FeatureId;
  label: string;
  supported: boolean;
  /** 不支持时走哪条路 */
  fallback: string;
  /** 支持时也要说清的边界 */
  note?: string;
}

const has = (value: unknown): boolean => value !== undefined && value !== null;

/** 从 globalThis / 注入的 scope 里取能力位。 */
export function detectEnvironment(scope: unknown = typeof globalThis === 'undefined' ? {} : globalThis): SupportEnv {
  const root = scope as Record<string, unknown>;
  const nav = (root.navigator ?? {}) as Record<string, unknown>;
  const win = (root.window ?? root) as Record<string, unknown>;
  return {
    showOpenFilePicker: win.showOpenFilePicker,
    showSaveFilePicker: win.showSaveFilePicker,
    notification: root.Notification,
    notificationPermission: (root.Notification as { requestPermission?: unknown } | undefined)?.requestPermission,
    speechSynthesis: win.speechSynthesis ?? root.speechSynthesis,
    DecompressionStream: root.DecompressionStream,
    serviceWorker: nav.serviceWorker,
    storagePersist: (nav.storage as { persist?: unknown } | undefined)?.persist,
    share: nav.share,
    clipboardWrite: nav.clipboard ? (nav.clipboard as { writeText?: unknown }).writeText : undefined,
  };
}

export function supportTable(env: SupportEnv): FeatureSupport[] {
  return [
    {
      id: 'filePicker',
      label: '文件选择 / 保存（File System Access）',
      supported: has(env.showOpenFilePicker) || has(env.showSaveFilePicker),
      fallback: '退回 <input type="file"> 选择 + 下载链接导出',
      note: '支持时也只在用户手势里调用；部分系统需要重新授权',
    },
    {
      id: 'notification',
      label: '桌面通知',
      supported: has(env.notification) && has(env.notificationPermission),
      fallback: '改用应用内提醒与待办角标',
    },
    {
      id: 'speech',
      label: '语音朗读（SpeechSynthesis）',
      supported: has(env.speechSynthesis),
      fallback: '隐藏朗读按钮，只显示文本',
    },
    {
      id: 'decompression',
      label: '流式解压（DecompressionStream）',
      supported: has(env.DecompressionStream),
      fallback: '内容包仍可下载，但不在浏览器内解压',
    },
    {
      id: 'serviceWorker',
      label: '离线缓存（Service Worker）',
      supported: has(env.serviceWorker),
      fallback: '纯在线使用；已打开的页面不受影响',
      note: 'HTTPS 或 localhost 才可用；注册失败不影响主体功能',
    },
    {
      id: 'idbPersist',
      label: '存储不被系统清理（persist）',
      supported: has(env.storagePersist),
      fallback: '浏览器空间紧张时可能清理 IndexedDB；请定期备份',
      note: '申请也不保证授予',
    },
    {
      id: 'share',
      label: '系统分享（Web Share）',
      supported: has(env.share),
      fallback: '退回复制链接 / 复制 Markdown',
    },
    {
      id: 'clipboard',
      label: '剪贴板写入',
      supported: has(env.clipboardWrite),
      fallback: '退回选中文本后手动复制',
    },
  ];
}

export function unsupportedFeatures(env: SupportEnv): FeatureSupport[] {
  return supportTable(env).filter((item) => !item.supported);
}

export type PersistState = 'granted' | 'denied' | 'unsupported';

/** 申请持久化；没有 API 返回 unsupported，不抛。 */
export async function requestPersistence(env: SupportEnv): Promise<PersistState> {
  if (typeof env.storagePersist !== 'function') return 'unsupported';
  try {
    const granted = await (env.storagePersist as () => Promise<boolean>).call(env);
    return granted ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** 一条给横幅用的文案；全支持返回 null。 */
export function degradationMessage(env: SupportEnv): string | null {
  const missing = unsupportedFeatures(env);
  if (!missing.length) return null;
  return `当前环境有 ${missing.length} 项能力不可用：${missing.map((item) => item.label).join('、')}。已自动走降级路径。`;
}
