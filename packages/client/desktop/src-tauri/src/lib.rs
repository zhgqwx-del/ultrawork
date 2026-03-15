use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const OPENCODE_PORT: u16 = 4096;
const GATEWAY_PORT: u16 = 4097;

fn is_port_in_use(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_ok()
}

/// HTTP health check with optional Authorization header.
fn check_health(port: u16, path: &str, auth: Option<&str>) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let auth_line = match auth {
        Some(a) => format!("Authorization: {}\r\n", a),
        None => String::new(),
    };
    let request = format!(
        "GET {} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\n{}\r\n",
        path, port, auth_line
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .ok();
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.contains("200")
}

fn kill_port_process(port: u16) {
    let Ok(output) = Command::new("lsof")
        .args(["-ti", &format!(":{}", port)])
        .output()
    else {
        return;
    };
    let pids = String::from_utf8_lossy(&output.stdout);
    for pid in pids.trim().lines() {
        let pid = pid.trim();
        if !pid.is_empty() {
            println!("Killing stale process {} on port {}", pid, port);
            Command::new("kill").arg(pid).output().ok();
        }
    }
    std::thread::sleep(Duration::from_millis(200));
}

/// Prepare a port: reuse healthy process, kill stale, or confirm free.
/// Returns Ok(true) if a healthy process is already running (skip spawn),
/// Ok(false) if port is free and ready for a new spawn.
fn prepare_port(port: u16, health_path: &str, health_auth: Option<&str>) -> Result<bool, String> {
    if is_port_in_use(port) {
        if check_health(port, health_path, health_auth) {
            return Ok(true); // reuse
        }
        println!("Port {} occupied but unhealthy, killing stale process", port);
        kill_port_process(port);
        if is_port_in_use(port) {
            return Err(format!(
                "Port {} is still in use after cleanup. Another application may be using it.",
                port
            ));
        }
    }
    Ok(false)
}

/// Spawn a sidecar binary using ShellExt (works with App or AppHandle).
fn spawn_sidecar<T: tauri_plugin_shell::ShellExt<tauri::Wry>>(
    shell_host: &T,
    name: &str,
    args: &[&str],
    env_vars: &[(&str, &str)],
) -> Result<(), String> {
    let sidecar = shell_host
        .shell()
        .sidecar(name)
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?;

    let mut cmd = sidecar.args(args);
    for (key, value) in env_vars {
        cmd = cmd.env(key, value);
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", name, e))?;

    Ok(())
}

/// Generic sidecar launcher with port probe, stale cleanup, and health reuse.
fn start_sidecar<T: tauri_plugin_shell::ShellExt<tauri::Wry>>(
    shell_host: &T,
    name: &str,
    port: u16,
    health_path: &str,
    health_auth: Option<&str>,
    args: &[&str],
    env_vars: &[(&str, &str)],
) -> Result<(), String> {
    let reused = prepare_port(port, health_path, health_auth)?;
    if reused {
        println!("{} already running on port {} (healthy), reusing", name, port);
        return Ok(());
    }

    spawn_sidecar(shell_host, name, args, env_vars)?;
    println!("{} started on port {}", name, port);
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct NodeInfo {
    path: String,
    version: String,
}

/// Build a rich PATH that includes common Node.js install locations.
/// macOS apps launched from Finder only see /usr/bin:/bin:/usr/sbin:/sbin,
/// so we must explicitly add homebrew, nvm, fnm, volta, etc.
fn rich_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let home = home.to_string_lossy();
    let current = std::env::var("PATH").unwrap_or_default();
    // Prepend common Node.js locations (order = priority)
    let extras = [
        format!("{home}/.volta/bin"),
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];

    // Discover version-manager-installed nodes (nvm, fnm) — newest first
    let version_dirs = [
        format!("{home}/.nvm/versions/node"),          // nvm
        format!("{home}/.local/share/fnm/node-versions"), // fnm (XDG)
        format!("{home}/.fnm/node-versions"),           // fnm (legacy)
    ];
    // Sub-path from version dir to bin: nvm uses "/bin", fnm uses "/installation/bin"
    let mut versioned_paths: Vec<(u32, String)> = Vec::new();
    for base in &version_dirs {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.filter_map(|e| e.ok()) {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let major: u32 = name.strip_prefix('v')
                    .and_then(|v| v.split('.').next())
                    .and_then(|m| m.parse().ok())
                    .unwrap_or(0);
                // Check both bin layouts: direct "bin/" (nvm) and "installation/bin/" (fnm)
                let direct = format!("{base}/{name}/bin");
                let nested = format!("{base}/{name}/installation/bin");
                if std::path::Path::new(&nested).join("node").exists() {
                    versioned_paths.push((major, nested));
                } else if std::path::Path::new(&direct).join("node").exists() {
                    versioned_paths.push((major, direct));
                }
            }
        }
    }
    // Also check fnm default alias
    let fnm_default = format!("{home}/.local/share/fnm/aliases/default/bin");
    if std::path::Path::new(&fnm_default).join("node").exists() {
        versioned_paths.push((999, fnm_default)); // highest priority
    }
    // Sort by major version descending
    versioned_paths.sort_by(|a, b| b.0.cmp(&a.0));

    let mut parts: Vec<String> = Vec::new();
    for (_, p) in &versioned_paths {
        parts.push(p.clone());
    }
    parts.extend(extras);
    parts.push(current);
    parts.join(":")
}

