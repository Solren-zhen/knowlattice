/**
 * B 站扫码登录：拿二维码内容 → 轮询状态 → 成功后直接得到 cookie。
 *
 * 为什么不让用户手粘 SESSDATA：DevTools 里翻 cookie 对普通用户是门槛，
 * 而 passport-login 的二维码接口允许匿名调用，登录结果里的回调 URL 自带 SESSDATA。
 * 网络只走应用自己的 /bili-proxy（Referer、跨域与 Cookie 头都由代理补），
 * 这里只负责「拿到什么、映射成什么状态」，方便单测钉住状态机。
 */
import { proxied, saveAccount, type BiliAccount } from './biliPlay';

/** 二维码内容与轮询用的 key */
export interface QrLoginTicket {
  url: string;
  key: string;
}

export type QrLoginStatus = 'waiting' | 'scanned' | 'expired' | 'ok' | 'error';

export interface QrLoginPoll {
  status: QrLoginStatus;
  message: string;
  /** status=ok 时可直接交给 saveAccount 的 cookie 文本 */
  cookie?: string;
}

/** 轮询间隔：B 站二维码有效期约 180 秒，2 秒一问足够 */
export const QR_POLL_MS = 2_000;

interface RawGenerate {
  code?: number;
  message?: string;
  data?: { url?: string; qrcode_key?: string };
}

interface RawCookie {
  name?: string;
  value?: string;
}

interface RawPoll {
  code?: number;
  message?: string;
  data?: {
    url?: string;
    code?: number;
    message?: string;
    /** 部分版本只在 cookie_info 里给凭证 */
    cookie_info?: { cookies?: RawCookie[] };
    cookies?: RawCookie[];
  };
}

/** 代理把上游的 Set-Cookie 用 ||| 拼在自定义头里；这里只挑登录需要的两项 */
export function cookieFromSetCookie(raw: string): string {
  const segments = (raw || '').split('|||');
  const pick = (name: string): string => {
    for (const seg of segments) {
      const m = new RegExp(`^\\s*${name}=([^;]+)`, 'i').exec(seg);
      if (m) return `${name}=${m[1].trim()}`;
    }
    return '';
  };
  return [pick('SESSDATA'), pick('bili_jct')].filter(Boolean).join('; ');
}

/** cookie_info.cookies 形态（老版本 / 其它客户端共用的一套字段） */
export function cookieFromCookieInfo(list: RawCookie[] | undefined): string {
  if (!list?.length) return '';
  const pick = (name: string): string => {
    const hit = list.find(
      (c) => (c.name || '').toLowerCase() === name.toLowerCase() && Boolean(c.value),
    );
    return hit ? `${hit.name}=${hit.value}` : '';
  };
  return [pick('SESSDATA'), pick('bili_jct')].filter(Boolean).join('; ');
}

/**
 * 从登录成功的回调 URL 里取出 cookie。
 * 用正则而不是 URLSearchParams：SESSDATA 本身的逗号是百分号编码的，
 * 解码后再拼 Cookie 头会让 B 站认不出这个会话。
 */
export function cookieFromQrSuccess(url: string): string {
  const pick = (name: string): string => {
    const m = new RegExp(`[?&]${name}=([^&#]+)`).exec(url);
    return m ? `${name}=${m[1]}` : '';
  };
  return [pick('SESSDATA'), pick('bili_jct')].filter(Boolean).join('; ');
}

const hasSess = (cookie: string): boolean => /(?:^|;\s*)SESSDATA=[^;\s]+/.test(cookie);

/** 轮询响应 → 界面状态；B 站的业务码在 data.code 里，外层 code 只表示请求本身成功 */
export function parseQrPoll(payload: RawPoll, setCookieHeader = ''): QrLoginPoll {
  if (payload.code !== 0) {
    return { status: 'error', message: payload.message || `B 站返回错误码 ${payload.code ?? '未知'}` };
  }
  const code = payload.data?.code ?? 0;
  if (code === 0) {
    // 现在的 B 站可能只通过 Set-Cookie 下发凭证；data.url 与 cookie_info 作为兜底，
    // 三者都拿不到才算失败，避免「登录成功却提示没拿到 SESSDATA」。
    const candidates = [
      cookieFromSetCookie(setCookieHeader),
      cookieFromCookieInfo(payload.data?.cookie_info?.cookies),
      cookieFromCookieInfo(payload.data?.cookies),
      cookieFromQrSuccess(payload.data?.url || ''),
    ];
    const cookie = candidates.find(hasSess) || '';
    if (!cookie) return { status: 'error', message: '登录成功但没拿到 SESSDATA，请重试' };
    return { status: 'ok', message: '登录成功', cookie };
  }
  if (code === 86101) return { status: 'waiting', message: '等待扫码' };
  if (code === 86090) return { status: 'scanned', message: '已扫码，请在手机上确认' };
  if (code === 86038) return { status: 'expired', message: '二维码已失效，点「刷新二维码」重新获取' };
  return { status: 'error', message: payload.data?.message || `登录状态码 ${code}` };
}

/** 请求一张新二维码（匿名可用；代理已放行 passport.bilibili.com） */
export async function startQrLogin(): Promise<QrLoginTicket> {
  const res = await fetch(
    proxied('https://passport.bilibili.com/x/passport-login/web/qrcode/generate'),
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`二维码接口 ${res.status}`);
  const json = (await res.json()) as RawGenerate;
  if (json.code !== 0) throw new Error(json.message || `二维码接口返回 ${json.code}`);
  const url = (json.data?.url || '').trim();
  const key = (json.data?.qrcode_key || '').trim();
  if (!url || !key) throw new Error('二维码接口没有返回 url / qrcode_key');
  return { url, key };
}

/** 问一次登录状态 */
export async function pollQrLogin(key: string): Promise<QrLoginPoll> {
  const res = await fetch(
    proxied(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
    ),
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`登录状态接口 ${res.status}`);
  // 凭证可能只在 Set-Cookie 里：取 body 之前先读代理转发的自定义头
  const setCookie = res.headers.get('x-bili-set-cookie') || '';
  return parseQrPoll((await res.json()) as RawPoll, setCookie);
}

/** 登录成功后落盘；解析失败返回 null，界面据此提示重试 */
export function persistQrLogin(cookie: string): BiliAccount | null {
  return saveAccount(cookie);
}
