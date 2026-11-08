"""TotalSegmentator 类别 → 本项目的 (organ_id, system, 中文名)。

约定与 `public/anatomy/manifest.json` 一致：
  - `organ_id` 小写下划线，左右成对的用 `_l` / `_r` 后缀；
  - `system` 用项目现有的 12 个系统名（见 SYSTEM_ORDER）。

只登记 `total` / `total_mr` 这两个 **Apache-2.0** 任务输出的类名。
需要单独申请的类（heartchambers_highres / tissue_types / brain_structures 等）
和 CC BY-NC 的 brain_aneurysm 一律不在此表——商业版不能用它们生成资产。

覆盖现实（对着项目现有 3478 个结构看）：
  ✅ 内脏、主要骨骼、大血管、心、肺、肝脾肾胰胆、甲状腺/肾上腺
  ⚠️ 骨骼只到 59 块（椎骨/肋骨/四肢长骨），现有 skeletal 有 335 项，其余细分骨没有
  ⚠️ 肌肉只有 2 组（autochthon / iliopsoas），现有 muscular 有 1110 项
  ⚠️ 血管只有 8 条主干，现有 cardiovascular 有 640 项
  ❌ 神经、淋巴、关节软骨/韧带：CT 分割不出来，需要 MR 或专门数据
"""

# 系统名 → 前端展示顺序（与 railCatalog / anatomy.ts 的 systems 顺序保持一致）
SYSTEM_ORDER = [
    "skeletal", "muscular", "articular", "cardiovascular", "nervous",
    "digestive", "respiratory", "renal", "reproductive", "endocrine",
    "lymphatic", "regional",
]

