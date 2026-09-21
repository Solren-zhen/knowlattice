import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './views/ErrorBoundary.tsx'
import { initTooltips } from './core/tooltip'
import { initTheme, initFont } from './core/theme'
import { migrateLocalStorage, migrateIndexedDb } from './core/migrate'

// 旧版 medvault-* 标识 → knowlattice-*：localStorage 同步迁移，须早于 initTheme / initFont。
migrateLocalStorage()
initTooltips()
initTheme()
initFont()

// 注销早期版本注册的 Service Worker：旧版 SW 会缓存旧资源、让浏览器一直读到旧版本。
// 只保留这次注销；新版不再注册 SW（要部署到 GitHub Pages 想离线/可安装时再开下面那段）。
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
