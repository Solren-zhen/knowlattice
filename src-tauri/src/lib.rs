use tauri::Manager;
use tauri_plugin_fs::FsExt;

mod bili_proxy;

/// 命令错误的统一形状：前端按 `code` 分支，按 `message` 展示。
/// 旧实现直接返回 String，前端只能看到一段中文，无法区分「没权限 / 没启动 / 网络失败」。
#[derive(serde::Serialize)]
struct AppError {
    code: &'static str,
    message: String,
}

impl AppError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// 持久化所选 vault 目录的文件（位于应用数据目录）。
/// fs 插件的运行时作用域不跨重启保留，重启后靠 setup 阶段读这个文件恢复授权。
const VAULT_DIR_FILE: &str = "vault-dir.txt";

/// 前端通过系统目录选择框选定 vault 后调用：扩展 fs 运行时作用域并持久化。
/// `dir` 为空 = 回到默认库（<文档>/KnowLattice，静态 capability 已授权），清除自定义记录。
#[tauri::command]
fn set_vault_dir(app: tauri::AppHandle, dir: String) -> Result<(), AppError> {
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::new("app_data_unavailable", format!("无法定位应用数据目录：{e}")))?
        .join(VAULT_DIR_FILE);
    let dir = dir.trim();
    if dir.is_empty() {
        let _ = std::fs::remove_file(&file);
        return Ok(());
    }
    let path = std::path::PathBuf::from(dir);
    if !path.is_absolute() {
        return Err(AppError::new("vault_not_absolute", format!("vault 目录必须是绝对路径：{dir}")));
    }
    // 不存在的目录授权了也用不了；先校验再授权，失败时前端能拿到可区分的原因。
    if !path.is_dir() {
        return Err(AppError::new("vault_not_dir", format!("目录不存在或不是文件夹：{dir}")));
    }
    let path = path.canonicalize().unwrap_or(path);
    app.fs_scope()
        .allow_directory(&path, true)
        .map_err(|e| AppError::new("vault_auth_failed", format!("无法授权目录 {}：{e}", path.display())))?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::new("vault_persist_failed", format!("无法创建应用数据目录：{e}")))?;
    }
    std::fs::write(&file, path.to_string_lossy().as_bytes())
        .map_err(|e| AppError::new("vault_persist_failed", format!("无法持久化 vault 目录：{e}")))?;
    Ok(())
}

/// 返回桌面版 B 站代理的基址与一次性令牌（例如 http://127.0.0.1:xxxxx/bili-proxy）。
/// 页面加载后只调用一次；代理只监听回环地址，不暴露给局域网。
#[tauri::command]
fn bili_proxy_base(state: tauri::State<'_, bili_proxy::BiliProxyState>) -> Result<String, AppError> {
    state
        .base_url()
        .map_err(|e| AppError::new("bili_proxy_unavailable", e))
}

/// 带状态的代理信息：前端用它区分「没启动 / 启动失败」，并把令牌拼进媒体地址。
#[tauri::command]
fn bili_proxy_status(state: tauri::State<'_, bili_proxy::BiliProxyState>) -> bili_proxy::BiliProxyStatus {
    state.status()
}

const AI_KEY_SERVICE: &str = "com.jophy.knowlattice";
const AI_KEY_ACCOUNT: &str = "ai-agent-api-key";

fn ai_key_entry() -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(AI_KEY_SERVICE, AI_KEY_ACCOUNT)
        .map_err(|e| AppError::new("credential_unavailable", format!("无法打开系统凭据库：{e}")))
}

/// AI API Key：桌面端存 Windows Credential Manager / macOS Keychain / Linux Secret Service，
/// 不进入 WebView 的 localStorage。服务名与账号固定在后端，前端不能读取其他凭据。
#[tauri::command]
fn save_ai_api_key(key: String) -> Result<(), AppError> {
    let entry = ai_key_entry()?;
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::new("credential_delete_failed", format!("无法删除系统凭据：{e}"))),
        }
    } else {
        entry
            .set_password(&key)
            .map_err(|e| AppError::new("credential_save_failed", format!("无法保存系统凭据：{e}")))
    }
}

#[tauri::command]
fn load_ai_api_key() -> Result<String, AppError> {
    let entry = ai_key_entry()?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(AppError::new("credential_load_failed", format!("无法读取系统凭据：{e}"))),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 本地文件系统 Vault：笔记/附件写进用户所选文件夹（默认 <文档>/KnowLattice，
        // 前端经 @tauri-apps/plugin-fs 调用；自定义目录由 set_vault_dir 运行时授权）
        .plugin(tauri_plugin_fs::init())
        // 系统目录选择框：首次启动 / 设置里选择 vault 文件夹（前端经 @tauri-apps/plugin-dialog 调用）
        .plugin(tauri_plugin_dialog::init())
        // 自动更新：检查 / 下载 / 签名校验（前端经 @tauri-apps/plugin-updater 调用）
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新下载完成后重启应用生效
        .plugin(tauri_plugin_process::init())
        // 桌面安装版没有 Vite 的 /bili-proxy；启动本机回环代理，
        // 前端通过 bili_proxy_base 拿到端口。失败不阻塞主应用启动。
        .manage(bili_proxy::BiliProxyState::new())
        .setup(|app| {
            if let Err(e) = bili_proxy::start(app.handle().clone()) {
                eprintln!("[bili-proxy] {e}");
            }
            // 恢复上次会话授权的自定义 vault 目录：必须赶在页面发起第一次 fs 调用之前
            if let Ok(data_dir) = app.path().app_data_dir() {
                if let Ok(dir) = std::fs::read_to_string(data_dir.join(VAULT_DIR_FILE)) {
                    let dir = dir.trim();
                    if !dir.is_empty() {
                        // 授权失败只能忽略：前端启动后还会经 set_vault_dir 重申，届时会向用户报错
                        let _ = app.fs_scope().allow_directory(std::path::PathBuf::from(dir), true);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_vault_dir,
            bili_proxy_base,
            bili_proxy_status,
            save_ai_api_key,
            load_ai_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
