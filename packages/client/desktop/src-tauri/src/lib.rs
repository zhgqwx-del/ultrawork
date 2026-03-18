use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
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

// ── Browser MCP types ──────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct NodeInfo {
    path: String,
    version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BrowserMode {
    Playwright,
    Devtools,
}

#[derive(Debug, Serialize)]
pub struct BrowserEnvInfo {
    /// Path to the Node.js binary (embedded or system fallback)
    node_path: String,
    /// Node.js version string (e.g. "v22.16.0")
    node_version: String,
    /// Whether this is the embedded Node.js (true) or system fallback (false)
    node_embedded: bool,
    /// Path to system Chrome, if found
    chrome_path: Option<String>,
    /// Whether Playwright MCP is installed
    playwright_installed: bool,
    /// Whether DevTools MCP is installed
    devtools_installed: bool,
    /// Current browser mode preference
    mode: BrowserMode,
    /// MCP install directory
    mcp_dir: String,
}

// ── Paths ──────────────────────────────────────────────────────────

fn ultrawork_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".ultrawork")
}

fn mcp_dir() -> PathBuf {
    ultrawork_dir().join("mcp")
}

fn embedded_node_dir() -> PathBuf {
    ultrawork_dir().join("node")
}

fn embedded_node_bin() -> PathBuf {
    embedded_node_dir().join("bin").join("node")
}

fn mode_file() -> PathBuf {
    ultrawork_dir().join("browser-mode.json")
}

const PLAYWRIGHT_MCP_DIR: &str = "playwright";
const DEVTOOLS_MCP_DIR: &str = "chrome-devtools";
const PLAYWRIGHT_MCP_ENTRY: &str = "node_modules/@playwright/mcp/cli.js";
const DEVTOOLS_MCP_ENTRY: &str =
    "node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js";

// ── Node.js download (on-demand) ───────────────────────────────────

const NODE_VERSION: &str = "v22.16.0";

/// Download Node.js from nodejs.org to ~/.ultrawork/node/ on first use.
/// Idempotent — returns immediately if already downloaded.
/// Runs on async thread to avoid blocking the UI during download.
#[tauri::command(async)]
fn download_node() -> Result<NodeInfo, String> {
    let target_node = embedded_node_bin();

    // Already downloaded — just return version
    if target_node.exists() {
        return get_embedded_node_info();
    }

    let node_dir = embedded_node_dir();
    let tmp_dir = ultrawork_dir().join(".node-tmp");

    // Determine platform + arch
    let (platform, arch) = get_platform_arch()?;
    let tarball_name = format!("node-{}-{}-{}.tar.gz", NODE_VERSION, platform, arch);
    let url = format!("https://nodejs.org/dist/{}/{}", NODE_VERSION, tarball_name);
    let extracted_dir = format!("node-{}-{}-{}", NODE_VERSION, platform, arch);

    // Clean up any previous temp
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Download tarball via curl
    let tarball_path = tmp_dir.join(&tarball_name);
    let output = Command::new("curl")
        .args(["-fSL", "-o", &tarball_path.to_string_lossy(), &url])
        .output()
        .map_err(|e| format!("Failed to run curl: {}", e))?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Download failed: {}", stderr));
    }

    // Extract node binary
    let output = Command::new("tar")
        .args([
            "-xzf", &tarball_path.to_string_lossy(),
            "-C", &tmp_dir.to_string_lossy(),
            &format!("{}/bin/node", extracted_dir),
            &format!("{}/bin/npm", extracted_dir),
            &format!("{}/lib/node_modules/npm", extracted_dir),
        ])
        .output()
        .map_err(|e| format!("Failed to extract: {}", e))?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err("Failed to extract Node.js tarball".to_string());
    }

    // Create target directories
    let target_bin = node_dir.join("bin");
    let target_lib = node_dir.join("lib").join("node_modules");
    std::fs::create_dir_all(&target_bin)
        .map_err(|e| format!("Failed to create {}: {}", target_bin.display(), e))?;
    std::fs::create_dir_all(&target_lib)
        .map_err(|e| format!("Failed to create {}: {}", target_lib.display(), e))?;

    // Copy node binary
    let src_node = tmp_dir.join(&extracted_dir).join("bin/node");
    std::fs::copy(&src_node, &target_node)
        .map_err(|e| format!("Failed to copy node: {}", e))?;
    set_executable(&target_node)?;

    // Strip debug symbols to reduce size (~105MB → ~84MB)
    let _ = Command::new("strip").arg(&target_node).output();
    // Re-sign after strip (macOS requires valid signature)
    let _ = Command::new("codesign")
        .args(["--remove-signature", &target_node.to_string_lossy()])
        .output();
    let _ = Command::new("codesign")
        .args(["-s", "-", &target_node.to_string_lossy()])
        .output();

    // Copy npm lib
    let src_npm_lib = tmp_dir.join(&extracted_dir).join("lib/node_modules/npm");
    if src_npm_lib.exists() {
        let target_npm_lib = target_lib.join("npm");
        if target_npm_lib.exists() {
            std::fs::remove_dir_all(&target_npm_lib).ok();
        }
        copy_dir_recursive(&src_npm_lib, &target_npm_lib)?;
    }

    // Clean up temp
    let _ = std::fs::remove_dir_all(&tmp_dir);

    get_embedded_node_info()
}

