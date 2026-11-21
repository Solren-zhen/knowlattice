//! 手机背诵包的一次性局域网同步。
//!
//! 桌面端只监听本机 LAN 地址的临时端口；二维码里带随机 token。
//! 背诵包取一次后 token 失效，但服务会继续留 60 分钟接收手机回传的复习事件
//! （`POST /review`）；笔记包没有回传端点，取包后照旧立即停止。
//! 不依赖额外框架：一个非阻塞 TcpListener 线程足够，也避免在 Windows 上引入新的运行时。

use serde::Serialize;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/** 背诵包：手机可能背十几分钟到半小时，服务要活到回传完成。 */
const RECITE_EXPIRES_SECS: u64 = 3600;
/** 笔记包只取一次，没有回传，保持 5 分钟即可。 */
const NOTE_EXPIRES_SECS: u64 = 300;
/** 回传包上限：手机端一次发送全部事件，留足余量但不让服务被超大请求拖垮。 */
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_REVIEW_EVENTS: usize = 20_000;

pub type ReviewSink = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Default)]
pub struct ReciteSyncState {
    inner: Arc<Mutex<Option<Session>>>,
}

struct Session {
    stop: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReciteSyncInfo {
    pub url: String,
    pub landing_url: String,
    pub deep_link: String,
    pub expires_in: u64,
    pub ip: String,
    pub port: u16,
}

impl ReciteSyncState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&self, pack: String, on_review: ReviewSink) -> Result<ReciteSyncInfo, String> {
        let pack = pack.trim().to_owned();
        if pack.is_empty() {
            return Err("背诵包为空，无法生成二维码。".into());
        }
        let parsed: serde_json::Value =
            serde_json::from_str(&pack).map_err(|e| format!("背诵包不是合法 JSON：{e}"))?;
        let has_story = parsed
            .get("stories")
            .and_then(|value| value.as_array())
            .map(|stories| !stories.is_empty())
            .unwrap_or(false);
        // 笔记包（knowlattice.notes/1）没有 stories，正文在 notes 里；
        // 它与背诵包共用同一个临时服务，不能按短文包判空。
        let has_notes = parsed
            .get("notes")
            .and_then(|value| value.as_array())
            .map(|notes| !notes.is_empty())
            .unwrap_or(false);
        if !has_story && !has_notes {
            return Err("同步包里没有可导入的内容。".into());
        }
        // 只有背诵包需要手机回传；笔记包保持「取一次即停」的旧行为。
        let allow_review = parsed.get("schema").and_then(|value| value.as_str())
            == Some("knowlattice.recite/1");
        let expires_secs = if allow_review { RECITE_EXPIRES_SECS } else { NOTE_EXPIRES_SECS };

        let ip = local_ipv4()
            .ok_or_else(|| "没有检测到局域网 IPv4 地址，请先连接 Wi-Fi 或有线网络。".to_string())?;
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .map_err(|e| format!("无法启动临时同步端口：{e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("无法配置同步端口：{e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("无法读取同步端口：{e}"))?
            .port();

        let token = new_token();
        let url = format!("http://{ip}:{port}/pack?token={token}");
        let landing_url = format!("http://{ip}:{port}/import?token={token}");
        let deep_link = format!("knowlattice-recite://import?src={}", percent_encode(&url));
        let stop = Arc::new(AtomicBool::new(false));
        let packed = Arc::new(AtomicBool::new(false));
        let pack = Arc::new(pack);

        if let Ok(mut slot) = self.inner.lock() {
            if let Some(previous) = slot.take() {
                previous.stop.store(true, Ordering::SeqCst);
            }
            *slot = Some(Session { stop: stop.clone() });
        }

        let serve_stop = stop.clone();
        let serve_pack = pack.clone();
        let serve_token = token.clone();
        let serve_deep_link = deep_link.clone();
        std::thread::spawn(move || {
            serve(
                listener,
                serve_token,
                serve_pack,
                serve_stop,
                serve_deep_link,
                packed,
                allow_review,
                expires_secs,
                on_review,
            );
        });

        Ok(ReciteSyncInfo {
            url,
            landing_url,
            deep_link,
            expires_in: expires_secs,
            ip,
            port,
        })
    }

    pub fn stop(&self) {
        if let Ok(mut slot) = self.inner.lock() {
            if let Some(session) = slot.take() {
                session.stop.store(true, Ordering::SeqCst);
            }
        }
    }
}

fn serve(
    listener: TcpListener,
    token: String,
    pack: Arc<String>,
    stop: Arc<AtomicBool>,
    deep_link: String,
    packed: Arc<AtomicBool>,
    allow_review: bool,
    expires_secs: u64,
    on_review: ReviewSink,
) {
    let deadline = Instant::now() + Duration::from_secs(expires_secs);
    while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _peer)) => {
                let _ = handle(
                    &mut stream,
                    &token,
                    pack.as_bytes(),
                    &stop,
                    &deep_link,
                    &packed,
                    allow_review,
                    &on_review,
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(_) => break,
        }
    }
}

