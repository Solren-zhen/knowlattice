KnowLattice 源代码(随离线包一同分发)
=====================================

本目录是 KnowLattice 的完整源代码。GPL-3.0 第 6 节规定:分发编译后的程序时,
必须同时提供对应的源代码——本目录就是该源码,你不需要另外向作者索取。

一、怎么跑起来
需要 Node.js 20 或更高版本,并需要能访问 npm 源(依赖需要联网安装一次)。
在本目录下执行:

    npm install
    npm run dev      # 开发模式,打开 http://localhost:5173
    npm run build    # 类型检查 + 打包,产物在 dist/
    npm test         # 单元测试

二、目录说明
src/                 应用本体(React + TypeScript)
scripts/             构建与打包脚本(含离线包打包器 scripts/pack.mjs)
package.json         依赖与命令
vite.config.ts       构建配置
tsconfig*.json       TypeScript 配置
index.html           入口页面

三、第三方数据放在哪
3D 解剖模型、脑图谱、tesseract 语言包等体积较大,不在本目录重复存放:
它们就在上一层的 app/ 里,随本包一起分发;在上游仓库中对应 public/ 目录。

四、许可
- LICENSE:本项目自有源代码的 GPL-3.0 许可(仅第 3 版)。
- THIRD-PARTY-NOTICES.md:随包第三方数据与依赖的各自条款,不受 GPL 覆盖。

你可以自由使用、修改、再分发本程序,但分发时必须一并提供源代码,且修改后的
版本也必须继续以 GPL-3.0 发布。
