# 手机背诵同步（桌面 → 手机）

单词工坊生成短文后，在短文操作栏点 **手机背诵**，桌面会显示一次性的局域网二维码。

## 流程

1. 桌面把当前短文和取词快照序列化成 `knowlattice.recite/1` JSON。
2. Tauri 启动临时 HTTP 服务，绑定 `0.0.0.0` 的随机端口，二维码内容是：
   `http://<局域网 IP>:<端口>/import?token=<一次性 token>`
3. 手机和电脑连同一 Wi-Fi，用系统相机扫描二维码。
4. 手机浏览器打开落地页，自动跳转：
   `knowlattice-recite://import?src=<取包地址>`
5. 「晶格背诵」通过 `@capacitor/app` 收到深链，拉取 `/pack?token=...` 并导入。
6. 取包成功后 token 不能再取第二次；背诵包服务继续保留 60 分钟，等待手机回传复习记录。

## 复习记录回传（手机 → 桌面）

手机端导入背诵包时会记住本次取包地址（origin + token）。背完后在首页或结果页点
**回传复习记录**：

1. 手机把 `knowlattice.review/1`（全部复习事件）POST 到 `http://<电脑 IP>:<端口>/review?token=...`。
2. 桌面端校验 token 与包版本，把原始 JSON 通过 Tauri 事件 `recite-review` 发给前端。
3. 打开着的「手机背诵」面板收到事件后，按事件 id 去重，再按 `at` 顺序套用
   `nextRecord`，写回单词工坊的 FSRS 记录。
4. 写入后广播 `knowlattice-word-records-updated`，已经打开的单词工坊立即刷新队列、错词本与统计。
5. 事件时间早于该词本机 `lastReview` 的直接跳过，避免旧状态覆盖桌面更新的调度；
   手机时钟跑快时，事件时间最多按当前时间 + 5 分钟截断。

- 回传可以多次，桌面端按事件 id 幂等；手机端重复发送同一批事件不会重复计数。
- 服务只在面板打开期间存在；过期或面板关闭后回传会失败，重新生成二维码再回传即可
  （手机会继续保留本地事件）。
- 笔记包没有回传端点；`/review` 对 `knowlattice.notes/1` 返回 404，取包后服务照旧停止。

## 安全边界

- 只监听局域网临时端口，不经过云端。
- token 为随机值，只保存在本次进程内；二维码页面不放明文。
- 只提供 `/import`、`/pack`、`/review` 三个端点；其余返回 404。
- `/review` 只接受 `POST` 且请求体上限 4 MiB、事件上限 20000 条。
- 手机端只接受 `http://` 或 `https://` 取包地址，拒绝 `file:` 等协议。
- 首次使用需要在 Windows 防火墙允许应用访问专用网络。

## 章节笔记同步

章节目录的「⋯ → 发送到手机」打开笔记选择面板：

- 从 `vault.notePaths` 按标题/章节/路径搜索，勾选一篇或多篇。
- 生成 `knowlattice.notes/1` 包；正文由 desktop parser 去掉 frontmatter，标题与章节取自同一份解析结果。
- 手机端按 `path` 合并笔记，阅读页只读渲染 Markdown；本地附件图片暂不传输。
- 与短文同步共用同一套临时 HTTP 服务、一次性 token 和深链协议。

## 代码位置

- `src-tauri/src/recite_sync.rs`：一次性 HTTP 服务、token、落地页、回传端点。
- `src-tauri/src/lib.rs`：`start_recite_sync` / `stop_recite_sync` 命令与 `recite-review` 事件。
- `src/core/recitePack.ts`：桌面短文转手机包。
- `src/core/reciteReview.ts`：手机回传事件的解析、去重与 FSRS 合并。
- `src/views/ReciteSyncPanel.tsx`：二维码面板与回传状态。
- 手机端：`knowlattice-recite/src/core/sync.ts`、`android/app/src/main/AndroidManifest.xml`。

## 已知限制

- 手机端必须安装最新 APK（已注册 `knowlattice-recite` scheme）；PWA 无法接管自定义协议。
- 需要真实安卓手机验证系统相机对落地页跳转的处理；浏览器可能需要用户点一次「打开晶格背诵」。
- 二维码只包含当前勾选的短文，不包含桌面端的复习事件；手机回传依赖桌面面板保持打开。
