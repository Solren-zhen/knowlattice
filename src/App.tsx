import { useEffect } from 'react';
import { autoUpdateOnStartup } from './core/updater';
import { loadUserSynonyms } from './core/medSynonyms';
import Workspace from './views/Workspace';
import UpdateNotice from './views/UpdateNotice';

export default function App() {
  // 桌面版：启动 8 秒后自动检查更新；发现新版本时右下角更新卡片亮起，由用户点一次即安装并重启。
  // （边界与理由见 core/updater.ts 顶部：不静默下载安装，也不静默替换正在运行的程序。）
  useEffect(() => { autoUpdateOnStartup(); }, []);
  // 用户自定义等价词组（设置 → AI 助手维护）：进词表后搜索与教材检索立即生效
  useEffect(() => { loadUserSynonyms(); }, []);
  return (
    <>
      <Workspace />
      <UpdateNotice />
    </>
  );
}
