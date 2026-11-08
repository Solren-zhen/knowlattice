"""GLB 资产 → 前端要的 manifest 与中文名字典。管线最后一步。

前端的契约在 `src/core/anatomy.ts`，别改格式：
  manifest.json  { version, gender_model, attribution, credit, license,
                   systems: [{ system, organ_count, load_on_start }],
                   organs:  [{ organ_id, ta2_latin, name_en, system, mesh_file, node, path }] }
  zh-organs-a…h.json  { "<英文名>": "<中文名>" }   ← 八片并行加载，按英文名首字母分桶

输出到 `out/anatomy/`，**不直接覆盖 public/anatomy**：
换资产是破坏性操作，先让人看一眼、跑一次 dev、确认没问题再替换。

用法：
    python 03_manifest.py --build ./out --out ./out/anatomy
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import trimesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labels as L  # noqa: E402

ZH_SLICES = list("abcdefgh")


def slice_of(name: str) -> str:
    first = name[:1].lower()
    return first if first in ZH_SLICES else "h"


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 manifest.json 与中文名字典")
    ap.add_argument("--build", default="./out", help="02_mesh.py 的输出目录")
    ap.add_argument("--out", default="./out/anatomy", help="manifest 输出目录")
    ap.add_argument("--credit", default="自建资产：TotalSegmentator（Apache-2.0）分割 + 自有重建管线",
                    help="写进 manifest.attribution 的来源说明")
    args = ap.parse_args()

    build_path = os.path.join(args.build, "build-manifest.json")
    if not os.path.exists(build_path):
        raise SystemExit(f"找不到 {build_path}，先跑 02_mesh.py")
    build = json.load(open(build_path, encoding="utf-8"))

    os.makedirs(args.out, exist_ok=True)

    # 反查：organ_id → (ts_class, system, zh)
    by_organ = {}
    for ts_class, (organ_id, system, zh) in L.LABELS.items():
        by_organ[organ_id] = {"name_en": ts_class, "system": system, "zh": zh}

    systems, organs, zh_map = [], [], {}
    problems: list[str] = []

    for s in build["systems"]:
        glb = os.path.join(args.build, s["file"])
        scene = trimesh.load(glb)
        nodes = set(scene.geometry.keys())

        for organ_id in s["organs"]:
            if organ_id not in nodes:
                problems.append(f"{s['file']} 里没有 node：{organ_id}")
                continue
            info = by_organ.get(organ_id)
            if info is None:
                # 合成自检的产物没有映射，跳过而不是崩掉
                problems.append(f"labels.py 里没有 organ_id：{organ_id}")
                continue
            organs.append({
                "organ_id": organ_id,
                "ta2_latin": "",          # 拉丁名不做自动翻译：宁可为空，也不要编一个错的
                "name_en": info["name_en"],
                "system": info["system"],
                "mesh_file": s["file"],
                "node": organ_id,          # 02 导出时 node 名就是 organ_id
                "path": [s["system"]],
            })
            zh_map[info["name_en"]] = info["zh"]

        systems.append({
            "system": s["system"],
            "organ_count": len([o for o in organs if o["system"] == s["system"]]),
            "load_on_start": False,
        })

    manifest = {
        "version": 2,
        "gender_model": "male",
        "attribution": args.credit,
        "credit": "KnowLattice anatomy pipeline",
        # 自有资产：不再是 CC BY-SA。前端只展示，不参与分发判断
        "license": "Proprietary",
        "systems": [s for s in sorted(systems, key=lambda x: L.SYSTEM_ORDER.index(x["system"])
                                      if x["system"] in L.SYSTEM_ORDER else 99)],
        "organs": organs,
    }

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    buckets: dict[str, dict[str, str]] = {k: {} for k in ZH_SLICES}
    for en, zh in zh_map.items():
        buckets[slice_of(en)][en] = zh
    for key, bucket in buckets.items():
        with open(os.path.join(args.out, f"zh-organs-{key}.json"), "w", encoding="utf-8") as f:
            json.dump(dict(sorted(bucket.items())), f, ensure_ascii=False, indent=2)

    print(f"写出 {args.out}/manifest.json")
    print(f"  {len(systems)} 个系统 · {len(organs)} 个结构 · 中文名 {len(zh_map)} 条")
    for s in manifest["systems"]:
        print(f"    {s['system']:<16} {s['organ_count']:>3}")

    if problems:
        print("\n需要处理：")
        for p in problems[:20]:
            print("  ·", p)
        if len(problems) > 20:
            print(f"  …另有 {len(problems) - 20} 条")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