/// Detect system Node.js — returns path + version if ≥v20, None otherwise.
#[tauri::command]
fn detect_node() -> Option<NodeInfo> {
    let path_env = rich_path();

    // Use `which` with enriched PATH
    let node_path = Command::new("/usr/bin/which")
        .arg("node")
        .env("PATH", &path_env)
        .output()
        .ok()
        .and_then(|o| {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if p.is_empty() { None } else { Some(p) }
        })?;

    let output = Command::new(&node_path).arg("--version").output().ok()?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Parse major version from "v20.11.0" format
    let major: u32 = version
        .strip_prefix('v')
        .and_then(|v| v.split('.').next())
        .and_then(|m| m.parse().ok())
        .unwrap_or(0);

    if major >= 20 {
        Some(NodeInfo { path: node_path, version })
    } else {
        None
    }
}

/// Detect system Chrome browser path (macOS).
#[tauri::command]
fn detect_chrome() -> Option<String> {
    let candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|p| p.to_string())
}

/// Return the MCP install directory (~/.ultrawork/mcp/).
#[tauri::command]
fn get_mcp_install_dir() -> String {
    mcp_dir().to_string_lossy().to_string()
}

fn mcp_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".ultrawork")
        .join("mcp")
}

const BROWSER_MCP_ENTRY: &str =
    "node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js";

/// Check if chrome-devtools-mcp is installed.
#[tauri::command]
fn check_browser_mcp_installed() -> bool {
    mcp_dir().join(BROWSER_MCP_ENTRY).exists()
}

/// Install chrome-devtools-mcp via npm. Runs synchronously (call from async JS).
/// Returns the entry-point path on success.
#[tauri::command]
fn install_browser_mcp(node_path: String) -> Result<String, String> {
    let dir = mcp_dir();
    // Ensure directory exists
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;

    // Create package.json if missing
    let pkg_json = dir.join("package.json");
    if !pkg_json.exists() {
        std::fs::write(&pkg_json, r#"{"private":true}"#)
            .map_err(|e| format!("Failed to write package.json: {}", e))?;
    }

    // Derive npm path from node path (sibling binary)
    let node = std::path::Path::new(&node_path);
    let node_bin_dir = node.parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let npm_path = node.parent()
        .map(|p| p.join("npm"))
        .unwrap_or_else(|| PathBuf::from("npm"));

    // Ensure PATH includes node's bin dir so npm's `#!/usr/bin/env node` works
    let current_path = std::env::var("PATH").unwrap_or_default();
    let enriched_path = format!("{}:{}", node_bin_dir, current_path);

    // Run npm install
    let output = Command::new(&npm_path)
        .args(["install", "chrome-devtools-mcp@latest"])
        .current_dir(&dir)
        .env("PATH", &enriched_path)
        .output()
        .map_err(|e| format!("Failed to run npm: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install failed: {}", stderr));
    }

    // Verify entry point exists
    let entry = dir.join(BROWSER_MCP_ENTRY);
    if !entry.exists() {
        return Err("Installation completed but entry point not found".to_string());
    }

    Ok(entry.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            detect_node,
            detect_chrome,
            get_mcp_install_dir,
            check_browser_mcp_installed,
            install_browser_mcp,
        ])
        .setup(|app| {
            // Start Channel Gateway sidecar in background (non-critical, don't block UI)
            let gw_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = start_sidecar(
                    &gw_handle,
                    "channel-gateway",
                    GATEWAY_PORT,
                    "/channel/health",
                    None,
                    &[],
                    &[],
                ) {
                    eprintln!("Channel Gateway startup failed: {}", e);
                }
            });

            // Start OpenCode Server sidecar (critical — blocks until ready)
            let oc_port = OPENCODE_PORT.to_string();
            if let Err(e) = start_sidecar(
                app,
                "opencode-server",
                OPENCODE_PORT,
                "/global/health",
                Some("Basic b3BlbmNvZGU6dGVzdDEyMw=="), // opencode:test123
                &["serve", "--port", &oc_port],
                &[("OPENCODE_SERVER_PASSWORD", "test123")],
            ) {
                eprintln!("OpenCode Server startup failed: {}", e);
                app.dialog()
                    .message(format!(
                        "Failed to start OpenCode Server:\n\n{}\n\nThe application may not work correctly.",
                        e
                    ))
                    .kind(MessageDialogKind::Error)
                    .title("Startup Error")
                    .blocking_show();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
