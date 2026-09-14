/**
 * 肌肉分层：精选解剖分层表。
 *
 * 为什么不用几何估算：本数据集没有体表（皮肤）网格，只能拿「到骨骼的距离」当深浅代理，
 * 但实测该判据无法区分深浅——比目鱼肌（深层）与腓肠肌（浅层）到骨的最近距离几乎相同
 * （0.004m vs 0.003m）。用它对 20 个知名肌肉做抽查只有 11 个分对（臀大肌、胸锁乳突肌被
 * 判成深层，腰大肌、回旋肌被判成浅层）。
 *
 * 因此改为显式定层：数据里 454 条肌肉只有 228 个唯一名、32 个解剖路径组，且路径本身就是
 * 解剖学分组（如 "Deep gluteal muscles" / "Superficial gluteal muscles" / "Rotator cuff
 * muscles"），足以逐组定层。规则表按顺序匹配，命中即返回。
 *
 * 另外「muscular」系统并不全是肌肉：1110 条里 454 条是肌肉，其余是肌腱/附着(527)、
 * 滑囊、筋膜、韧带等。它们不参与分层，而是跟随同名（或其所属）肌肉的层级。
 *
 * 层级：1 = 最浅（皮下可及），4 = 最深。发现分层不对，直接改 RULES 即可。
 */

import type { ManifestOrgan } from './anatomy';

export type MuscleLayer = 1 | 2 | 3 | 4;

/** 层级文案（下标 0 对应第 1 层） */
export const LAYER_LABELS = ['浅层', '二层', '三层', '深层'] as const;

/** 非肌肉结构的特征词：肌腱、腱膜、筋膜、韧带、滑囊、睑板、滑车、束、弓、环、白线等 */
const NON_MUSCLE_RE =
  /tendon|aponeuro|raphe|retinacul|sheath|septum|bursa|fascia|ligament|tarsus|trochlea|tract|arch|ring|linea|lamina/i;

/** 筋膜/腱膜一类：不是肌肉但包在肌肉表面，给个偏浅的层以便和肌肉一起显示 */
const WRAPPING_RE = /fascia|tract|retinacul|aponeuro|linea|raphe/i;

/** 去掉左右后缀并小写，便于名称匹配与归属 */
export function baseName(nameEn: string): string {
  return nameEn.replace(/\s*\((left|right)\)\s*$/i, '').trim().toLowerCase();
}

/** 「muscular」系统里这一条到底是不是肌肉 */
export function classifyMuscularPart(organ: ManifestOrgan): 'muscle' | 'other' {
  const path = organ.path.join(' > ');
  if (/Bursae|Muscular insertions/i.test(path)) return 'other';
  if (NON_MUSCLE_RE.test(organ.name_en)) return 'other';
  return 'muscle';
}

interface Rule {
  /** 匹配完整路径（organ.path.join(' > ')），忽略大小写 */
  path?: RegExp;
  /** 匹配去后缀的小写名 */
  name?: RegExp;
  layer: MuscleLayer;
}

/**
 * 分层规则表（按顺序匹配，先命中先返回）。
 * 先写「名字就能唯一确定」的，再写「整组同层」的路径规则。
 */
