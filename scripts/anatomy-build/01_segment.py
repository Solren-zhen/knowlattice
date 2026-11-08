"""CT/MR → 分割掩膜（masks.npz）。管线第一步。

**这一步需要 GPU 与几 GB 的模型权重，不在轻量环境里跑。**
它和 02_mesh.py 刻意拆开：重建是纯几何，能在任何机器上验证；
只有分割需要深度学习环境。

许可（决定商业版能否用，别跳过）：
  - 代码与 `total` / `total_mr` 任务权重：Apache-2.0，"Openly available for any usage"
    https://github.com/wasserth/TotalSegmentator
  - 其余任务（heartchambers_highres / tissue_types / brain_structures …）需单独申请商业许可，
    brain_aneurysm 是 CC BY-NC 4.0 且无商业许可 —— 见 labels.BLOCKED，一律不用。
  - 输入影像：若用 TotalSegmentator 公开数据集（Zenodo 22688904，CC BY 4.0），
    产出物需在 THIRD-PARTY-NOTICES 里署名 Wasserthal et al.。用自己的/已授权的影像则不受此限。

安装（独立 venv，别污染项目环境）：
    python -m venv .venv-anatomy
    .venv-anatomy/Scripts/pip install torch --index-url https://download.pytorch.org/whl/cu121
    .venv-anatomy/Scripts/pip install TotalSegmentator SimpleITK nibabel numpy

用法：
    # 单例
    python 01_segment.py --input ./data/case01.nii.gz --out ./work/case01
    # DICOM 目录（会先转 nii）
    python 01_segment.py --input ./data/case01_dicom --out ./work/case01
    # 只看会用到哪些类，不跑分割
    python 01_segment.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labels as L  # noqa: E402


def to_nifti(src: str, dst: str) -> str:
    """DICOM 目录 → nii.gz。已是 nii 就原样返回。"""
    if src.endswith((".nii", ".nii.gz")):
        return src
    import SimpleITK as sitk  # 只有这条分支才需要

    reader = sitk.ImageSeriesReader()
    series = reader.GetGDCMSeriesFileNames(src)
    if not series:
        raise SystemExit(f"{src} 里找不到 DICOM 序列")
    reader.SetFileNames(series)
    sitk.WriteImage(reader.Execute(), dst)
    return dst


def run_totalsegmentator(nii: str, out_dir: str, task: str = "total", fast: bool = False) -> str:
    """调 TotalSegmentator，输出 multilabel 掩膜（一个文件里每个类一个整数值）。"""
    cmd = [
        sys.executable, "-m", "totalsegmentator",
        "-i", nii,
        "-o", out_dir,
        "--task", task,
        "--ml",              # multilabel：单文件、值即类号，省掉几十个 nii 的 I/O
        "--quiet",
    ]
    if fast:
        cmd.append("--fast")  # 低分辨率，只用于快速验证管线通不通
    print("运行：", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    ml = os.path.join(out_dir, "multilabel.nii.gz")
    if not os.path.exists(ml):
        raise SystemExit(f"没找到 {ml}，检查 TotalSegmentator 输出目录")
    return ml


def main() -> int:
    ap = argparse.ArgumentParser(description="CT/MR → masks.npz")
    ap.add_argument("--input", help="nii.gz / DICOM 目录")
    ap.add_argument("--out", default="./work/case01", help="工作目录")
    ap.add_argument("--task", default="total", choices=["total", "total_mr"])
    ap.add_argument("--fast", action="store_true", help="低分辨率快跑（验证管线用）")
    ap.add_argument("--dry-run", action="store_true", help="只打印映射表与许可状态")
    args = ap.parse_args()

    if args.dry_run:
        print(f"将使用 {len(L.LABELS)} 个类，覆盖系统：")
        by_sys: dict[str, int] = {}
        for _ts, (_oid, sysname, _zh) in L.LABELS.items():
            by_sys[sysname] = by_sys.get(sysname, 0) + 1
        for s in L.SYSTEM_ORDER:
            if s in by_sys:
                print(f"  {s:<16} {by_sys[s]:>3} 个")
        print("\n禁用类（许可不允许商业使用）：")
        for k, why in L.BLOCKED.items():
            print(f"  {k:<26} {why}")
        return 0

    if not args.input:
        ap.error("--input 必填（或用 --dry-run）")

    os.makedirs(args.out, exist_ok=True)
    nii = to_nifti(args.input, os.path.join(args.out, "input.nii.gz"))
    ml_path = run_totalsegmentator(nii, os.path.join(args.out, "segmentations"), args.task, args.fast)

    import nibabel as nib

    img = nib.load(ml_path)
    arr = np.asarray(img.dataobj).astype(np.int16)
    spacing = tuple(float(v) for v in img.header.get_zooms()[:3])

    # TotalSegmentator 的 multilabel 里，类号 = 该任务类列表中的下标 + 1
    # 用它的 map_to_binary 拿顺序，避免手抄
    try:
        from totalsegmentator.map_to_binary import class_map
        names = class_map[args.task]
    except Exception as exc:
        raise SystemExit(f"取不到 {args.task} 的类名表：{exc}")

    meta: dict[int, dict] = {}
    unknown: list[str] = []
    for i, cls in enumerate(names):
        label_id = i + 1
        hit = L.resolve(cls)
        if hit is None:
            if (arr == label_id).any():
                unknown.append(cls)
            continue
        organ_id, system, zh = hit
        meta[label_id] = {
            "organ_id": organ_id, "system": system, "zh": zh, "ts_class": cls, "name_en": cls,
        }

    out_npz = os.path.join(args.out, "masks.npz")
    np.savez_compressed(out_npz, labels=arr, spacing=np.array(spacing), meta=np.array(meta, dtype=object))

    present = sum(1 for k in meta if (arr == k).any())
    print(f"\n写出 {out_npz}")
    print(f"  体素 {arr.shape} · 间距 {spacing}")
    print(f"  映射 {len(meta)} 类，实际出现 {present} 类")
    if unknown:
        print(f"  未映射但有内容的类（需在 labels.py 里补）：{', '.join(unknown)}")

    with open(os.path.join(args.out, "segment-report.json"), "w", encoding="utf-8") as f:
        json.dump({"spacing": spacing, "mapped": len(meta), "present": present, "unmapped_present": unknown}, f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
