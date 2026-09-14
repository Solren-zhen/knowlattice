import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTooltips } from './core/tooltip'
import { initTheme, initFont } from './core/theme'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
