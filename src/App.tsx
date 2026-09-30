import { useEffect } from 'react';
import { autoUpdateOnStartup } from './core/updater';
import Workspace from './views/Workspace';

export default function App() {
  // 桌面版：启动 8 秒后静默检查更新，有新版本自动下载安装并重启（详见 core/updater.ts）
  useEffect(() => { autoUpdateOnStartup(); }, []);
  return <Workspace />;
}
