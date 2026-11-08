//! B 站桌面端回环代理。
//!
//! 为什么需要它：Vite 的 `/bili-proxy` 只在 `npm run dev` 下存在；安装版 WebView
//! 请求同源 `/bili-proxy` 会命中静态资源 404，于是粘贴 B 站链接后“视频笔记”没有画面。
//! 这里用 Tauri 启动一个只绑定 127.0.0.1 的小代理，保持与开发期相同的 URL 形状。
//!
//! 安全边界：
//! - 只监听回环地址；
//! - 只允许 B 站 API/CDN 域名；
//! - 只转发 GET/HEAD；
//! - 不转发任意请求头，只转发 Cookie、Range、Accept；
//! - 媒体主机必须先在 playurl 响应中出现过，避免成为任意 HTTPS 代理。

use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderName, HeaderValue};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use reqwest::Client;
use serde_json::Value;
use std::collections::HashSet;
use std::convert::Infallible;
use std::hash::{BuildHasher, Hasher};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tokio::net::TcpListener;

const PROXY_PREFIX: &str = "/bili-proxy";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/// 固定允许的 B 站域名后缀。媒体 CDN 另走进程内自证名单。
const ALLOWED_SUFFIX: &[&str] = &[
    ".bilibili.com",
    ".hdslb.com",
    ".bilivideo.com",
    ".bilivideo.cn",
    ".bilivideo.net",
    ".szbdyd.com",
    ".akamaized.net",
];

#[derive(Default)]
pub struct BiliProxyInner {
    media_hosts: Mutex<HashSet<String>>,
    base_url: RwLock<Option<String>>,
    /// 每次启动随机生成的回环代理令牌：浏览器里任何页面都能访问 127.0.0.1，
    /// 仅靠域名白名单不足以阻止别的网页借这个代理探测 B 站接口。
    token: RwLock<String>,
    /// 启动失败的原因（前端据此显示「代理没起来」而不是笼统的取流错误）
    error: RwLock<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliProxyStatus {
    pub ok: bool,
    pub base_url: String,
    pub token: String,
    pub error: String,
}

#[derive(Clone, Default)]
pub struct BiliProxyState {
    inner: Arc<BiliProxyInner>,
}

impl BiliProxyState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn base_url(&self) -> Result<String, String> {
        self.inner
            .base_url
            .read()
            .map_err(|_| "B 站代理状态不可用".to_string())?
            .clone()
            .ok_or_else(|| "B 站代理尚未启动".to_string())
    }

    pub fn status(&self) -> BiliProxyStatus {
        let base_url = self.inner.base_url.read().map(|v| v.clone()).unwrap_or_default().unwrap_or_default();
        let token = self.inner.token.read().map(|v| v.clone()).unwrap_or_default();
        let error = self.inner.error.read().map(|v| v.clone()).unwrap_or_default();
        BiliProxyStatus {
            ok: !base_url.is_empty() && error.is_empty(),
            base_url,
            token,
            error,
        }
    }

    fn set_base_url(&self, url: String) {
        if let Ok(mut v) = self.inner.base_url.write() {
            *v = Some(url);
        }
    }

    fn set_token(&self, value: String) {
        if let Ok(mut v) = self.inner.token.write() {
            *v = value;
        }
    }

    fn set_error(&self, message: String) {
        if let Ok(mut v) = self.inner.error.write() {
            *v = message;
        }
    }

    fn clear_error(&self) {
        if let Ok(mut v) = self.inner.error.write() {
            v.clear();
        }
    }

    fn token_matches(&self, supplied: &str) -> bool {
        let Ok(token) = self.inner.token.read() else {
            return false;
        };
        !token.is_empty() && token.as_str() == supplied
    }
}

