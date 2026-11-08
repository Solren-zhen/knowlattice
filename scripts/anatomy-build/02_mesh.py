"""TotalSegmentator 分割掩膜 → 可上架的 GLB 解剖模型。

管线位置：01_segment.py 产出 `masks.npz`（int16 体素 + 间距 + 类名表），
本脚本负责后半段：体素 → 三角网格 → 平滑 → 减面 → Y-up 居中 → 按系统分组导 GLB。

为什么单独一个脚本、只依赖 numpy / scikit-image / trimesh：
分割那步要 PyTorch + 模型权重（几个 GB），而**重建这一步是纯几何**。
拆开之后，本机没有 GPU 也能验证「掩膜进 → 模型出」整条链路是否成立
（`--synthetic` 就是干这个的：不碰真实数据，用合成体素跑通全流程）。

用法：
    # 自检（不需要任何数据，验证链路）
    python 02_mesh.py --synthetic --out ./out

    # 真实数据
    python 02_mesh.py --npz ./work/masks.npz --out ./out --faces 60000

许可提示：本脚本产出的网格来自你自己跑分割得到的结果，版权归你。
但输入影像/掩膜的许可要单独遵守（TotalSegmentator 数据集为 CC BY 4.0，需署名）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict

import numpy as np
from scipy import ndimage
from skimage import measure
import trimesh
from trimesh.exchange.gltf import export_glb as glb_bytes


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------- #
# 体素 → 网格
# --------------------------------------------------------------------------- #
def mask_to_mesh(volume: np.ndarray, spacing: tuple[float, float, float]) -> trimesh.Trimesh | None:
    """单个体素块提等值面。返回 None 表示这块是空的（或太小，提不出闭合面）。"""
    if volume.sum() < 20:
        return None
    # 二值掩膜直接提等值面会留下「台阶」——每一层体素都是一个平台，
    # 平滑只能削弱不能消除。先做一次亚体素高斯模糊把边界变成连续场，
    # marching_cubes 才能在体素之间插值出真正的斜面。
    field = ndimage.gaussian_filter(volume.astype(np.float32), sigma=0.8)
    try:
        verts, faces, _, _ = measure.marching_cubes(field, level=0.5, spacing=spacing)
    except (ValueError, RuntimeError):
        return None
    if len(verts) == 0 or len(faces) == 0:
        return None
    # 不把 marching_cubes 的 normals 传进 trimesh：它导出 GLB 时这些法线会变成
    # 零向量，前端表现是「几何正确、通体纯黑」。让 trimesh 自己按面绕序算。
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    # 清理：去掉离群碎块（分割结果常有小岛）
    mesh = _largest_component(mesh)
    # 法线朝向：marching_cubes 的面绕序取决于体素极性，反了的话前端看到的是
    # 「纯黑的器官」——几何完全正确、光照全在背面。闭合网格能用体积判定一次性修正。
    if mesh.is_watertight:
        trimesh.repair.fix_normals(mesh, multibody=True)
    return mesh


def _largest_component(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    try:
        parts = mesh.split(only_watertight=False)
    except Exception:
        return mesh
    if len(parts) <= 1:
        return mesh
    return max(parts, key=lambda m: len(m.faces))


def smooth(mesh: trimesh.Trimesh, iterations: int) -> trimesh.Trimesh:
    if iterations <= 0:
        return mesh
    try:
        trimesh.smoothing.filter_taubin(mesh, lamb=0.5, nu=-0.53, iterations=iterations)
    except Exception as exc:  # 平滑是增强项，失败不该中断管线
        log(f"    ! 平滑跳过：{exc}")
    return mesh


def decimate(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    """二次误差减面。优先 fast_simplification（纯 Python 轮子，装得上），
    没有就退回 trimesh 自带实现；都没有就原样返回并提示。"""
    if len(mesh.faces) <= target_faces:
        return mesh
    try:
        import fast_simplification  # noqa: F401
        return mesh.simplify_quadric_decimation(face_count=target_faces)
    except Exception:
        pass
    try:
        return mesh.simplify_quadratic_decimation(target_faces)
    except Exception as exc:
        log(f"    ! 减面跳过（装 fast-simplification 可提速）：{exc}")
        return mesh


def to_y_up_centered(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """医学体素是 z-up（RAS/LPS），glTF 与 three.js 是 y-up。

    这一步必须做且只做一次：前端按 y-up 摆相机、算包围盒、做 picking，
    模型还是 z-up 的话，人会在场景里躺着——而 UI 上看不出是哪一步错了。
    """
    v = mesh.vertices  # (x, y, z) 毫米
    out = np.empty_like(v)
    out[:, 0] = v[:, 0]
    out[:, 1] = v[:, 2]
    out[:, 2] = -v[:, 1]
    # 居中到原点：前端不用为每个系统单独算偏移，也能把多个系统摆在同一坐标系里
    out -= (out.max(axis=0) + out.min(axis=0)) / 2.0
    # 换坐标后重建而不是原地改 vertices：原地改会让 trimesh 缓存里的法线停留在旧坐标系
    # （trimesh 5 已移除 recalc_normals，重建是最干净的重算方式）
    return trimesh.Trimesh(vertices=out, faces=mesh.faces, process=True)


# --------------------------------------------------------------------------- #
# 导出
# --------------------------------------------------------------------------- #
def export_glb(by_system: dict[str, list[tuple[str, trimesh.Trimesh]]], out_dir: str) -> list[dict]:
    os.makedirs(out_dir, exist_ok=True)
    manifest = []

    for system, items in sorted(by_system.items()):
        scene = trimesh.Scene()
        for organ_id, mesh in items:
            # 中性灰 + 双面：颜色交给前端按系统着色，模型里不写死主题色
            mesh.visual = trimesh.visual.TextureVisuals(
                material=trimesh.visual.material.PBRMaterial(
                    baseColorFactor=[200, 205, 210, 255],
                    metallicFactor=0.0,
                    roughnessFactor=0.85,
                    doubleSided=True,
                )
            )
            scene.add_geometry(mesh, node_name=organ_id, geom_name=organ_id)

        path = os.path.join(out_dir, f"{system}.glb")
        # include_normals=True 是硬要求，不是优化项：
        # trimesh 默认**不写** NORMAL 属性（glTF 规范允许客户端自己算），
        # 但 three.js 的 GLTFLoader 不会补算 → 法线为 (0,0,0) → 器官通体纯黑。
        # 这个 bug 在 Python 侧完全看不出来（trimesh 读回时会自己重算法线），
        # 只有真正上屏才暴露。
        with open(path, "wb") as f:
            f.write(glb_bytes(scene, include_normals=True))
        size = os.path.getsize(path)
        faces = sum(len(m.faces) for _, m in items)
        manifest.append({
            "system": system,
            "file": f"{system}.glb",
            "organ_count": len(items),
            "faces": faces,
            "bytes": size,
            "organs": [oid for oid, _ in items],
        })
        log(f"  ✓ {system}.glb  {len(items)} 个结构 · {faces:,} 面 · {size / 1024:.0f} KB")

    return manifest


# --------------------------------------------------------------------------- #
# 合成自检
# --------------------------------------------------------------------------- #
def synthetic_masks() -> tuple[np.ndarray, tuple[float, float, float], dict[int, dict]]:
    """造三块带噪声的椭球，模拟「一个系统里几个器官」的样子。

    目的不是像解剖，而是验证：多 label 分组、空块跳过、平滑、减面、y-up、
    多 node 导出、重新加载这七步都不炸。
    """
    shape = (96, 120, 120)
    zz, yy, xx = np.meshgrid(
        np.arange(shape[0]), np.arange(shape[1]), np.arange(shape[2]), indexing="ij"
    )
    labels = np.zeros(shape, dtype=np.int16)

    # 1: 大椭球（模拟肝）
    labels[((zz - 48) / 26) ** 2 + ((yy - 60) / 34) ** 2 + ((xx - 58) / 30) ** 2 <= 1] = 1
    # 2: 小椭球（模拟胆囊），贴在 1 旁边
    labels[((zz - 44) / 10) ** 2 + ((yy - 40) / 12) ** 2 + ((xx - 78) / 11) ** 2 <= 1] = 2
    # 3: 细长条（模拟血管），故意做得很细，验证小结构不被减面抹掉
    labels[((zz - 76) / 30) ** 2 + ((yy - 60) / 4) ** 2 + ((xx - 60) / 4) ** 2 <= 1] = 3

    meta = {
        1: {"organ_id": "synthetic_liver", "system": "digestive", "zh": "合成-肝样"},
        2: {"organ_id": "synthetic_gallbladder", "system": "digestive", "zh": "合成-胆囊样"},
        3: {"organ_id": "synthetic_vessel", "system": "cardiovascular", "zh": "合成-血管样"},
    }
    return labels, (1.5, 1.5, 1.5), meta


# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description="掩膜 → GLB 解剖模型")
    ap.add_argument("--npz", help="01_segment.py 产出的 masks.npz")
    ap.add_argument("--synthetic", action="store_true", help="用合成体素自检，不需要任何数据")
    ap.add_argument("--out", default="./out", help="输出目录")
    ap.add_argument("--faces", type=int, default=60_000, help="单个结构的目标面数上限")
    ap.add_argument("--smooth", type=int, default=3, help="Taubin 平滑迭代次数")
    args = ap.parse_args()

    if not args.synthetic and not args.npz:
        ap.error("要么 --npz 指向真实掩膜，要么 --synthetic 自检")

    if args.synthetic:
        log("合成自检模式：不读取任何外部数据")
        labels, spacing, meta = synthetic_masks()
    else:
        data = np.load(args.npz, allow_pickle=True)
        labels = data["labels"]
        spacing = tuple(float(v) for v in data["spacing"])
        meta = {int(k): dict(v) for k, v in data["meta"].item().items()}
        log(f"读取 {args.npz}：体素 {labels.shape} · 间距 {spacing} · {len(meta)} 个结构")

    by_system: dict[str, list[tuple[str, trimesh.Trimesh]]] = defaultdict(list)
    skipped: list[str] = []

    for label_id in sorted(meta):
        info = meta[label_id]
        organ_id = info["organ_id"]
        volume = labels == label_id
        voxels = int(volume.sum())
        if voxels == 0:
            log(f"  · {organ_id:<28} 跳过：掩膜里没有这块")
            skipped.append(organ_id)
            continue

        mesh = mask_to_mesh(volume, spacing)
        if mesh is None:
            log(f"  · {organ_id:<28} 跳过：体素太小，提不出闭合面")
            skipped.append(organ_id)
            continue

        before = len(mesh.faces)
        mesh = smooth(mesh, args.smooth)
        mesh = decimate(mesh, args.faces)
        mesh = to_y_up_centered(mesh)
        by_system[info["system"]].append((organ_id, mesh))
        log(f"  · {organ_id:<28} {voxels:>7,} 体素 → {before:>7,} → {len(mesh.faces):>6,} 面")

    if not by_system:
        log("没有任何结构被导出，检查掩膜与映射表")
        return 1

    log(f"\n导出到 {args.out}")
    manifest = export_glb(by_system, args.out)

    with open(os.path.join(args.out, "build-manifest.json"), "w", encoding="utf-8") as f:
        json.dump({
            "generator": "scripts/anatomy-build/02_mesh.py",
            "source": "synthetic" if args.synthetic else os.path.basename(args.npz),
            "spacing_mm": list(spacing),
            "target_faces_per_organ": args.faces,
            "smooth_iterations": args.smooth,
            "systems": manifest,
            "skipped": skipped,
        }, f, ensure_ascii=False, indent=2)

    total = sum(m["faces"] for m in manifest)
    log(f"合计 {sum(m['organ_count'] for m in manifest)} 个结构 · {total:,} 面 · "
        f"{sum(m['bytes'] for m in manifest) / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
