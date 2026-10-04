use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// 持久化所选 vault 目录的文件（位于应用数据目录）。
/// fs 插件的运行时作用域不跨重启保留，重启后靠 setup 阶段读这个文件恢复授权。
const VAULT_DIR_FILE: &str = "vault-dir.txt";

/// 前端通过系统目录选择框选定 vault 后调用：扩展 fs 运行时作用域并持久化。
/// `dir` 为空 = 回到默认库（<文档>/KnowLattice，静态 capability 已授权），清除自定义记录。
#[tauri::command]
fn set_vault_dir(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join(VAULT_DIR_FILE);
    let dir = dir.trim();
    if dir.is_empty() {
        let _ = std::fs::remove_file(&file);
        return Ok(());
    }
    let path = std::path::PathBuf::from(dir);
    if !path.is_absolute() {
        return Err(format!("vault 目录必须是绝对路径：{dir}"));
    }
    app.fs_scope()
        .allow_directory(path, true)
        .map_err(|e| format!("无法授权目录 {dir}：{e}"))?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建应用数据目录：{e}"))?;
    }
    std::fs::write(&file, dir).map_err(|e| format!("无法持久化 vault 目录：{e}"))?;
    Ok(())
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
        .setup(|app| {
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
        .invoke_handler(tauri::generate_handler![set_vault_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
