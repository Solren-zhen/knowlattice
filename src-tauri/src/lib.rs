#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 自动更新：检查 / 下载 / 签名校验（前端经 @tauri-apps/plugin-updater 调用）
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新下载完成后重启应用生效
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 窗口层无需额外配置；数据仍走 WebAdapter（IndexedDB），
            // 后续想换成原生文件系统时再接入 storage/tauri.ts。
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