struct HttpRequest {
    method: String,
    target: String,
    body: Vec<u8>,
}

fn header_end(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(head: &str) -> usize {
    head.lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0)
}

/// 读完整个 HTTP 请求：先读头，再按 Content-Length 读正文。
/// 桌面端只服务 GET 和体积受控的 POST，不需要支持 chunked。
fn read_request(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
    let mut data = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut expected_body: Option<usize> = None;
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        data.extend_from_slice(&buffer[..read]);
        if data.len() > MAX_BODY_BYTES + 16 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request too large",
            ));
        }
        if let Some(end) = header_end(&data) {
            if expected_body.is_none() {
                let head = String::from_utf8_lossy(&data[..end]);
                expected_body = Some(content_length(&head));
            }
            if data.len() >= end + 4 + expected_body.unwrap_or(0) {
                break;
            }
        }
    }

    let end = header_end(&data).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "incomplete headers")
    })?;
    let head = String::from_utf8_lossy(&data[..end]).into_owned();
    let first = head.lines().next().unwrap_or_default();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let target = parts.next().unwrap_or_default().to_owned();
    let body = data[end + 4..].to_vec();
    Ok(HttpRequest { method, target, body })
}

fn handle(
    stream: &mut TcpStream,
    token: &str,
    pack: &[u8],
    stop: &AtomicBool,
    deep_link: &str,
    packed: &AtomicBool,
    allow_review: bool,
    on_review: &ReviewSink,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    // 手机请求很小，禁用 Nagle 能把「扫码 → 落地页」的等待再削掉一截。
    let _ = stream.set_nodelay(true);
    let request = match read_request(stream) {
        Ok(request) => request,
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
            || error.kind() == std::io::ErrorKind::TimedOut =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };

    if request.method == "OPTIONS" {
        return respond(stream, 204, "text/plain; charset=utf-8", b"", None);
    }
    let (path, query) = request.target.split_once('?').unwrap_or((request.target.as_str(), ""));
    if path != "/pack" && path != "/import" && path != "/review" {
        return respond(stream, 404, "text/plain; charset=utf-8", b"not found", None);
    }
    let supplied = query
        .split('&')
        .find_map(|part| part.strip_prefix("token="))
        .unwrap_or_default();
    if supplied != token {
        return respond(stream, 403, "text/plain; charset=utf-8", b"forbidden", None);
    }

    if path == "/import" {
        if request.method != "GET" {
            return respond(stream, 405, "text/plain; charset=utf-8", b"method not allowed", None);
        }
        let page = landing_page(deep_link, token, allow_review);
        return respond(stream, 200, "text/html; charset=utf-8", page.as_bytes(), None);
    }

    if path == "/review" {
        if !allow_review {
            return respond(stream, 404, "text/plain; charset=utf-8", b"not found", None);
        }
        if request.method != "POST" {
            return respond(stream, 405, "text/plain; charset=utf-8", b"method not allowed", None);
        }
        let received = match count_review_events(&request.body) {
            Ok(count) => count,
            Err(message) => {
                return respond(
                    stream,
                    400,
                    "text/plain; charset=utf-8",
                    message.as_bytes(),
                    None,
                )
            }
        };
        on_review(String::from_utf8_lossy(&request.body).into_owned());
        let body = format!("{{\"ok\":true,\"received\":{received}}}");
        return respond(stream, 200, "application/json; charset=utf-8", body.as_bytes(), None);
    }

    // /pack：背诵包只允许取一次；取完继续留 60 分钟接收 /review。
    if request.method != "GET" {
        return respond(stream, 405, "text/plain; charset=utf-8", b"method not allowed", None);
    }
    if packed.swap(true, Ordering::SeqCst) {
        return respond(stream, 409, "text/plain; charset=utf-8", b"pack already fetched", None);
    }
    let filename = if allow_review {
        "knowlattice-recite.klpack"
    } else {
        "knowlattice-notes.klnotes"
    };
    respond(stream, 200, "application/json; charset=utf-8", pack, Some(filename))?;
    if !allow_review {
        stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn count_review_events(body: &[u8]) -> Result<usize, String> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "回传内容不是合法 JSON。".to_string())?;
    if value.get("schema").and_then(|item| item.as_str()) != Some("knowlattice.review/1") {
        return Err("回传包版本不受支持。".into());
    }
    let events = value
        .get("events")
        .and_then(|item| item.as_array())
        .ok_or_else(|| "回传包缺少 events 数组。".to_string())?;
    if events.len() > MAX_REVIEW_EVENTS {
        return Err("回传事件过多。".into());
    }
    Ok(events.len())
}