fn get_platform_arch() -> Result<(&'static str, &'static str), String> {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err("Unsupported platform".to_string());
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        return Err("Unsupported architecture".to_string());
    };
    Ok((platform, arch))
}

fn get_embedded_node_info() -> Result<NodeInfo, String> {
    let node = embedded_node_bin();
    if !node.exists() {
        return Err("Embedded Node.js not set up".to_string());
    }
    let output = Command::new(&node)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to run node: {}", e))?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(NodeInfo {
        path: node.to_string_lossy().to_string(),
        version,
    })
}

#[cfg(unix)]
fn set_executable(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o755);
    std::fs::set_permissions(path, perms)
        .map_err(|e| format!("Failed to set executable: {}", e))
}

#[cfg(not(unix))]
fn set_executable(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create dir {}: {}", dst.display(), e))?;
    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read dir {}: {}", src.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy {}: {}", src_path.display(), e))?;
        }
    }
    Ok(())
}

// ── Node.js resolution (embedded first, system fallback) ───────────

/// Get the best available Node.js path — embedded preferred, system as fallback.
#[tauri::command]
fn get_node_path() -> Result<NodeInfo, String> {
    // 1. Try embedded
    if let Ok(info) = get_embedded_node_info() {
        return Ok(info);
    }
    // 2. Fallback to system Node.js
    detect_system_node().ok_or_else(|| "No Node.js available (embedded not set up, system not found)".to_string())
}

/// Build a rich PATH that includes common Node.js install locations.
/// Fallback for when embedded Node.js is not available.
fn rich_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let home = home.to_string_lossy();
    let current = std::env::var("PATH").unwrap_or_default();
    let extras = [
        format!("{home}/.volta/bin"),
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    let version_dirs = [
        format!("{home}/.nvm/versions/node"),
        format!("{home}/.local/share/fnm/node-versions"),
        format!("{home}/.fnm/node-versions"),
    ];
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
    let fnm_default = format!("{home}/.local/share/fnm/aliases/default/bin");
    if std::path::Path::new(&fnm_default).join("node").exists() {
        versioned_paths.push((999, fnm_default));
    }
    versioned_paths.sort_by(|a, b| b.0.cmp(&a.0));

    let mut parts: Vec<String> = versioned_paths.into_iter().map(|(_, p)| p).collect();
    parts.extend(extras);
    parts.push(current);
    parts.join(":")
}

/// Detect system Node.js ≥v18 (fallback when embedded is unavailable).
fn detect_system_node() -> Option<NodeInfo> {
    let path_env = rich_path();
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
    let major: u32 = version
        .strip_prefix('v')
        .and_then(|v| v.split('.').next())
        .and_then(|m| m.parse().ok())
        .unwrap_or(0);
    if major >= 18 {
        Some(NodeInfo { path: node_path, version })
    } else {
        None
    }
}

// ── Chrome detection ───────────────────────────────────────────────

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

// ── Browser process cleanup ────────────────────────────────────────

/// Kill browser MCP child processes (Chrome instances spawned by chrome-devtools-mcp
/// or Playwright). Called before disconnect to prevent "session locked" errors.
#[tauri::command]
fn kill_browser_mcp_processes() {
    // Kill chrome-devtools-mcp node processes and their Chrome children
    for pattern in &["chrome-devtools-mcp", "playwright-mcp", "@playwright/mcp"] {
        // Find node processes running the MCP server
        if let Ok(output) = Command::new("pgrep").args(["-f", pattern]).output() {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid_str in pids.trim().lines() {
                let pid = pid_str.trim();
                if pid.is_empty() { continue; }
                // Kill descendants first (Chrome processes)
                if let Ok(children) = Command::new("pgrep").args(["-P", pid]).output() {
                    for cpid in String::from_utf8_lossy(&children.stdout).trim().lines() {
                        let cpid = cpid.trim();
                        if !cpid.is_empty() {
                            Command::new("kill").arg(cpid).output().ok();
                        }
                    }
                }
                // Then kill the MCP server process itself
                Command::new("kill").arg(pid).output().ok();
            }
        }
    }
    // Also kill any Chrome launched with our user-data-dir
    let profile = ultrawork_dir().join("chrome-profile");
    if let Ok(output) = Command::new("pgrep").args(["-f", &profile.to_string_lossy()]).output() {
        for pid in String::from_utf8_lossy(&output.stdout).trim().lines() {
            let pid = pid.trim();
            if !pid.is_empty() {
                Command::new("kill").arg(pid).output().ok();
            }
        }
    }
}