# ts_class: (organ_id, system, 中文名)
LABELS: dict[str, tuple[str, str, str]] = {
    # ---------------- 消化 ----------------
    "liver": ("liver", "digestive", "肝"),
    "gallbladder": ("gallbladder", "digestive", "胆囊"),
    "spleen": ("spleen", "digestive", "脾"),
    "stomach": ("stomach", "digestive", "胃"),
    "pancreas": ("pancreas", "digestive", "胰腺"),
    "esophagus": ("esophagus", "digestive", "食管"),
    "small_bowel": ("small_intestine", "digestive", "小肠"),
    "duodenum": ("duodenum", "digestive", "十二指肠"),
    "colon": ("colon", "digestive", "结肠"),

    # ---------------- 泌尿 ----------------
    "kidney_left": ("kidney_l", "renal", "左肾"),
    "kidney_right": ("kidney_r", "renal", "右肾"),
    "urinary_bladder": ("urinary_bladder", "renal", "膀胱"),

    # ---------------- 呼吸 ----------------
    "lung_upper_lobe_left": ("lung_upper_lobe_l", "respiratory", "左肺上叶"),
    "lung_lower_lobe_left": ("lung_lower_lobe_l", "respiratory", "左肺下叶"),
    "lung_upper_lobe_right": ("lung_upper_lobe_r", "respiratory", "右肺上叶"),
    "lung_middle_lobe_right": ("lung_middle_lobe_r", "respiratory", "右肺中叶"),
    "lung_lower_lobe_right": ("lung_lower_lobe_r", "respiratory", "右肺下叶"),
    "trachea": ("trachea", "respiratory", "气管"),

    # ---------------- 内分泌 ----------------
    "thyroid_gland": ("thyroid_gland", "endocrine", "甲状腺"),
    "adrenal_gland_left": ("suprarenal_gland_l", "endocrine", "左肾上腺"),
    "adrenal_gland_right": ("suprarenal_gland_r", "endocrine", "右肾上腺"),

    # ---------------- 心血管 ----------------
    "heart": ("heart", "cardiovascular", "心"),
    "aorta": ("aorta", "cardiovascular", "主动脉"),
    "pulmonary_vein": ("pulmonary_vein", "cardiovascular", "肺静脉"),
    "brachiocephalic_trunk": ("brachiocephalic_trunk", "cardiovascular", "头臂干"),
    "subclavian_artery_left": ("subclavian_artery_l", "cardiovascular", "左锁骨下动脉"),
    "subclavian_artery_right": ("subclavian_artery_r", "cardiovascular", "右锁骨下动脉"),
    "common_carotid_artery_left": ("common_carotid_artery_l", "cardiovascular", "左颈总动脉"),
    "common_carotid_artery_right": ("common_carotid_artery_r", "cardiovascular", "右颈总动脉"),
    "brachiocephalic_vein_left": ("brachiocephalic_vein_l", "cardiovascular", "左头臂静脉"),
    "brachiocephalic_vein_right": ("brachiocephalic_vein_r", "cardiovascular", "右头臂静脉"),
    "internal_jugular_vein_left": ("internal_jugular_vein_l", "cardiovascular", "左颈内静脉"),
    "internal_jugular_vein_right": ("internal_jugular_vein_r", "cardiovascular", "右颈内静脉"),
    "superior_vena_cava": ("superior_vena_cava", "cardiovascular", "上腔静脉"),
    "inferior_vena_cava": ("inferior_vena_cava", "cardiovascular", "下腔静脉"),
    "portal_vein_and_splenic_vein": ("portal_vein", "cardiovascular", "门静脉与脾静脉"),
    "iliac_artery_left": ("iliac_artery_l", "cardiovascular", "左髂动脉"),
    "iliac_artery_right": ("iliac_artery_r", "cardiovascular", "右髂动脉"),
    "iliac_vena_left": ("iliac_vena_l", "cardiovascular", "左髂静脉"),
    "iliac_vena_right": ("iliac_vena_r", "cardiovascular", "右髂静脉"),

    # ---------------- 生殖 ----------------
    "prostate": ("prostate", "reproductive", "前列腺"),
    "uterus": ("uterus", "reproductive", "子宫"),

    # ---------------- 骨骼：中轴 ----------------
    "sternum": ("sternum", "skeletal", "胸骨"),
    "sacrum": ("sacrum", "skeletal", "骶骨"),
    "vertebrae_C1": ("vertebra_c1", "skeletal", "第 1 颈椎"),
    "vertebrae_C2": ("vertebra_c2", "skeletal", "第 2 颈椎"),
    "vertebrae_C3": ("vertebra_c3", "skeletal", "第 3 颈椎"),
    "vertebrae_C4": ("vertebra_c4", "skeletal", "第 4 颈椎"),
    "vertebrae_C5": ("vertebra_c5", "skeletal", "第 5 颈椎"),
    "vertebrae_C6": ("vertebra_c6", "skeletal", "第 6 颈椎"),
    "vertebrae_C7": ("vertebra_c7", "skeletal", "第 7 颈椎"),
    "vertebrae_T1": ("vertebra_t1", "skeletal", "第 1 胸椎"),
    "vertebrae_T2": ("vertebra_t2", "skeletal", "第 2 胸椎"),
    "vertebrae_T3": ("vertebra_t3", "skeletal", "第 3 胸椎"),
    "vertebrae_T4": ("vertebra_t4", "skeletal", "第 4 胸椎"),
    "vertebrae_T5": ("vertebra_t5", "skeletal", "第 5 胸椎"),
    "vertebrae_T6": ("vertebra_t6", "skeletal", "第 6 胸椎"),
    "vertebrae_T7": ("vertebra_t7", "skeletal", "第 7 胸椎"),
    "vertebrae_T8": ("vertebra_t8", "skeletal", "第 8 胸椎"),
    "vertebrae_T9": ("vertebra_t9", "skeletal", "第 9 胸椎"),
    "vertebrae_T10": ("vertebra_t10", "skeletal", "第 10 胸椎"),
    "vertebrae_T11": ("vertebra_t11", "skeletal", "第 11 胸椎"),
    "vertebrae_T12": ("vertebra_t12", "skeletal", "第 12 胸椎"),
    "vertebrae_L1": ("vertebra_l1", "skeletal", "第 1 腰椎"),
    "vertebrae_L2": ("vertebra_l2", "skeletal", "第 2 腰椎"),
    "vertebrae_L3": ("vertebra_l3", "skeletal", "第 3 腰椎"),
    "vertebrae_L4": ("vertebra_l4", "skeletal", "第 4 腰椎"),
    "vertebrae_L5": ("vertebra_l5", "skeletal", "第 5 腰椎"),
    "vertebrae_S1": ("vertebra_s1", "skeletal", "第 1 骶椎"),

    # ---------------- 骨骼：上肢 ----------------
    "scapula_left": ("scapula_l", "skeletal", "左肩胛骨"),
    "scapula_right": ("scapula_r", "skeletal", "右肩胛骨"),
    "clavicula_left": ("clavicle_l", "skeletal", "左锁骨"),
    "clavicula_right": ("clavicle_r", "skeletal", "右锁骨"),
    "humerus_left": ("humerus_l", "skeletal", "左肱骨"),
    "humerus_right": ("humerus_r", "skeletal", "右肱骨"),

    # ---------------- 骨骼：下肢 ----------------
    "femur_left": ("femur_l", "skeletal", "左股骨"),
    "femur_right": ("femur_r", "skeletal", "右股骨"),
    "hip_left": ("hip_bone_l", "skeletal", "左髋骨"),
    "hip_right": ("hip_bone_r", "skeletal", "右髋骨"),
    "patella_left": ("patella_l", "skeletal", "左髌骨"),
    "patella_right": ("patella_r", "skeletal", "右髌骨"),
    "tibia_left": ("tibia_l", "skeletal", "左胫骨"),
    "tibia_right": ("tibia_r", "skeletal", "右胫骨"),
    "fibula_left": ("fibula_l", "skeletal", "左腓骨"),
    "fibula_right": ("fibula_r", "skeletal", "右腓骨"),
    "tarsal_left": ("tarsal_bones_l", "skeletal", "左跗骨"),
    "tarsal_right": ("tarsal_bones_r", "skeletal", "右跗骨"),
    "metatarsal_left": ("metatarsal_bones_l", "skeletal", "左跖骨"),
    "metatarsal_right": ("metatarsal_bones_r", "skeletal", "右跖骨"),
    "phalanges_feet_left": ("phalanx_bones_foot_l", "skeletal", "左趾骨"),
    "phalanges_feet_right": ("phalanges_bones_foot_r", "skeletal", "右趾骨"),

    # ---------------- 肌肉 ----------------
    "autochthon_left": ("autochthon_l", "muscular", "左侧竖脊肌群"),
    "autochthon_right": ("autochthon_r", "muscular", "右侧竖脊肌群"),
    "iliopsoas_left": ("iliopsoas_l", "muscular", "左髂腰肌"),
    "iliopsoas_right": ("iliopsoas_r", "muscular", "右髂腰肌"),
}

# 只列出、不当资产用的类：CC BY-NC 或需单独商业许可
BLOCKED = {
    "brain_aneurysm": "CC BY-NC 4.0，无商业许可",
    "heartchambers_highres": "需单独申请商业许可",
    "coronary_arteries": "需单独申请商业许可",
    "tissue_types": "需单独申请商业许可",
    "brain_structures": "需单独申请商业许可",
    "appendicular_bones": "需单独申请商业许可",
    "face": "需单独申请商业许可",
    "thigh_shoulder_muscles": "需单独申请商业许可",
}


def resolve(ts_class: str) -> tuple[str, str, str] | None:
    """TotalSegmentator 类名 → 项目三元组；未登记返回 None（01 脚本会报出来）。"""
    return LABELS.get(ts_class)


def unmapped(classes: list[str]) -> list[str]:
    return [c for c in classes if c not in LABELS]
