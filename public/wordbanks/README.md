# 单词工坊词库（第三方数据）

这些 JSON 由 **zyronon/TypeWords** 的词库数据转换而来，供「学习 → 单词工坊」按需下载。

| 文件 | 词库 | 条数 | 原始文件 |
|---|---|---|---|
| `cet6.json` | CET-6 | 2345 | `CET6_T.json` |
| `kaoyan.json` | 考研 | 3725 | `KaoYan_3_T.json` |

- 上游仓库：<https://github.com/zyronon/TypeWords>（**GPL-3.0**）
- 词表资源主机：<https://files.typewords.cc/dicts/en/word/>
- 抓取时间：2026-11-04

## 字段

```json
{
  "id": "cet6",
  "name": "CET-6",
  "count": 2345,
  "source": "zyronon/TypeWords (GPL-3.0)",
  "words": [{ "en": "cancel", "zh": "v. 取消…；n. 撤销…", "ipa": "/ˈkæns(ə)l/", "example": "…", "origin": "…" }]
}
```

只保留释义、音标、例句、词源四项，释义截断到 60 字、例句 110 字、词源 42 字，避免单个词条过长影响卡片排版。

## 许可证提醒

上游按 **GPL-3.0** 发布。把它的释义/例句/词源数据直接打包进本项目再分发时，需要自行确认与 GPL-3.0 的兼容性并按许可证要求署名。本目录保留 `source` / `resource` 字段作为溯源信息。
