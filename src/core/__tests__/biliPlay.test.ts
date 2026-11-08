/**
 * B 站播放链路的纯函数契约测试。
 *
 * 这里只钉两件容易被顺手改坏的事：
 * 1) 代理地址的拼接规则 —— 前端拼错，请求就落到 dev server 的 404 上，表现为「视频加载失败」；
 * 2) __ct 标记必须跟着媒体地址走 —— 分轨 DASH 的音频段被 CDN 报成 octet-stream，
 *    没有这个标记 <audio> 会拒播，而单测是唯一能在没人点界面时发现它丢了的地方。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BILI_PROXY,
  checkAccount,
  getBiliProxyBase,
  parseCookieInput,
  proxied,
  setBiliProxyBase,
  topQuality,
  type BiliPlayInfo,
} from '../biliPlay';

describe('proxied', () => {
  it('桌面端注入的基址会用于 API 与媒体请求', () => {
    setBiliProxyBase('http://127.0.0.1:45678/bili-proxy');
    expect(proxied('https://api.bilibili.com/x/web-interface/view?bvid=BV1xx')).toBe(
      'http://127.0.0.1:45678/bili-proxy/api.bilibili.com/x/web-interface/view?bvid=BV1xx',
    );
    expect(getBiliProxyBase()).toBe('http://127.0.0.1:45678/bili-proxy');
    setBiliProxyBase('');
    expect(getBiliProxyBase()).toBe(BILI_PROXY);
  });

  it('把绝对地址改写成同源代理路径', () => {
    expect(proxied('https://api.bilibili.com/x/web-interface/view?bvid=BV1xx')).toBe(
      `${BILI_PROXY}/api.bilibili.com/x/web-interface/view?bvid=BV1xx`,
    )
  })

  it('声明媒体类型时追加 __ct（已有查询串用 &）', () => {
    expect(proxied('https://xy1.mcdn.bilivideo.cn:8082/v1/resource/a.m4s?e=1', 'audio')).toMatch(
      /_ct=audio$/,
    )
    expect(proxied('https://xy1.mcdn.bilivideo.cn:8082/v1/resource/a.m4s', 'video')).toBe(
      `${BILI_PROXY}/xy1.mcdn.bilivideo.cn:8082/v1/resource/a.m4s?__ct=video`,
    )
  })

  it('不是绝对地址时原样返回（别把相对路径拼成怪东西）', () => {
    expect(proxied('/local/file.mp4')).toBe('/local/file.mp4')
  })
})

describe('parseCookieInput', () => {
  it('整段 cookie 串里能取出 SESSDATA', () => {
    const acc = parseCookieInput('buvid3=abc; SESSDATA=deadbeef0123456789abcdef%2C1700000000; bili_jct=xyz')
    expect(acc?.sessdata).toBe('deadbeef0123456789abcdef%2C1700000000')
    expect(acc?.biliJct).toBe('xyz')
  })

  it('只粘 SESSDATA 的值也认（真实值都很长，20 字以内按无效处理）', () => {
    const value = 'deadbeef0123456789abcdef%2C1700000000'
    expect(parseCookieInput(value)?.sessdata).toBe(value)
    expect(parseCookieInput('short')).toBeNull()
  })

  it('空串与明显不是 cookie 的文本返回 null', () => {
    expect(parseCookieInput('   ')).toBeNull()
  })
})

describe('topQuality', () => {
  it('取接口给到的最高一档', () => {
    const info = { qualities: [{ qn: 32, label: '480P' }, { qn: 112, label: '1080P+' }] } as BiliPlayInfo
    expect(topQuality(info)?.qn).toBe(112)
  })

  it('没有档位时返回 null', () => {
    expect(topQuality({ qualities: [] } as unknown as BiliPlayInfo)).toBeNull()
  })
})

describe('checkAccount', () => {
  it('nav 的 isLogin 决定登录态，并带回用户名', async () => {
    setBiliProxyBase('http://proxy.test/bili-proxy')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ code: 0, data: { isLogin: true, uname: '某讲师' } }), {
        status: 200,
      })
    })
    const ok = await checkAccount({ sessdata: 'x'.repeat(30) })
    expect(ok).toEqual({ loggedIn: true, name: '某讲师' })
    expect(calls[0]).toContain('/x/web-interface/nav')
    vi.unstubAllGlobals()
  })

  it('没有账号时不发请求，直接视为未登录', async () => {
    let called = false
    vi.stubGlobal('fetch', async () => {
      called = true
      return new Response('{}')
    })
    expect(await checkAccount(null)).toEqual({ loggedIn: false })
    expect(called).toBe(false)
    vi.unstubAllGlobals()
  })
})
