import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AnatomyManifest, ManifestOrgan } from '../anatomy';
import {
  assignMuscleLayers,
  baseName,
  classifyMuscularPart,
  layerOfMuscle,
} from '../muscleLayer';

/** 用真实 manifest 校验，而不是造数据——分层表是照着这份数据写的 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../public/anatomy/manifest.json', import.meta.url)), 'utf8')
) as AnatomyManifest;

const muscular = manifest.organs.filter((o) => o.system === 'muscular');
const realMuscles = muscular.filter((o) => classifyMuscularPart(o) === 'muscle');
/** 只在真肌肉里找——同名还有肌腱/附着条目，它们不进规则表 */
const find = (frag: string): ManifestOrgan => {
  const hit = realMuscles.find((o) => baseName(o.name_en) === frag.toLowerCase())
    ?? realMuscles.find((o) => baseName(o.name_en).includes(frag.toLowerCase()));
  if (!hit) throw new Error(`manifest 里找不到肌肉：${frag}`);
  return hit;
};
/** 在全部条目里找（用于肌腱/筋膜这类非肌肉条目） */
const findAny = (frag: string): ManifestOrgan => {
  const hit = muscular.find((o) => baseName(o.name_en) === frag.toLowerCase());
  if (!hit) throw new Error(`manifest 里找不到条目：${frag}`);
  return hit;
};

describe('classifyMuscularPart', () => {
  it('把肌腱/附着/滑囊/筋膜/韧带从肌肉里分出来', () => {
    expect(classifyMuscularPart(find('Long head of biceps femoris'))).toBe('muscle');
    const others = [
      'Anterior layer of thoracolumbar fascia',
      'Superficial transverse metacarpal ligament',
      'Common tendinous ring',
      'Popliteal fascia',
    ];
    for (const n of others) expect(classifyMuscularPart(findAny(n))).toBe('other');
    // 「Muscular insertions」整组都是肌腱
    const ins = muscular.find((o) => o.path.join(' > ').includes('Muscular insertions'))!;
    expect(classifyMuscularPart(ins)).toBe('other');
  });

  it('muscular 系统里非肌肉条目占相当比例（这正是原来分层粗糙的原因之一）', () => {
    const muscles = muscular.filter((o) => classifyMuscularPart(o) === 'muscle');
    const others = muscular.length - muscles.length;
    expect(muscles.length).toBeGreaterThan(400);
    expect(others).toBeGreaterThan(400);
  });
});

describe('layerOfMuscle 覆盖率', () => {
  it('所有真肌肉都能在规则表里命中（不依赖几何兜底）', () => {
    const muscles = muscular.filter((o) => classifyMuscularPart(o) === 'muscle');
    const missed = [...new Set(
      muscles.filter((o) => layerOfMuscle(o) === null).map((o) => baseName(o.name_en))
    )];
    expect(missed).toEqual([]);
  });
});

describe('解剖学抽查：层级要符合常识', () => {
  const superficial: Array<[string, number]> = [
    ['Acromial part of deltoid muscle', 1],
    ['Clavicular head of pectoralis major muscle', 1],
    ['Long head of biceps brachii', 1],
    ['Descending part of trapezius muscle', 1],
    ['Lateral head of gastrocnemius', 1],
    ['Tibialis anterior muscle', 1],
    ['Sternocleidomastoid muscle', 1],
    ['Rectus abdominis muscle', 1],
    ['Latissimus dorsi muscle', 1],
    ['Gluteus maximus muscle', 1],
    ['Brachioradialis muscle', 1],
    ['Scalenus anterior muscle', 2],
    ['Gluteus medius muscle', 2],
    ['Serratus anterior muscle', 2],
  ];
  const deep: Array<[string, number]> = [
    ['Infraspinatus muscle', 3],
    ['Soleus muscle', 3],
    ['Flexor digitorum profundus', 3],
    ['Iliocostalis lumborum muscle', 3],   // 竖脊肌
    ['Vastus intermedius muscle', 3],
    ['Psoas major', 4],
    ['Multifidus colli muscle', 4],
    ['Interspinales colli muscles', 4],
    ['Rotatores', 4],
    ['Quadratus lumborum muscle', 4],
    ['Transversus thoracis muscle', 4],
    ['Semispinalis colli muscle', 4],
    ['Diaphragm', 4],
    ['Subscapularis muscle', 4],
  ];

  it.each([...superficial, ...deep])('%s → 第 %i 层', (name, layer) => {
    expect(layerOfMuscle(find(name))).toBe(layer);
  });

  it('浅层与深层不会混在一起', () => {
    for (const [n] of superficial) expect(layerOfMuscle(find(n))!).toBeLessThanOrEqual(2);
    for (const [n] of deep) expect(layerOfMuscle(find(n))!).toBeGreaterThanOrEqual(3);
  });
});

describe('assignMuscleLayers', () => {
  const layers = assignMuscleLayers(muscular);

  it('每个条目都有层级', () => {
    expect(layers.size).toBe(muscular.length);
    for (const [, l] of layers) expect([1, 2, 3, 4]).toContain(l);
  });

  it('层级分布不再像原来那样每档硬凑四分之一（浅层是少数、深层占多数）', () => {
    const muscleLayers = realMuscles.map((o) => layers.get(o.organ_id)!);
    const count = (l: number) => muscleLayers.filter((v) => v === l).length;
    const total = muscleLayers.length;
    expect(count(1)).toBeGreaterThan(30);                     // 浅层得有内容
    expect(count(1)).toBeLessThan(total * 0.4);               // 但只占少数
    expect(count(3) + count(4)).toBeGreaterThan(total * 0.4); // 深层合计占多数
    for (const l of [1, 2, 3, 4]) expect(count(l)).toBeGreaterThan(5);
  });

  it('同名肌腱跟随同名肌肉的层级（不被独立乱分）', () => {
    // 数据里很多肌肉名同时有「肌肉」和「附着(肌腱)」两条，取第一个这样的名字来验证
    const byBase = new Map<string, ManifestOrgan[]>();
    for (const o of muscular) {
      const k = baseName(o.name_en);
      (byBase.get(k) ?? byBase.set(k, []).get(k)!).push(o);
    }
    const pair = [...byBase.entries()].find(([, list]) =>
      list.some((o) => classifyMuscularPart(o) === 'muscle')
      && list.some((o) => classifyMuscularPart(o) === 'other'));
    expect(pair).toBeTruthy();
    const [key, list] = pair!;
    const muscle = list.find((o) => classifyMuscularPart(o) === 'muscle')!;
    const tendon = list.find((o) => classifyMuscularPart(o) === 'other')!;
    expect(key.length).toBeGreaterThan(3);
    expect(layers.get(tendon.organ_id)).toBe(layers.get(muscle.organ_id));
  });

  it('筋膜不会被塞进最深层（它包在肌肉外面）', () => {
    const fascia = muscular.find((o) => /^Deltoid fascia$/i.test(baseName(o.name_en)))!;
    expect(layers.get(fascia.organ_id)).toBeLessThan(4);
  });
});
