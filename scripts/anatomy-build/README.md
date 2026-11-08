# anatomy-build · 自建 3D 解剖资产管线

替换 `public/anatomy/` 里那套 **CC BY-SA 4.0** 模型（BodyParts3D → Z-Anatomy → Anatria3D）。
目标：产出**版权归自己、可闭源商用**的模型，只受数据集的 CC BY 4.0 署名约束。

## 为什么自己建

现成模型全部卡在 ShareAlike 上：

| 来源 | 许可 | 商业闭源 |
|---|---|---|
| BodyParts3D (DBCLS) | CC BY-SA 2.1 JP | ✗ |
| Z-Anatomy | CC BY-SA 4.0 | ✗ |
| Anatria-3D | CC BY-SA 4.0 | ✗ |
| Innerscene 3D Library | CC0 | ✓ 但只有零星几个器官，覆盖不了 |
| Sketchfab CC0 解剖模型 | CC0 | ✓ 但多为单体器官、拓扑不统一、无法成套 |

而"照着原模型重建"不解决问题——描摹/减面/重拓扑仍是衍生作品。

**唯一干净的路径：从医学影像重建。**器官形状是自然事实，不受版权保护；
从影像分割出的几何是你自己的产出。

## 三段管线

```
01_segment.py  ──→  02_mesh.py  ──→  03_manifest.py
  CT/MR → 掩膜        掩膜 → GLB          GLB → manifest + 中文名
  （需 GPU）         （纯几何，可离线）    （对齐前端契约）
```

| 脚本 | 输入 | 输出 | 本机验证 |
|---|---|---|---|
| `01_segment.py` | nii.gz / DICOM 目录 | `masks.npz` | ❌ 需要 torch + GPU |
| `02_mesh.py` | `masks.npz` 或 `--synthetic` | `out/<system>.glb` | ✅ 合成数据全流程跑通 |
| `03_manifest.py` | `out/build-manifest.json` | `manifest.json` + `zh-organs-a…h.json` | ✅ 跑通（合成数据会报"未映射"，属预期） |

## 跑起来

```bash
# 0) 建环境（独立 venv，别装进项目）
python -m venv .venv-anatomy
.venv-anatomy/Scripts/pip install numpy scipy scikit-image trimesh fast-simplification
#   分割那步额外需要：
#   .venv-anatomy/Scripts/pip install torch --index-url https://download.pytorch.org/whl/cu121
#   .venv-anatomy/Scripts/pip install TotalSegmentator SimpleITK nibabel

# 1) 自检：不需要任何数据，验证「掩膜进 → 模型出」
python 02_mesh.py --synthetic --out ./out
python 03_manifest.py --build ./out --out ./out/anatomy

# 2) 看效果（起个静态服务，浏览器打开 preview.html）
python -m http.server 8099
#   → http://localhost:8099/preview.html

# 3) 真实数据
python 01_segment.py --input ./data/case01.nii.gz --out ./work/case01
python 02_mesh.py --npz ./work/case01/masks.npz --out ./out --faces 60000

# 4) 生成前端契约，人眼确认后再替换 public/anatomy/
python 03_manifest.py --build ./out --out ./out/anatomy
```

`preview.html` 刻意**不**在前端补算法线——它的用途就是检验 GLB 自带法线是否可用。
补算会把这个缺陷藏起来（见下面的坑 1）。

## 三个真踩过的坑

**1. trimesh 默认不导 NORMAL → 器官通体纯黑**

`scene.export()` 写出的 GLB 只有 `POSITION`。glTF 规范允许这样（客户端可自行计算），
但 three.js 的 `GLTFLoader` 不补算，PBR 拿到零向量法线，结果是**几何完美、颜色全黑**。
更阴的是：Python 侧读回来一切正常——trimesh 读 GLB 时会自己重算法线，把问题盖住。
只有真正上屏才暴露。

修复：`export_glb(scene, include_normals=True)`。

**2. 二值掩膜直接提等值面 → 台阶**

体素是「层」，每层一个平台；`marching_cubes` 在 0.5 等值面上取出的是阶梯面，
Taubin 平滑只能削弱不能消除。先做 `gaussian_filter(sigma=0.8)` 把边界变成连续场，
等值面才会落在体素之间，得到真正的斜面。

**3. 坐标轴：z-up → y-up 必须显式转**

医学影像（RAS/LPS）是 z 轴向上，glTF/three.js 是 y 轴向上。
不转的话模型在场景里是"躺着"的，而 UI 上看不出是哪一步错了。
转完必须**重建** mesh（而不是原地改 `vertices`）：trimesh 5 已移除 `recalc_normals`，
原地改会让缓存法线停留在旧坐标系。

## 许可

- **代码**：本目录脚本随项目（GPL-3.0）。
- **工具**：TotalSegmentator 代码与 `total` / `total_mr` 权重 = Apache-2.0，
  官方措辞 "Openly available for any usage"。其余任务需单独申请商业许可，
  `brain_aneurysm` 为 CC BY-NC 4.0 且无商业许可——见 `labels.BLOCKED`，一律不用。
- **数据**：若用 TotalSegmentator 公开数据集（Zenodo 22688904，CC BY 4.0），
  产出物需署名 Wasserthal et al.；用自有/已授权影像则不受此限。
- **产出**：你自己跑出来的网格，版权归你。

## 现状

`02_mesh.py` 与 `03_manifest.py` 已在合成数据上端到端验证：
3 个结构 → 2 个 GLB → 浏览器 WebGL 正常渲染（法线、平滑、坐标系都对）。

`01_segment.py` **未在本机验证**（没有 torch/GPU）。它按 TotalSegmentator 的
CLI 与 `map_to_binary.class_map` 接口写成，第一次跑真数据时请先 `--fast` 小步试。
