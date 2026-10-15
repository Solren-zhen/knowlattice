import { describe, expect, it } from 'vitest';
import {
  initialUpdateState,
  isVersionSkipped,
  noticeVisible,
  parseUpdatePrefs,
  progressPct,
  stateAfterCheck,
  withSkipped,
  type UpdateState,
} from '../updater';

const base = (): UpdateState => initialUpdateState();

describe('progressPct', () => {
  it('总长度未知/非法时返回 null（界面走不确定进度）', () => {
    expect(progressPct(null, 100)).toBeNull();
    expect(progressPct(0, 100)).toBeNull();
    expect(progressPct(Number.NaN, 100)).toBeNull();
    expect(progressPct(-5, 100)).toBeNull();
  });

  it('正常换算取整，并夹在 0~100', () => {
    expect(progressPct(200, 0)).toBe(0);
    expect(progressPct(200, 50)).toBe(25);
    expect(progressPct(200, 200)).toBe(100);
    // 服务器报的总长偏小或分片多报时不能超过 100
    expect(progressPct(200, 260)).toBe(100);
  });
});

describe('更新偏好（跳过此版本）', () => {
  it('解析容错：空/坏 JSON/非法条目都退回空表', () => {
    expect(parseUpdatePrefs(null)).toEqual({ skipped: [] });
    expect(parseUpdatePrefs('not json')).toEqual({ skipped: [] });
    expect(parseUpdatePrefs('{"skipped":"0.3.0"}')).toEqual({ skipped: [] });
    expect(parseUpdatePrefs('{"skipped":["0.3.0",1,null,"0.3.0",""]}')).toEqual({ skipped: ['0.3.0'] });
  });

  it('新跳过的排最前，重复不叠加，最多留 5 个', () => {
    let prefs = { skipped: ['0.3.0', '0.2.9'] };
    prefs = withSkipped(prefs, '0.4.0');
    expect(prefs.skipped).toEqual(['0.4.0', '0.3.0', '0.2.9']);
    // 再点一次同一个版本：只移位不重复
    prefs = withSkipped(prefs, '0.3.0');
    expect(prefs.skipped).toEqual(['0.3.0', '0.4.0', '0.2.9']);
    for (const v of ['0.5.0', '0.6.0', '0.7.0', '0.8.0']) prefs = withSkipped(prefs, v);
    expect(prefs.skipped).toHaveLength(5);
    expect(prefs.skipped[0]).toBe('0.8.0');
    expect(prefs.skipped).not.toContain('0.2.9');
  });

  it('空版本号不写入（避免把「跳过」落到无意义的键上）', () => {
    expect(withSkipped({ skipped: ['0.3.0'] }, '').skipped).toEqual(['0.3.0']);
    expect(isVersionSkipped({ skipped: ['0.3.0'] }, '')).toBe(false);
  });
});

describe('stateAfterCheck', () => {
  const available = { kind: 'available' as const, current: '0.2.0', version: '0.3.0', notes: '修复若干问题' };

  it('发现新版本：记下版本与说明，等待用户确认', () => {
    const s = stateAfterCheck(base(), available, false);
    expect(s.phase).toBe('available');
    expect(s.version).toBe('0.3.0');
    expect(s.current).toBe('0.2.0');
    expect(s.notes).toBe('修复若干问题');
    expect(s.dismissed).toBe(false);
  });

  it('启动时的静默检查：被跳过的版本不再打扰', () => {
    const s = stateAfterCheck(base(), available, false, { skipped: ['0.3.0'] });
    expect(s.phase).toBe('available');
    expect(s.dismissed).toBe(true);
    expect(noticeVisible(s)).toBe(false);
  });

  it('用户手动检查：跳过过的版本也要如实报出来（否则那个按钮等于失灵）', () => {
    const s = stateAfterCheck(base(), available, true, { skipped: ['0.3.0'] });
    expect(s.dismissed).toBe(false);
    expect(noticeVisible(s)).toBe(true);
  });

  it('已是最新 / 失败各自落到对应状态，且清掉上一轮的版本号', () => {
    const prev = stateAfterCheck(base(), available, true);
    const cur = stateAfterCheck(prev, { kind: 'current' }, true);
    expect(cur.phase).toBe('current');
    expect(cur.version).toBe('');
    expect(cur.notes).toBe('');

    const failed = stateAfterCheck(prev, { kind: 'failed', message: 'network timeout' }, true);
    expect(failed.phase).toBe('error');
    expect(failed.error).toBe('network timeout');
  });
});

describe('noticeVisible', () => {
  it('下载中/安装中一定显示（用户点了安装就要看得见进度）', () => {
    expect(noticeVisible({ ...base(), phase: 'downloading', dismissed: true })).toBe(true);
    expect(noticeVisible({ ...base(), phase: 'installing', dismissed: true })).toBe(true);
  });

  it('有更新时显示，点了「稍后」就不显示', () => {
    expect(noticeVisible({ ...base(), phase: 'available' })).toBe(true);
    expect(noticeVisible({ ...base(), phase: 'available', dismissed: true })).toBe(false);
  });

  it('检查中/已是最新/失败只有手动检查才显示（启动时的静默检查不打扰）', () => {
    for (const phase of ['checking', 'current', 'error'] as const) {
      expect(noticeVisible({ ...base(), phase, manual: false })).toBe(false);
      expect(noticeVisible({ ...base(), phase, manual: true })).toBe(true);
    }
  });

  it('idle 不显示', () => {
    expect(noticeVisible(base())).toBe(false);
  });
});
