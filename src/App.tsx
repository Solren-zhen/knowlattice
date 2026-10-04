import { useEffect } from 'react';
import { autoUpdateOnStartup } from './core/updater';
import Workspace from './views/Workspace';

export default function App() {
  // 桌面版：启动 8 秒后静默检查更新，有新版本只提示（安装由用户在「关于与许可」面板手动触发，详见 core/updater.ts）
  useEffect(() => { autoUpdateOnStartup(); }, []);
  return <Workspace />;
}
