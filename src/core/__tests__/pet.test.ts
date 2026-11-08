/**
 * 桌宠状态：坐标夹取、显隐持久化、外观校验、提示不连播同一句。
 * 角色渲染在 views/Pet.tsx，这里只测纯逻辑，不碰 DOM。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampPet, isPetHidden, loadPet, nextPetLine, PET_LINES, PET_LOOK_DEFAULT,
  resetPetLook, setPetHidden, updatePetLook,
} from '../pet';

const DEFAULT_STATE = {
  ...PET_LOOK_DEFAULT,
  hidden: false,
  x: null,
  y: null,
};

beforeEach(() => localStorage.clear());

describe('clampPet', () => {
  it('把越界坐标夹回视口', () => {
    expect(clampPet(-20, -5, 100, 100, 800, 600)).toEqual({ x: 0, y: 0 });
    expect(clampPet(900, 700, 100, 100, 800, 600)).toEqual({ x: 700, y: 500 });
  });

  it('视口比角色还小时退回 0，不产生负坐标', () => {
    expect(clampPet(10, 10, 120, 120, 80, 60)).toEqual({ x: 0, y: 0 });
  });
});

describe('显隐与坐标', () => {
  it('默认显示、没有自定义坐标、默认外观', () => {
    expect(loadPet()).toEqual(DEFAULT_STATE);
  });

  it('隐藏后能读回', () => {
    setPetHidden(true);
    expect(isPetHidden()).toBe(true);
    setPetHidden(false);
    expect(isPetHidden()).toBe(false);
  });

  it('image 开关只认布尔，其余回退 false', () => {
    localStorage.setItem('knowlattice-pet', JSON.stringify({ image: 'yes' }));
    expect(loadPet().image).toBe(false);
    localStorage.setItem('knowlattice-pet', JSON.stringify({ image: true }));
    expect(loadPet().image).toBe(true);
  });

  it('坏数据回退到默认值，不抛', () => {
    localStorage.setItem('knowlattice-pet', '{oops');
    expect(loadPet()).toEqual(DEFAULT_STATE);
  });

  it('非数字坐标被当成未设置', () => {
    localStorage.setItem('knowlattice-pet', JSON.stringify({ hidden: false, x: '12', y: null }));
    expect(loadPet()).toMatchObject({ x: null, y: null });
  });
});

describe('自定义外观', () => {
  it('名字去空白并截断，空名字回退默认', () => {
    localStorage.setItem('knowlattice-pet', JSON.stringify({ name: '  小晶  ' }));
    expect(loadPet().name).toBe('小晶');

    localStorage.setItem('knowlattice-pet', JSON.stringify({ name: '一二三四五六七八九十十一十二十三' }));
    expect(loadPet().name).toHaveLength(12);

    localStorage.setItem('knowlattice-pet', JSON.stringify({ name: '   ' }));
    expect(loadPet().name).toBe(PET_LOOK_DEFAULT.name);
  });

  it('颜色必须是 #rrggbb，大小写归一；非法值退回跟随主题', () => {
    localStorage.setItem('knowlattice-pet', JSON.stringify({ color: '#AABBCC' }));
    expect(loadPet().color).toBe('#aabbcc');

    localStorage.setItem('knowlattice-pet', JSON.stringify({ color: 'red' }));
    expect(loadPet().color).toBeNull();

    localStorage.setItem('knowlattice-pet', JSON.stringify({ color: '#abc' }));
    expect(loadPet().color).toBeNull();
  });

  it('体型 / 表情 / 配饰 只接受枚举，其余回退默认', () => {
    localStorage.setItem('knowlattice-pet', JSON.stringify({ size: 'l', face: 'star', accessory: 'halo' }));
    expect(loadPet()).toMatchObject({ size: 'l', face: 'star', accessory: 'halo' });

    localStorage.setItem('knowlattice-pet', JSON.stringify({ size: 'xl', face: 'wink', accessory: 'hat' }));
    expect(loadPet()).toMatchObject({
      size: PET_LOOK_DEFAULT.size,
      face: PET_LOOK_DEFAULT.face,
      accessory: PET_LOOK_DEFAULT.accessory,
    });
  });

  it('updatePetLook 只改外观，保留显隐与坐标', () => {
    localStorage.setItem('knowlattice-pet', JSON.stringify({ hidden: true, x: 40, y: 50 }));
    updatePetLook({ name: '小蓝', color: '#0E7490', size: 's', face: 'smile', accessory: 'sprout' });
    expect(loadPet()).toEqual({
      name: '小蓝',
      color: '#0e7490',
      size: 's',
      face: 'smile',
      accessory: 'sprout',
      image: false,
      hidden: true,
      x: 40,
      y: 50,
    });
  });

  it('恢复默认只回退外观，不动位置与显隐', () => {
    localStorage.setItem('knowlattice-pet', JSON.stringify({
      name: '小蓝', color: '#0e7490', size: 'l', face: 'star', accessory: 'halo',
      hidden: true, x: 12, y: 34,
    }));
    resetPetLook();
    expect(loadPet()).toEqual({ ...PET_LOOK_DEFAULT, hidden: true, x: 12, y: 34 });
  });
});

describe('提示轮播', () => {
  it('候选文案至少两条，且不会连续重复上一句', () => {
    expect(PET_LINES.length).toBeGreaterThan(1);
    for (const line of PET_LINES) {
      for (let i = 0; i < 20; i += 1) expect(nextPetLine(line)).not.toBe(line);
    }
  });
});
