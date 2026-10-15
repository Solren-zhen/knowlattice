/**
 * 给「深引」@testing-library/dom 内部模块补类型。
 *
 * 为什么深引：src/__tests__/setup.ts 只需要 configure 一个函数，而整个包有 ~140ms/文件的加载成本
 * （150 个测试文件累加就是几秒），config 子模块只要 ~30ms。
 * 这里只声明该子模块真正导出的那两个函数（签名与官方 d.ts 的 config 一致），类型不自己发明。
 */
declare module '@testing-library/dom/dist/config.js' {
  import type { Config, ConfigFn } from '@testing-library/dom';
  export function configure(configDelta: ConfigFn | Partial<Config>): void;
  export function getConfig(): Config;
}