// ── Browser mode persistence ───────────────────────────────────────

fn read_browser_mode() -> BrowserMode {
    let path = mode_file();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<BrowserMode>(&s).ok())
        .unwrap_or(BrowserMode::Playwright)
}

#[tauri::command]
fn get_browser_mode() -> String {
    match read_browser_mode() {
        BrowserMode::Playwright => "playwright".to_string(),
        BrowserMode::Devtools => "devtools".to_string(),
    }
}

#[tauri::command]
fn set_browser_mode(mode: String) -> Result<(), String> {
    let m: BrowserMode = serde_json::from_str(&format!("\"{}\"", mode))
        .map_err(|_| format!("Invalid mode: {} (expected 'playwright' or 'devtools')", mode))?;
    let path = mode_file();
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|e| format!("Failed to create dir: {}", e))?;
    let json = serde_json::to_string(&m).unwrap();
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write mode: {}", e))
}

// ── MCP installation ───────────────────────────────────────────────

/// Resolve the npm-cli.js entry point for a given node binary.
/// Handles both embedded layout (sibling ../lib/node_modules/npm/)
/// and system npm (sibling npm script → follow to find cli.js).
fn resolve_npm_cli(node_path: &str) -> Result<PathBuf, String> {
    let node = std::path::Path::new(node_path);
    let node_base = node.parent().and_then(|p| p.parent()); // e.g. ~/.ultrawork/node

    // Try embedded layout: <node_base>/lib/node_modules/npm/bin/npm-cli.js
    if let Some(base) = node_base {
        let cli = base.join("lib/node_modules/npm/bin/npm-cli.js");
        if cli.exists() {
            return Ok(cli);
        }
    }

    // Try system layout: npm binary is sibling of node
    if let Some(bin_dir) = node.parent() {
        // System npm is at <bin_dir>/../lib/node_modules/npm/bin/npm-cli.js
        if let Some(prefix) = bin_dir.parent() {
            let cli = prefix.join("lib/node_modules/npm/bin/npm-cli.js");
            if cli.exists() {
                return Ok(cli);
            }
        }
    }

    Err("Cannot find npm-cli.js".to_string())
}

