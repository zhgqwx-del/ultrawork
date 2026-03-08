use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            println!("Starting OpenCode Server sidecar...");
            match app.shell().sidecar("opencode-server") {
                Ok(sidecar_command) => {
                    match sidecar_command
                        .args(["serve", "--port", "4096"])
                        .env("OPENCODE_SERVER_PASSWORD", "test123")
                        .spawn()
                    {
                        Ok((_rx, _child)) => {
                            println!("OpenCode Server started successfully");
                        }
                        Err(e) => {
                            eprintln!("Failed to spawn OpenCode Server: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Failed to create sidecar command: {}", e);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