/// 二维码落地页：手机相机打开后的第一屏。
/// 保持零外部资源，深浅色跟随系统，提供 App 直跳、复制链接和离线包文件下载三种降级路径。
fn landing_page(deep_link: &str, token: &str, allow_review: bool) -> String {
    const STYLE: &str = r#"<style>
:root{color-scheme:light dark;--bg:#f7f8fb;--paper:#fff;--ink:#0f172a;--muted:#475569;--accent:#4f46e5;--on-accent:#fff;--line:rgba(15,23,42,.10);--btn-sec-bg:rgba(79,70,229,.08);--btn-sec-ink:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#08090d;--paper:#0f121a;--ink:#f8fafc;--muted:#94a3b8;--accent:#a5b4fc;--on-accent:#08090d;--line:rgba(255,255,255,.10);--btn-sec-bg:rgba(165,180,252,.12);--btn-sec-ink:#c7d2fe}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(600px 320px at 50% -10%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 70%),var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.card{width:min(360px,100%);padding:28px 24px;border:1px solid var(--line);border-radius:16px;background:var(--paper);box-shadow:0 24px 55px -38px rgba(15,23,42,.35);text-align:center}
.mark{display:grid;place-items:center;width:52px;height:52px;margin:0 auto 16px;border-radius:14px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)}
h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}
p{margin:10px 0 0;color:var(--muted);font-size:14px;line-height:1.65}
.dot{display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background:var(--accent);animation:pulse 1.6s ease-in-out infinite}
.btn-group{display:flex;flex-direction:column;gap:10px;margin-top:20px}
a.btn,button.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:46px;border:none;border-radius:12px;font-weight:650;font-size:15px;text-decoration:none;cursor:pointer;font-family:inherit}
a.btn-primary{background:var(--accent);color:var(--on-accent)}
button.btn-secondary{background:var(--btn-sec-bg);color:var(--btn-sec-ink)}
a.btn-link{display:inline-block;margin-top:4px;padding:6px 8px;color:var(--accent);font-size:13px;font-weight:600;text-decoration:none}
.hint{margin-top:12px;font-size:12px;color:var(--muted);line-height:1.55}
@keyframes pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>"#;
    let filename = if allow_review {
        "knowlattice-recite.klpack"
    } else {
        "knowlattice-notes.klnotes"
    };
    let pack_href = format!("/pack?token={token}");
    let body = format!(
        r#"<div class="card"><div class="mark"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><g fill="currentColor"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></g></svg></div><h1>正在打开晶格背诵</h1><p><span class="dot"></span>手机即将跳转到 App 完成导入</p><div class="btn-group"><a class="btn btn-primary" href="{deep_link}">打开晶格背诵</a><button class="btn btn-secondary" type="button" id="copyBtn" onclick="copyPackLink()">复制同步链接</button><a class="btn-link" href="{pack_href}" download="{filename}">或下载同步包文件（{filename}）</a></div><p class="hint" id="statusHint">若使用网页版或未装 App，可点「复制同步链接」后切回晶格背诵点「粘贴电脑链接」，或下载文件后点「文件 / 扫码截图」导入。</p></div><script>var dl={js_link};window.location.replace(dl);function copyPackLink(){{var url=window.location.href;if(navigator.clipboard&&navigator.clipboard.writeText){{navigator.clipboard.writeText(url).then(function(){{notifyCopied()}}).catch(function(){{fallbackCopy(url)}})}}else{{fallbackCopy(url)}}}}function fallbackCopy(text){{var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{{document.execCommand('copy');notifyCopied()}}catch(e){{}}document.body.removeChild(ta)}}function notifyCopied(){{var btn=document.getElementById('copyBtn');if(btn)btn.innerText='链接已复制 ✓';var hint=document.getElementById('statusHint');if(hint)hint.innerText='链接已复制！切到晶格背诵点「粘贴电脑链接」即可自动导入。';}}</script>"#,
        deep_link = deep_link,
        pack_href = pack_href,
        filename = filename,
        js_link = serde_json::to_string(deep_link).unwrap_or_else(|_| "\"\"".to_string()),
    );
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\"><meta name=\"theme-color\" content=\"#f7f8fb\"><title>打开晶格背诵</title>{STYLE}</head><body>{body}</body></html>"
    )
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    download_name: Option<&str>,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        _ => "Error",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Referrer-Policy: no-referrer\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Access-Control-Max-Age: 600\r\n\
         Connection: close\r\n",
        body.len()
    );
    if let Some(filename) = download_name {
        head.push_str(&format!(
            "Content-Disposition: attachment; filename=\"{filename}\"\r\n"
        ));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    if status != 204 {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn local_ipv4() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // UDP connect 不会真的发包，只让系统选择默认出口与本地地址。
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip.to_string()),
        _ => None,
    }
}