/// Run npm install in a given MCP subdirectory.
/// Uses `node npm-cli.js install ...` instead of calling npm directly,
/// which avoids broken symlink/relative-path issues.
fn npm_install_in(node_path: &str, sub_dir: &str, package: &str) -> Result<(), String> {
    let dir = mcp_dir().join(sub_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;

    let pkg_json = dir.join("package.json");
    if !pkg_json.exists() {
        std::fs::write(&pkg_json, r#"{"private":true}"#)
            .map_err(|e| format!("Failed to write package.json: {}", e))?;
    }

    let npm_cli = resolve_npm_cli(node_path)?;

    let node = std::path::Path::new(node_path);
    let node_bin_dir = node.parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let current_path = std::env::var("PATH").unwrap_or_default();
    let enriched_path = format!("{}:{}", node_bin_dir, current_path);

    let output = Command::new(node_path)
        .args([npm_cli.to_string_lossy().as_ref(), "install", package])
        .current_dir(&dir)
        .env("PATH", &enriched_path)
        .output()
        .map_err(|e| format!("Failed to run npm: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install failed: {}", stderr));
    }
    Ok(())
}

/// Install Playwright MCP (@playwright/mcp).
#[tauri::command(async)]
fn install_playwright_mcp() -> Result<String, String> {
    let node_info = get_node_path_internal()?;
    npm_install_in(&node_info.path, PLAYWRIGHT_MCP_DIR, "@playwright/mcp@latest")?;

    let entry = mcp_dir().join(PLAYWRIGHT_MCP_DIR).join(PLAYWRIGHT_MCP_ENTRY);
    if !entry.exists() {
        return Err("Installation completed but entry point not found".to_string());
    }
    Ok(entry.to_string_lossy().to_string())
}

/// Install chrome-devtools-mcp.
#[tauri::command(async)]
fn install_devtools_mcp() -> Result<String, String> {
    let node_info = get_node_path_internal()?;
    npm_install_in(&node_info.path, DEVTOOLS_MCP_DIR, "chrome-devtools-mcp@latest")?;

    let entry = mcp_dir().join(DEVTOOLS_MCP_DIR).join(DEVTOOLS_MCP_ENTRY);
    if !entry.exists() {
        return Err("Installation completed but entry point not found".to_string());
    }
    Ok(entry.to_string_lossy().to_string())
}

/// Internal helper — same as get_node_path but returns Result for Rust callers.
fn get_node_path_internal() -> Result<NodeInfo, String> {
    if let Ok(info) = get_embedded_node_info() {
        return Ok(info);
    }
    detect_system_node().ok_or_else(|| "No Node.js available".to_string())
}

// ── Environment detection (single call from frontend) ──────────────

/// Returns full browser environment info in one call.
#[tauri::command]
fn detect_browser_env() -> BrowserEnvInfo {
    let (node_path, node_version, node_embedded) =
        if let Ok(info) = get_embedded_node_info() {
            (info.path, info.version, true)
        } else if let Some(info) = detect_system_node() {
            (info.path, info.version, false)
        } else {
            (String::new(), String::new(), false)
        };

    let chrome_path = detect_chrome();
    let playwright_installed = mcp_dir()
        .join(PLAYWRIGHT_MCP_DIR)
        .join(PLAYWRIGHT_MCP_ENTRY)
        .exists();
    let devtools_installed = mcp_dir()
        .join(DEVTOOLS_MCP_DIR)
        .join(DEVTOOLS_MCP_ENTRY)
        .exists();
    let mode = read_browser_mode();

    BrowserEnvInfo {
        node_path,
        node_version,
        node_embedded,
        chrome_path,
        playwright_installed,
        devtools_installed,
        mode,
        mcp_dir: mcp_dir().to_string_lossy().to_string(),
    }
}

// ---------------------------------------------------------------------------
// MCP config persistence — read/write opencode.json `mcp` field directly
// (avoids PATCH /config which triggers Instance.dispose and kills all MCPs)
// ---------------------------------------------------------------------------

fn opencode_json_path(workspace: &str) -> PathBuf {
    PathBuf::from(workspace).join("opencode.json")
}

fn read_opencode_json(workspace: &str) -> Result<serde_json::Value, String> {
    let path = opencode_json_path(workspace);
    let content = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON in {}: {}", path.display(), e))
}

fn write_opencode_json(workspace: &str, root: &serde_json::Value) -> Result<(), String> {
    let path = opencode_json_path(workspace);
    let mut json = serde_json::to_string_pretty(root)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))?;
    json.push('\n');
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

#[tauri::command]
fn read_mcp_config(workspace: String) -> Result<serde_json::Value, String> {
    let root = read_opencode_json(&workspace)?;
    Ok(root.get("mcp").cloned().unwrap_or(serde_json::json!({})))
}

#[tauri::command]
fn write_mcp_config(workspace: String, name: String, config: serde_json::Value) -> Result<(), String> {
    let mut root = read_opencode_json(&workspace)?;
    let obj = root.as_object_mut()
        .ok_or("opencode.json root is not an object")?;
    let mcp = obj.entry("mcp")
        .or_insert_with(|| serde_json::json!({}));
    let mcp_obj = mcp.as_object_mut()
        .ok_or("opencode.json mcp field is not an object")?;
    mcp_obj.insert(name, config);
    write_opencode_json(&workspace, &root)
}

#[tauri::command]
fn remove_mcp_config(workspace: String, name: String) -> Result<(), String> {
    let mut root = read_opencode_json(&workspace)?;
    let obj = root.as_object_mut()
        .ok_or("opencode.json root is not an object")?;
    if let Some(mcp) = obj.get_mut("mcp") {
        if let Some(mcp_obj) = mcp.as_object_mut() {
            mcp_obj.remove(&name);
            // Remove empty mcp field
            if mcp_obj.is_empty() {
                obj.remove("mcp");
            }
        }
    }
    write_opencode_json(&workspace, &root)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            download_node,
            get_node_path,
            detect_chrome,
            kill_browser_mcp_processes,
            detect_browser_env,
            get_browser_mode,
            set_browser_mode,
            install_playwright_mcp,
            install_devtools_mcp,
            read_mcp_config,
            write_mcp_config,
            remove_mcp_config,
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
