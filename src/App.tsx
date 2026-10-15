import { useEffect } from 'react';
import { autoUpdateOnStartup } from './core/updater';
import { loadUserSynonyms } from './core/medSynonyms';
import Workspace from './views/Workspace';

export default function App() {
  // 桌面版：启动 8 秒后静默检查更新，有新版本只提示（安装由用户在「关于与许可」面板手动触发，详见 core/updater.ts）
  useEffect(() => { autoUpdateOnStartup(); }, []);
  // 用户自定义等价词组（设置 → AI 助手维护）：进词表后搜索与教材检索立即生效
  useEffect(() => { loadUserSynonyms(); }, []);
  return <Workspace />;
}
