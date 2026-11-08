/**
 * 扫码登录的状态机测试。
 *
 * 登录成功那一屏最容易写错：B 站把 SESSDATA 放在回调 URL 的查询参数里，
 * 而它的逗号是百分号编码的 —— 解码后再拼 Cookie 头会变成「登录成功但接口仍报未登录」，
 * 这种错只有真扫码才看得出来，所以在这里用固定报文钉住。
 */
import { describe, expect, it } from 'vitest';
import { cookieFromQrSuccess, parseQrPoll } from '../biliLogin';

describe('cookieFromQrSuccess', () => {
  it('保留 SESSDATA 的原始百分号编码，并带上 bili_jct', () => {
    const url =
      'https://www.bilibili.com/?SESSDATA=abc%2C1700000000%2Cdef%2A11&bili_jct=xyz&DedeUserID=42';
    expect(cookieFromQrSuccess(url)).toBe('SESSDATA=abc%2C1700000000%2Cdef%2A11; bili_jct=xyz');
  });

  it('没有 SESSDATA 时返回空串（界面据此提示重试）', () => {
    expect(cookieFromQrSuccess('https://www.bilibili.com/')).toBe('');
  });
});

describe('parseQrPoll', () => {
  it('未扫码 / 已扫码 / 已失效 分别是三种提示', () => {
    expect(parseQrPoll({ code: 0, data: { code: 86101 } })).toMatchObject({
      status: 'waiting',
      message: '等待扫码',
    });
    expect(parseQrPoll({ code: 0, data: { code: 86090 } })).toMatchObject({
      status: 'scanned',
      message: '已扫码，请在手机上确认',
    });
    expect(parseQrPoll({ code: 0, data: { code: 86038 } })).toMatchObject({ status: 'expired' });
  });

  it('业务码 0 且带回 SESSDATA 才算登录成功', () => {
    const done = parseQrPoll({
      code: 0,
      data: { code: 0, url: 'https://www.bilibili.com/?SESSDATA=abc%2C1%2Cdef&bili_jct=xyz' },
    });
    expect(done.status).toBe('ok');
    expect(done.cookie).toBe('SESSDATA=abc%2C1%2Cdef; bili_jct=xyz');

    const empty = parseQrPoll({ code: 0, data: { code: 0, url: 'https://www.bilibili.com/' } });
    expect(empty.status).toBe('error');
  });

  it('外层错误码不当作登录成功', () => {
    const bad = parseQrPoll({ code: -412, message: '请求被拦截' });
    expect(bad).toMatchObject({ status: 'error', message: '请求被拦截' });
  });

  it('凭证只在 Set-Cookie 里时（data.url 为空）也能登录', () => {
    const header =
      'SESSDATA=abc%2C1700000000%2Cdef%2A11; Path=/; Domain=bilibili.com; HttpOnly' +
      '|||bili_jct=xyz; Path=/; Domain=bilibili.com' +
      '|||DedeUserID=42; Path=/';
    const done = parseQrPoll(
      { code: 0, data: { code: 0, url: 'https://www.bilibili.com' } },
      header,
    );
    expect(done.status).toBe('ok');
    expect(done.cookie).toBe('SESSDATA=abc%2C1700000000%2Cdef%2A11; bili_jct=xyz');
  });

  it('cookie_info.cookies 形态也能取到凭证', () => {
    const done = parseQrPoll({
      code: 0,
      data: {
        code: 0,
        cookie_info: {
          cookies: [
            { name: 'SESSDATA', value: 'abc%2C1%2Cdef' },
            { name: 'bili_jct', value: 'xyz' },
          ],
        },
      },
    });
    expect(done.status).toBe('ok');
    expect(done.cookie).toBe('SESSDATA=abc%2C1%2Cdef; bili_jct=xyz');
  });
});