const RULES: Rule[] = [
  // ===== 第 4 层：最深（眶内、舌内、喉内、咽、椎体深层、盆底、足底深层、深层髋旋转肌、小腿深层）=====
  { path: /Muscles of head/i, name: /(superior|inferior|medial|lateral) rectus|oblique muscle|levator palpebrae|genioglossus|hyoglossus/, layer: 4 },
  { path: /Laryngeal muscles|Pharyngeal muscles/i, layer: 4 },
  { path: /Suboccipital muscles|Transversospinal muscles|Intertransversarii/i, layer: 4 },
  { name: /^rotatores$|interspinales|levatores (breves|longi) costarum/, layer: 4 },
  { name: /transversus thoracis|innermost intercostal|^diaphragm$/, layer: 4 },
  { name: /coccygeus|pubococcygeus|pubo-analis|anal sphincter/, layer: 4 },
  { name: /quadratus lumborum/, layer: 4 },
  { path: /Deep gluteal muscles/i, layer: 4 },
  { name: /psoas major|subscapularis|obturator externus|iliacus/, layer: 4 },
  { path: /Muscles of hand|Muscles of foot/i, name: /interossei|lumbrical|quadratus plantae/, layer: 4 },
  { path: /Posterior compartment of leg/i, name: /popliteus|flexor digitorum longus|flexor hallucis longus|tibialis posterior/, layer: 4 },
  { name: /pronator quadratus/, layer: 4 },
  { name: /longus (colli|capitis)|rectus (anterior|lateralis) capitis/, layer: 4 },

  // ===== 第 3 层：深层（被浅层肌肉覆盖）=====
  { path: /Rotator cuff muscles/i, layer: 3 },
  { path: /Muscles of head/i, name: /pterygoid/, layer: 3 },
  { name: /scalenus posterior/, layer: 3 },
  { path: /Erector spinae/i, layer: 3 },             // 竖脊肌：背部固有肌的浅层，但位于斜方肌/背阔肌深面
  { path: /Hypaxial muscles of back/i, name: /serratus posterior|intertransversarii/, layer: 3 },
  { name: /pectoralis minor|transversus abdominis|internal intercostal/, layer: 3 },
  { path: /Anterior compartment of arm/i, name: /brachialis|coracobrachialis/, layer: 3 },
  { path: /Posterior compartment of forearm/i, name: /extensor indicis|supinator/, layer: 3 },
  { path: /Anterior compartment of forearm/i, name: /profundus|flexor pollicis longus/, layer: 3 },
  { name: /adductor brevis|adductor magnus/, layer: 3 },
  { path: /Anterior compartment of thigh/i, name: /vastus intermedius/, layer: 3 },
  { name: /gluteus minimus/, layer: 3 },
  { path: /Posterior compartment of leg/i, name: /soleus|plantaris/, layer: 3 },
  { path: /Muscles of hand|Muscles of foot/i, layer: 3 },   // 手/足其余内在肌

  // ===== 第 2 层 =====
  { path: /Muscles of head/i, name: /deep part of masseter/, layer: 2 },
  { name: /sternohyoid|sternothyroid|thyrohyoid|omohyoid|digastric|stylohyoid|mylohyoid|geniohyoid/, layer: 2 },
  { name: /scalenus (anterior|medius)/, layer: 2 },
  { name: /splenius/, layer: 2 },
  { name: /levator scapulae|rhomboid/, layer: 2 },
  { name: /serratus anterior|subclavius|teres major/, layer: 2 },
  { name: /pectineus|semimembranosus/, layer: 2 },
  { name: /gluteus medius/, layer: 2 },
  { name: /fibularis brevis|external intercostal/, layer: 2 },
  { path: /Anterior compartment of leg/i, name: /extensor digitorum longus|extensor hallucis longus|fibularis tertius/, layer: 2 },
  { path: /Posterior compartment of forearm/i, name: /abductor pollicis longus|extensor pollicis/, layer: 2 },
  { path: /Anterior compartment of forearm/i, name: /superficialis/, layer: 2 },
  { name: /internal abdominal oblique/, layer: 2 },

  // ===== 第 1 层：最浅（皮下可及）=====
  { path: /Facial muscles/i, layer: 1 },
  { path: /Muscles of head/i, name: /superficial part of masseter|^temporalis|frontalis|occipitalis|temporoparietalis/, layer: 1 },
  { name: /^platysma$|sternocleidomastoid/, layer: 1 },
  { name: /trapezius|latissimus dorsi/, layer: 1 },
  { name: /deltoid|pectoralis major/, layer: 1 },
  { name: /rectus abdominis|pyramidalis|external abdominal oblique/, layer: 1 },
  { name: /biceps brachii|triceps brachii|brachioradialis|anconeus/, layer: 1 },
  { path: /Posterior compartment of forearm/i, name: /extensor/, layer: 1 },
  { path: /Anterior compartment of forearm/i, name: /flexor carpi|palmaris longus|pronator teres/, layer: 1 },
  { name: /gluteus maximus|tensor fasciae latae/, layer: 1 },
  { path: /Anterior compartment of thigh/i, name: /sartorius|rectus femoris|vastus (lateralis|medialis)/, layer: 1 },
  { name: /adductor longus|^gracilis/, layer: 1 },
  { path: /Posterior compartment of thigh/i, name: /biceps femoris|semitendinosus|gracilis/, layer: 1 },
  { path: /Lateral compartment of leg/i, name: /fibularis longus/, layer: 1 },
  { path: /Posterior compartment of leg/i, name: /gastrocnemius/, layer: 1 },
  { path: /Anterior compartment of leg/i, name: /tibialis anterior/, layer: 1 },
];

/**
 * 单块肌肉的层级；规则表未收录时返回 null（由调用方兜底）。
 * 表里 228 个唯一名已全覆盖，正常不会走到 null。
 */
export function layerOfMuscle(organ: ManifestOrgan): MuscleLayer | null {
  const path = organ.path.join(' > ');
  const name = baseName(organ.name_en);
  for (const rule of RULES) {
    if (rule.path && !rule.path.test(path)) continue;
    if (rule.name && !rule.name.test(name)) continue;
    return rule.layer;
  }
  return null;
}

/**
 * 给「muscular」系统的全部条目分配层级。
 * - 真肌肉：按精选表定层（未收录的少数给中间层兜底）
 * - 肌腱/滑囊等：跟随同名（或其所属）肌肉的层级；找不到归属的归最深层
 * - 筋膜/腱膜/支持带：不是肌肉但包在肌肉外面，给第 2 层，避免在浅层里缺席
 */
export function assignMuscleLayers(organs: ManifestOrgan[]): Map<string, MuscleLayer> {
  const out = new Map<string, MuscleLayer>();
  const byBase = new Map<string, MuscleLayer>();
  const others: ManifestOrgan[] = [];

  for (const o of organs) {
    if (classifyMuscularPart(o) === 'other') { others.push(o); continue; }
    const layer = layerOfMuscle(o) ?? 3;
    out.set(o.organ_id, layer);
    const key = baseName(o.name_en);
    const prev = byBase.get(key);
    if (prev === undefined || layer < prev) byBase.set(key, layer);
  }

  const keys = [...byBase.keys()];
  for (const o of others) {
    const key = baseName(o.name_en);
    let layer = byBase.get(key);
    if (layer === undefined) {
      // 名称包含关系："Biceps femoris tendon" → "Long head of biceps femoris"
      let bestLen = 0;
      for (const mk of keys) {
        if (mk.length < 5) continue;
        if ((key.includes(mk) || mk.includes(key)) && mk.length > bestLen) {
          bestLen = mk.length;
          layer = byBase.get(mk);
        }
      }
    }
    if (layer === undefined && WRAPPING_RE.test(o.name_en)) layer = 2;
    out.set(o.organ_id, layer ?? 4);
  }
  return out;
}
