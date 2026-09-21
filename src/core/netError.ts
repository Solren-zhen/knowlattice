/**
 * 浏览器底层网络错误 → 用户能照做的一句话。
 *
 * 为什么需要：离线版靠 `Start-KnowLattice.bat` 起的本地小服务提供页面。那个黑窗口一关、
 * 或者服务进程崩掉，之后每个请求都会在传输层失败，而浏览器给出的原文是
 *   Chrome  ：Failed to fetch
 *   Safari  ：Load failed
 *   Firefox ：NetworkError when attempting to fetch resource
 * ——全英文，而且一个字都没提「去看看那个黑窗口」。这些原文此前被 setError / toast
 * 直接显示给用户（解剖、脑图谱、PDF 三处视图共 8 个位置）。
 *
 * 注意 AbortError 不算网络故障：那是主动取消（切面板、组件卸载、AbortController.abort），
 * 报「连不上本地服务」会把用户带向完全错误的方向。
 */
export const TRANSPORT_ERROR_HINT =
  '连不上本地服务：确认启动时那个黑色窗口还开着；已关掉就重新双击 Start-KnowLattice.bat 再试';

const TRANSPORT_RE =
  /failed to fetch|load failed|networkerror|network error|err_connection|err_network|err_internet|connection refused|connection reset|net::/i;

const ABORT_RE = /abort/i;

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return '';
  return String(err);
}

/** 是不是「请求在传输层没走通」这一类错误（区别于 404 / 解析失败 / 业务异常）。 */
export function isTransportError(err: unknown): boolean {
  const msg = rawMessage(err);
  if (!msg) return false;
  if (ABORT_RE.test(msg)) return false;
  return TRANSPORT_RE.test(msg);
}

/**
 * 展示用文案：传输层失败给中文可执行提示（保留浏览器原文，便于用户回帖时贴出来），
 * 其余错误原样返回——404、配额、解析失败这些原文本身就有信息量，不该被覆盖。
 */
export function netErrorHint(err: unknown): string {
  const raw = rawMessage(err);
  if (!raw) return '未知错误';
  if (!isTransportError(err)) return raw;
  return `${TRANSPORT_ERROR_HINT}（浏览器原文：${raw}）`;
}