fn new_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut first = std::collections::hash_map::RandomState::new().build_hasher();
    first.write_u128(nanos);
    first.write_u32(std::process::id());
    let mut second = std::collections::hash_map::RandomState::new().build_hasher();
    second.write_u128(nanos ^ 0x9e37_79b9_7f4a_7c15);
    second.write_u8(0xa5);
    format!("{:016x}{:016x}", first.finish(), second.finish())
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::Shutdown;

    fn serve_requests(
        token: &str,
        pack: &[u8],
        deep_link: &str,
        allow_review: bool,
        requests: Vec<String>,
    ) -> (Vec<String>, bool, Vec<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test listener");
        let address = listener.local_addr().expect("test address");
        let token = token.to_owned();
        let pack = pack.to_vec();
        let deep_link = deep_link.to_owned();
        let stop = Arc::new(AtomicBool::new(false));
        let packed = Arc::new(AtomicBool::new(false));
        let reviews = Arc::new(Mutex::new(Vec::<String>::new()));
        let thread_stop = stop.clone();
        let thread_packed = packed.clone();
        let thread_reviews = reviews.clone();
        let sink: ReviewSink = Arc::new(move |payload: String| {
            thread_reviews.lock().expect("review lock").push(payload);
        });
        let thread_requests = requests.clone();
        let server = std::thread::spawn(move || {
            for _ in &thread_requests {
                let (mut stream, _) = listener.accept().expect("accept test request");
                handle(
                    &mut stream,
                    &token,
                    &pack,
                    &thread_stop,
                    &deep_link,
                    &thread_packed,
                    allow_review,
                    &sink,
                )
                .expect("handle test request");
                let _ = stream.shutdown(Shutdown::Both);
            }
        });
        let mut responses = Vec::new();
        for request in &requests {
            let mut client = TcpStream::connect(address).expect("connect test client");
            client.write_all(request.as_bytes()).expect("write test request");
            client.shutdown(Shutdown::Write).expect("shutdown test write");
            let mut response = String::new();
            client.read_to_string(&mut response).expect("read test response");
            responses.push(response);
        }
        server.join().expect("join test server");
        let received = reviews.lock().expect("review lock").clone();
        (responses, stop.load(Ordering::SeqCst), received)
    }

    fn review_request(body: &str) -> String {
        format!(
            "POST /review?token=abc123 HTTP/1.1\r\nHost: test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn percent_encodes_the_deep_link_source() {
        assert_eq!(percent_encode("http://192.168.1.2:8080/pack?token=a"), "http%3A%2F%2F192.168.1.2%3A8080%2Fpack%3Ftoken%3Da");
    }

    #[test]
    fn serves_landing_page_then_pack_once_for_recite() {
        let (responses, stopped, _) = serve_requests(
            "abc123",
            b"{\"stories\":[]}",
            "knowlattice-recite://import?src=http%3A%2F%2F192.168.1.2%2Fpack",
            true,
            vec![
                "GET /import?token=abc123 HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n".into(),
                "GET /pack?token=abc123 HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n".into(),
                "GET /pack?token=abc123 HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n".into(),
            ],
        );
        assert!(responses[0].starts_with("HTTP/1.1 200"));
        assert!(responses[0].contains("正在打开晶格背诵"));
        assert!(responses[0].contains("/pack?token=abc123"));
        assert!(responses[1].starts_with("HTTP/1.1 200"));
        assert!(responses[1].contains("knowlattice-recite.klpack"));
        assert!(responses[1].contains("{\"stories\":[]}"));
        assert!(responses[2].starts_with("HTTP/1.1 409"));
        assert!(!stopped);
    }

    #[test]
    fn stops_after_pack_when_review_is_not_allowed() {
        let (responses, stopped, _) = serve_requests(
            "abc123",
            b"{\"notes\":[]}",
            "knowlattice-recite://import?src=x",
            false,
            vec!["GET /pack?token=abc123 HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n".into()],
        );
        assert!(responses[0].starts_with("HTTP/1.1 200"));
        assert!(stopped);
    }

    #[test]
    fn accepts_review_events_and_forwards_them_to_the_sink() {
        let body = r#"{"schema":"knowlattice.review/1","device":"d1","events":[{"id":"e1","word":"abandon","correct":true,"at":1700000000000,"device":"d1"}]}"#;
        let (responses, stopped, reviews) = serve_requests(
            "abc123",
            b"{\"stories\":[]}",
            "knowlattice-recite://import?src=x",
            true,
            vec![
                "GET /pack?token=abc123 HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n".into(),
                review_request(body),
            ],
        );
        assert!(responses[1].starts_with("HTTP/1.1 200"));
        assert!(responses[1].contains("\"received\":1"));
        assert_eq!(reviews.len(), 1);
        assert!(reviews[0].contains("knowlattice.review/1"));
        assert!(!stopped);
    }

    #[test]
    fn rejects_unknown_review_payloads() {
        let (responses, _, reviews) = serve_requests(
            "abc123",
            b"{\"stories\":[]}",
            "knowlattice-recite://import?src=x",
            true,
            vec![review_request(r#"{"schema":"unknown","events":[]}"#)],
        );
        assert!(responses[0].starts_with("HTTP/1.1 400"));
        assert!(reviews.is_empty());
    }

    #[test]
    fn hides_review_endpoint_for_note_packs() {
        let (responses, _, _) = serve_requests(
            "abc123",
            b"{\"notes\":[]}",
            "knowlattice-recite://import?src=x",
            false,
            vec![review_request(r#"{"schema":"knowlattice.review/1","events":[]}"#)],
        );
        assert!(responses[0].starts_with("HTTP/1.1 404"));
    }
}