/// 用进程级随机种子 + 时间生成代理令牌（不需要密码学强度，只要外部网页猜不到）。
fn new_proxy_token() -> String {
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    hasher.write_u128(nanos);
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

/// 令牌可以放请求头（fetch）或查询参数（`<video>` 改不了请求头）。
fn supplied_token(req: &Request<Incoming>) -> Option<String> {
    if let Some(value) = req.headers().get("x-kn-token").and_then(|v| v.to_str().ok()) {
        if !value.is_empty() {
            return Some(value.to_owned());
        }
    }
    let query = req.uri().query()?;
    query
        .split('&')
        .find_map(|part| part.strip_prefix("__kn=").map(|v| v.to_owned()))
}

fn allowed_host(host: &str, media_hosts: &HashSet<String>) -> bool {
    let h = host.trim().to_ascii_lowercase();
    if h.is_empty() || h.contains('/') || h.contains('@') {
        return false;
    }
    let bare = h.split(':').next().unwrap_or("");
    if media_hosts.contains(&h) || media_hosts.contains(bare) {
        return true;
    }
    bare == "bilibili.com" || ALLOWED_SUFFIX.iter().any(|s| bare.ends_with(s))
}

fn remember_media_host(raw: &str, hosts: &mut HashSet<String>) {
    let Ok(u) = reqwest::Url::parse(raw) else {
        return;
    };
    let path = u.path().to_ascii_lowercase();
    let media = [".m4s", ".mp4", ".m4a", ".flv", ".ts"]
        .iter()
        .any(|ext| path.ends_with(ext));
    if !media {
        return;
    }
    if let Some(host) = u.host_str() {
        hosts.insert(host.to_ascii_lowercase());
    }
}

fn remember_media_hosts_deep(node: &Value, hosts: &mut HashSet<String>) {
    match node {
        Value::String(s) => remember_media_host(s, hosts),
        Value::Array(a) => {
            for v in a {
                remember_media_hosts_deep(v, hosts);
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                remember_media_hosts_deep(v, hosts);
            }
        }
        _ => {}
    }
}

fn upstream_url(host: &str, path: &str) -> (String, Option<&'static str>) {
    let Some((base, query)) = path.split_once('?') else {
        return (format!("https://{host}{path}"), None);
    };
    let mut mark = None;
    let kept = query
        .split('&')
        .filter_map(|part| match part {
            "__ct=video" => { mark = Some("video"); None }
            "__ct=audio" => { mark = Some("audio"); None }
            other if other.starts_with("__kn=") => None,
            _ => Some(part),
        })
        .collect::<Vec<_>>()
        .join("&");
    let suffix = if kept.is_empty() { String::new() } else { format!("?{kept}") };
    (format!("https://{host}{base}{suffix}"), mark)
}

async fn proxy(
    req: Request<Incoming>,
    client: Client,
    state: BiliProxyState,
) -> Result<Response<BoxBody<Bytes>>, Infallible> {
    let method = req.method().clone();
    let uri_path = req.uri().path_and_query().map(|x| x.as_str()).unwrap_or("/").to_owned();
    let proxy_rest = uri_path
        .strip_prefix(PROXY_PREFIX)
        .map(|s| s.trim_start_matches('/').to_owned());
    let Some(rest) = proxy_rest else {
        return Ok(resp(StatusCode::NOT_FOUND, "不是 B 站代理路径", None));
    };
    let cut = rest.find('/').unwrap_or(rest.find('?').unwrap_or(rest.len()));
    if cut == 0 {
        return Ok(resp(StatusCode::BAD_REQUEST, "用法：/bili-proxy/<host>/<path>", None));
    }
    let host = rest[..cut].to_owned();
    let path = rest[cut..].to_owned();

    // fetch 带 x-bili-cookie 会先发预检；媒体元素本身发 GET。
    // 预检不带 Cookie，但仍要先通过主机白名单，避免代理被外站探测。
    if method == Method::OPTIONS {
        let authorized = state
            .inner
            .media_hosts
            .lock()
            .map(|set| allowed_host(&host, &set))
            .unwrap_or(false);
        if !authorized {
            return Ok(resp(StatusCode::FORBIDDEN, &format!("不允许代理的主机：{host}"), None));
        }
        let response: Response<BoxBody<Bytes>> = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header("access-control-allow-origin", "*")
            .header("access-control-allow-methods", "GET, HEAD, OPTIONS")
            .header("access-control-allow-headers", "x-bili-cookie, x-kn-token, range, accept, content-type")
            .header("access-control-max-age", "86400")
            .body(full_response(Full::new(Bytes::new())))
            .unwrap_or_else(|_| resp(StatusCode::INTERNAL_SERVER_ERROR, "预检构造失败", None));
        return Ok(response);
    }
    if method != Method::GET && method != Method::HEAD {
        return Ok(resp(StatusCode::METHOD_NOT_ALLOWED, "只允许 GET/HEAD/OPTIONS", None));
    }

    let authorized = state
        .inner
        .media_hosts
        .lock()
        .map(|set| allowed_host(&host, &set))
        .unwrap_or(false);
    if !authorized {
        return Ok(resp(StatusCode::FORBIDDEN, &format!("不允许代理的主机：{host}"), None));
    }

    // 回环端口对浏览器里的所有页面可见；令牌把「碰巧知道端口」与「本应用自己的请求」分开。
    if !state.token_matches(&supplied_token(&req).unwrap_or_default()) {
        return Ok(resp(StatusCode::FORBIDDEN, "缺少或错误的代理令牌", None));
    }

    let (url, ct_mark) = upstream_url(&host, &path);
    let is_playurl = url.contains("/x/player/playurl");
    let mut rb = client
        .request(method.clone(), &url)
        .header("Referer", "https://www.bilibili.com")
        .header("Origin", "https://www.bilibili.com")
        .header("User-Agent", UA)
        .header("Accept-Language", "zh-CN,zh;q=0.9");
    if let Some(ck) = req.headers().get("x-bili-cookie").and_then(|v| v.to_str().ok()) {
        rb = rb.header("Cookie", ck);
    }
    if let Some(range) = req.headers().get("range").and_then(|v| v.to_str().ok()) {
        rb = rb.header("Range", range);
    }
    if let Some(accept) = req.headers().get("accept").and_then(|v| v.to_str().ok()) {
        rb = rb.header("Accept", accept);
    } else if is_playurl {
        rb = rb.header("Accept", "application/json");
    }

    let upstream = match rb.send().await {
        Ok(r) => r,
        Err(e) => return Ok(resp(StatusCode::BAD_GATEWAY, &format!("proxy error: {e}"), None)),
    };
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let final_ct = if let Some(mark) = ct_mark {
        if mark == "audio" { "audio/mp4" } else { "video/mp4" }
    } else {
        upstream_headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
    };

    let mut out = Response::builder().status(status);
    // set-cookie 不能原样回给 WebView（会把 B 站 cookie 种到本机端口域名上），
    // 但扫码登录成功后 B 站可能只通过它下发 SESSDATA，所以改名为自定义头交给前端。
    let mut set_cookies: Vec<String> = Vec::new();
    for (k, v) in &upstream_headers {
        let name = k.as_str();
        // 逐跳头不能转发；content-length / content-encoding 必须原样保留——
        // 媒体是流式转发，丢了长度会让 <video> 无法定位进度，丢了编码会让字节与声明不符。
        if name == "set-cookie" {
            if let Ok(val) = v.to_str() {
                set_cookies.push(val.to_owned());
            }
            continue;
        }
        if matches!(name, "connection" | "transfer-encoding") {
            continue;
        }
        if let (Ok(n), Ok(val)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_bytes(v.as_bytes())) {
            out = out.header(n, val);
        }
    }
    out = out.header("access-control-allow-origin", "*");
    if !set_cookies.is_empty() {
        if let Ok(val) = HeaderValue::from_str(&set_cookies.join("|||")) {
            out = out.header("x-bili-set-cookie", val);
            out = out.header("access-control-expose-headers", "x-bili-set-cookie");
        }
    }
    out = out.header("content-type", final_ct);

    // HEAD 不需要 body；playurl 是小 JSON，必须读完才能记住媒体主机；
    // 其余（视频/音频/图片）直接流式转发，不再把整段媒体读进内存。
    if method == Method::HEAD {
        let body: BoxBody<Bytes> = full_response(Full::new(Bytes::new()));
        return Ok(out
            .body(body)
            .unwrap_or_else(|_| resp(StatusCode::INTERNAL_SERVER_ERROR, "代理响应构造失败", None)));
    }

    if is_playurl {
        let bytes = match upstream.bytes().await {
            Ok(b) => b,
            Err(e) => return Ok(resp(StatusCode::BAD_GATEWAY, &format!("proxy body error: {e}"), None)),
        };
        if let Ok(json) = serde_json::from_slice::<Value>(&bytes) {
            if let Ok(mut hosts) = state.inner.media_hosts.lock() {
                remember_media_hosts_deep(&json, &mut hosts);
            }
        }
        let body: BoxBody<Bytes> = full_response(Full::new(bytes));
        return Ok(out
            .body(body)
            .unwrap_or_else(|_| resp(StatusCode::INTERNAL_SERVER_ERROR, "代理响应构造失败", None)));
    }

    let stream = upstream
        .bytes_stream()
        .map_ok(Frame::data)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
    let body: BoxBody<Bytes> = StreamBody::new(stream).boxed_unsync();
    let response: Response<BoxBody<Bytes>> = out
        .body(body)
        .unwrap_or_else(|_| resp(StatusCode::INTERNAL_SERVER_ERROR, "代理响应构造失败", None));
    Ok(response)
}

type ProxyError = std::io::Error;

type BoxBody<T> = http_body_util::combinators::UnsyncBoxBody<T, ProxyError>;

fn full_response<T>(body: Full<T>) -> BoxBody<T>
where
    T: bytes::Buf + Send + Sync + 'static,
{
    let mapped = http_body_util::BodyExt::map_err(body, |never| match never {});
    http_body_util::BodyExt::boxed_unsync(mapped)
}

fn resp(
    status: StatusCode,
    text: &str,
    ct: Option<&str>,
) -> Response<BoxBody<Bytes>> {
    let body: BoxBody<Bytes> = full_response(Full::new(Bytes::from(text.to_owned())));
    Response::builder()
        .status(status)
        .header("access-control-allow-origin", "*")
        .header("content-type", ct.unwrap_or("text/plain; charset=utf-8"))
        .body(body)
        .unwrap_or_else(|_| {
            Response::new(full_response(Full::new(Bytes::new())))
        })
}

async fn serve(listener: TcpListener, client: Client, state: BiliProxyState) {
    loop {
        let Ok((stream, _peer)) = listener.accept().await else {
            continue;
        };
        let client = client.clone();
        let state = state.clone();
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let service = service_fn(move |req| proxy(req, client.clone(), state.clone()));
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, service)
                .await;
        });
    }
}

