use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let sidecar_command = app.shell().sidecar("opencode-server")?;
            let (_rx, _child) = sidecar_command
                .args(["serve", "--port", "4096", "--password", "test123"])
                .spawn()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
