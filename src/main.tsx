import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './views/ErrorBoundary.tsx'
import { initTooltips } from './core/tooltip'
import { initTheme, initFont } from './core/theme'
import { initHighlight } from './core/highlight'
import { migrateLocalStorage, migrateIndexedDb } from './core/migrate'
import { initCardTilt } from './core/cardTilt'
import { initPressFeedback } from './core/pressFeedback'
import { initMotionChoreography } from './core/motionChoreography'
import { initNavIndicator } from './core/navIndicator'
import { initCountUp } from './core/countUp'
import { initHoverGlow } from './core/hoverGlow'
import { initSelectionGlide } from './core/selectionGlide'
import { initKnowledgeField } from './core/knowledgeField'
import { initLiquidGlass } from './core/liquidGlass'
import { setBiliProxyBase, setBiliProxyToken, setBiliProxyIssue } from './core/biliPlay'
import { isTauri } from './storage/tauriEnv'
import { tauriErrorText } from './storage/tauriError'
import { hydrateSecureApiKey } from './core/secureCredentials'
import { toast } from './core/feedback'

// 旧版 medvault-* 标识 → knowlattice-*：localStorage 同步迁移，须早于 initTheme / initFont。
migrateLocalStorage()
initTooltips()
initTheme()
initFont()

// 文本高亮色：与主题/字体并列，存在 localStorage；没存过就让 index.css 的默认红生效
initHighlight()

// 交互动效（第 1 / 6 / 8 项）：卡片指针倾斜与流光、按钮按压的释放回弹。
// 两者都是「document 级委托 + 开关」的单例，装一次即可；条件不满足时（系统要求
// 减少动态效果、纯触摸设备、html.no-motion）内部直接不工作，调用处不用判断。
initCardTilt()
initPressFeedback()
// 动效编排 v2：挂 html.motion-ready → 视口错峰显现 + 主按钮磁吸。
// 同样是「document 级委托 + 开关」单例：不允许动效时内部直接让位，调用处不用判断。
initMotionChoreography()
// 签名级交互：导航轨滑动的「墨迹」指示器 + 统计数字滚动。同样是开关式单例。
initNavIndicator()
initCountUp()
// 动效编排 v4：跟随式动效——指针跟光（hoverGlow）+ 选择滑动墨迹（selectionGlide）。
// 同样是开关式单例：不允许动效 / 无精确定位指针时内部直接让位，调用处不用判断。
initHoverGlow()
initSelectionGlide()
// 知识星图背景：Canvas 绘制的缓慢漂移节点网络（30fps 封顶）。
// 同样是开关式单例：减少动效 / 纯触摸设备时只画一帧静图，调用处不用判断。
initKnowledgeField()
// 液态玻璃折射：backdrop-filter 引用 SVG 位移滤镜，逐像素、较贵。
// 支持性 + 2s 帧率哨兵都在模块内部判断，调用处不用管。
initLiquidGlass()

// 注销已注册的 Service Worker：它会缓存旧资源、让浏览器一直读到旧版本。
// 这里只做注销，不注册 SW（要部署到 GitHub Pages 想离线/可安装时再开下面那段）。
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => void r.unregister());
  }).catch(() => { /* ignore */ });
}
// if (import.meta.env.PROD && 'serviceWorker' in navigator) {
//   window.addEventListener('load', () => {
//     void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((e) => {
//       console.warn('Service Worker 注册失败（不影响使用）：', e)
//     })
//   })
// }

// 安装版没有 Vite 的 /bili-proxy；让 Tauri 把本机代理端口与令牌交给前端。
// 失败不阻塞启动——视频笔记会显示取流错误，其余功能照常可用。
async function prepareBiliProxy(): Promise<void> {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const status = await invoke<{ ok: boolean; baseUrl: string; token: string; error: string }>('bili_proxy_status')
    setBiliProxyBase(status.ok ? status.baseUrl : '')
    setBiliProxyToken(status.ok ? status.token : '')
    setBiliProxyIssue(status.ok ? '' : (status.error || 'B 站代理未启动'))
  } catch (error) {
    setBiliProxyBase('')
    setBiliProxyToken('')
    setBiliProxyIssue(tauriErrorText(error))
  }
}

/** 超时兜底：任何一步挂住都不能让整个应用停在白屏（IDB 被别的标签页阻塞是最常见的一种）。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), ms) }),
  ])
}

async function bootstrap(): Promise<boolean> {
  const migrated = await withTimeout(migrateIndexedDb().then(() => true), 8000)
  await withTimeout(hydrateSecureApiKey(), 3000)
  await withTimeout(prepareBiliProxy(), 3000)
  return migrated === true
}

// IndexedDB 迁移须早于 vault / 历史 / PDF 首次打开新库，否则会读到空库；迁移失败也照常渲染。
// bootstrap 三步各自吞错、理论不会 reject，但挂载兜底不能少：宁可带着提示进入应用，也不白屏。
function mount() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* 兜住懒加载分块取不到（本地服务关掉后最容易发生）：没有它整棵树被卸载 → 白屏，
          用户只能看到控制台里那行 "Failed to fetch dynamically imported module"。 */}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}

void bootstrap()
  .then((migrated) => {
    mount()
    if (!migrated) {
      // 8 秒超时后应用已按现有数据渲染：此时迁移可能还没建出新库，视图层先 open 新库
      // 会让本轮迁移中断（旧库只在成功后删除、数据不会丢）。旧库数据会在**下次启动**
      // 重试迁移时补上，所以这里必须把「重启才会回来」说清楚，别让用户以为数据没了。
      setTimeout(() => {
        toast('本地数据迁移超时：本次会话可能暂时看不到旧版数据；重启应用会自动重试迁移，数据不会丢。', 'err', 10000)
      }, 800)
    }
  })
  .catch((error) => {
    mount()
    toast(`启动检查失败：${tauriErrorText(error)}`, 'err', 8000)
  })