/// 启动代理并返回基址；由 lib.rs 的 setup 调用。失败只影响视频笔记，不影响主应用启动。
pub fn start(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<BiliProxyState>().inner().clone();
    match start_with_state(state.clone()) {
        Ok(()) => Ok(()),
        Err(error) => {
            // 把失败原因留在状态里：前端据此显示「代理没起来」，而不是笼统的取流失败。
            state.set_error(error.clone());
            Err(error)
        }
    }
}

fn start_with_state(state: BiliProxyState) -> Result<(), String> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("绑定 127.0.0.1:0 失败：{e}"))?;
    listener.set_nonblocking(true).map_err(|e| format!("设置非阻塞失败：{e}"))?;
    let addr: SocketAddr = listener.local_addr().map_err(|e| format!("读取代理端口失败：{e}"))?;
    state.set_token(new_proxy_token());
    state.set_base_url(format!("http://127.0.0.1:{}{PROXY_PREFIX}", addr.port()));
    state.clear_error();

    let client = Client::builder()
        // 视频请求可能持续较久；只限制等待响应头，不限制整个媒体 body。
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    // TcpListener::from_std 需要 Tokio reactor，而 start_with_state 由 setup 在主线程调用，
    // 此时没有运行时上下文，直接调用会 panic（"there is no reactor running"）并让整个应用
    // 在启动阶段退出。把转换挪进 spawn 的异步任务里，失败也只写进状态，不阻塞启动。
    tauri::async_runtime::spawn(async move {
        match TcpListener::from_std(listener) {
            Ok(async_listener) => serve(async_listener, client, state).await,
            Err(e) => state.set_error(format!("转换监听器失败：{e}")),
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_hex_and_new_each_time() {
        let a = new_proxy_token();
        let b = new_proxy_token();
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn host_allowlist_rejects_lookalikes() {
        let media: HashSet<String> = HashSet::new();
        assert!(allowed_host("api.bilibili.com", &media));
        assert!(allowed_host("upos-sz-mirror.bilivideo.com", &media));
        assert!(!allowed_host("evil-bilibili.com", &media));
        assert!(!allowed_host("bilibili.com.evil.test", &media));
        assert!(!allowed_host("user@api.bilibili.com", &media));
        assert!(!allowed_host("api.bilibili.com/path", &media));
    }

    #[test]
    fn upstream_url_strips_proxy_params_and_marks_kind() {
        let (url, kind) = upstream_url(
            "api.bilibili.com",
            "/x/player/playurl?__kn=abc&__ct=video&foo=1",
        );
        assert_eq!(still_proxy_marker(&url), false);
        assert!(url.contains("foo=1"));
        assert_eq!(kind, Some("video"));
    }

    fn still_proxy_marker(url: &str) -> bool {
        url.contains("__kn=") || url.contains("__ct=")
    }
}
