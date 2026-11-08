import { describe, expect, it } from 'vitest';
import {
  degradationMessage,
  detectEnvironment,
  requestPersistence,
  supportTable,
  unsupportedFeatures,
  type SupportEnv,
} from '../capabilities';

const full: SupportEnv = {
  showOpenFilePicker: () => {},
  showSaveFilePicker: () => {},
  notification: {},
  notificationPermission: () => {},
  speechSynthesis: {},
  DecompressionStream: class {},
  serviceWorker: {},
  storagePersist: async () => true,
  share: () => {},
  clipboardWrite: () => {},
};

const bare: SupportEnv = {};

describe('capabilities', () => {
  it('全支持时没有降级文案，所有项 supported', () => {
    expect(supportTable(full).every((item) => item.supported)).toBe(true);
    expect(unsupportedFeatures(full)).toEqual([]);
    expect(degradationMessage(full)).toBeNull();
  });

  it('全空环境：每项都有降级路径，文案列出缺失数量', () => {
    const table = supportTable(bare);
    expect(table.every((item) => item.fallback.length > 0)).toBe(true);
    expect(table.every((item) => !item.supported)).toBe(true);
    expect(degradationMessage(bare)).toMatch(/8 项能力不可用/);
  });

  it('部分支持：只报告缺的那几项', () => {
    const env: SupportEnv = { ...bare, serviceWorker: {}, clipboardWrite: () => {} };
    expect(unsupportedFeatures(env).map((item) => item.id)).not.toContain('serviceWorker');
    expect(unsupportedFeatures(env).map((item) => item.id)).not.toContain('clipboard');
    expect(unsupportedFeatures(env)).toHaveLength(6);
  });

  it('detectEnvironment 能从注入的 scope 里取到能力位', () => {
    const scope = {
      showOpenFilePicker: () => {},
      navigator: { serviceWorker: {}, storage: { persist: async () => true }, share: () => {}, clipboard: { writeText: () => {} } },
    };
    const env = detectEnvironment(scope);
    expect(env.showOpenFilePicker).toBeTypeOf('function');
    expect(env.serviceWorker).toEqual({});
    expect(env.storagePersist).toBeTypeOf('function');
    expect(env.share).toBeTypeOf('function');
    expect(env.clipboardWrite).toBeTypeOf('function');
  });

  it('requestPersistence：有 API 按结果返回，无 API 返回 unsupported，抛错算 denied', async () => {
    expect(await requestPersistence({ storagePersist: async () => true })).toBe('granted');
    expect(await requestPersistence({ storagePersist: async () => false })).toBe('denied');
    expect(await requestPersistence({})).toBe('unsupported');
    expect(await requestPersistence({ storagePersist: async () => { throw new Error('no'); } })).toBe('denied');
  });
});
