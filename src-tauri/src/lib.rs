#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 窗口层无需额外配置；数据仍走 WebAdapter（IndexedDB），
            // 后续想换成原生文件系统时再接入 storage/tauri.ts。
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}