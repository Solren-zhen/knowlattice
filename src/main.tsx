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

// IndexedDB 迁移须早于 vault / 历史 / PDF 首次打开新库，否则会读到空库；迁移失败也照常渲染。
void migrateIndexedDb().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* 兜住懒加载分块取不到（本地服务关掉后最容易发生）：没有它整棵树被卸载 → 白屏，
          用户只能看到控制台里那行 "Failed to fetch dynamically imported module"。 */}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
})
