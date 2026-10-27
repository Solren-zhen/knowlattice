# 医考素材归档（med-archive）

**这里现在只剩下工具。** 素材原件已经搬到仓库外：`C:\Users\甄朝晖\Desktop\晶格个人资料\`
（原安装包、解包副本、影像图集、手写笔记都在那边，理由与清单见那个目录的 README）。

放进仓库的东西等于「会被分发的东西」——别人的安装包和扫描件留在仓库里，迟早跟着代码一起出去。
所以这条边界定死：**仓库只留怎么重建，不留重建出来的原件。**

```
med-archive/
├─ tools/
│  ├─ unpack.sh       重建解包副本的入口（读 01-原始安装包/，写 02-解包副本/）
│  └─ unpack.py       抽取逻辑（python zipfile；Git Bash 里没有 unzip，且只抽需要的段）
└─ README.md
```

## 重建

```bash
bash med-archive/tools/unpack.sh                          # 重建到 ~/Desktop/晶格个人资料/02-解包副本
bash med-archive/tools/unpack.sh /c/tmp/x                  # 解到别处做比对
JINGGE_DATA=/d/mydata bash med-archive/tools/unpack.sh    # 换归档根
```

`02-解包副本/` 的目录名与层级是照 `content-packs/tools/build_packs.py --src` 的期望排的，
所以导出时不用额外参数：`--src "C:\Users\甄朝晖\Desktop\晶格个人资料\02-解包副本"`。

## 归档里是什么（体积与来源）

| 目录 | 内容 | 体积 |
|---|---|---|
| `01-原始安装包/` | 万川医考_v1.22 / 窦起心搏_离线版_v2.48 / 刷题宝 / 医不帮_2.0.2 | 97 MB |
| `02-解包副本/` | `wcwww/`（万川 assets/www 120 MB）、`db/`（窦起心搏 assets/pack 67 MB）、`st/`（刷题宝 initial_libraries.json 11 MB）、`yb/`（医不帮 lib/）、`yjt/`（医记通 app.so + flutter_assets 24 MB） | 237 MB |
| `03-影像图集/` | 图集配套题 + 603 张图的键→地址表 | 1.3 MB |
| `04-手写笔记/` | 目录与链接表 | 240 KB |

解包副本里的题库量：万川 116,088 题 / 101 个题库；窦起心搏 21,707 题 / 22 套卷；刷题宝 21,083 题 / 204 个库；医不帮 0（题库在服务端）。

安装包 sha256（前 16 位，可用于确认归档没被动过）：万川 `f115b4a199e3de31`、窦起心搏 `c953ca1526b11166`、
刷题宝 `1f9e7d97f1504ba6`、医不帮 `6c07822f705b6bb7`；医记通 `app.so` 为 `6ab075538edde6a2`。

## 与软件的关系

题目内容包（`content-packs/out/`）是导出产物、也是软件导入的数据，仍在仓库里；它属于「个人学习资料」，
是否对外分享由你自己判断。影像图集与手写笔记 PDF 不进软件——扫描件换名字还是同一份扫描件。
