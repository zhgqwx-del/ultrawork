use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const OPENCODE_PORT: u16 = 4096;
const GATEWAY_PORT: u16 = 4097;
const KNOWLEDGE_PORT: u16 = 4098;
const ACP_PORT: u16 = 4099;
const OPENCODE_APP_NAME: &str = "ultrawork";

// ── Sidecar process registry ─────────────────────────────────────────

struct SidecarEntry {
    port: u16,
    pid: Option<u32>, // None when reusing an existing process (no spawn)
}

static SIDECAR_REGISTRY: Mutex<Vec<SidecarEntry>> = Mutex::new(Vec::new());

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

/// Kill all registered sidecar processes on app exit.
/// Two-phase: (1) SIGTERM by PID, (2) port-based fallback for survivors.
fn shutdown_sidecars() {
    println!("[shutdown] Cleaning up sidecar processes...");

    let entries = match SIDECAR_REGISTRY.lock() {
        Ok(mut reg) => std::mem::take(&mut *reg),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    };

    // Phase 1: kill by PID
    for entry in &entries {
        if let Some(pid) = entry.pid {
            println!("[shutdown] Killing sidecar pid {} (port {})", pid, entry.port);
            Command::new("kill").arg(pid.to_string()).output().ok();
        }
    }

    // Grace period for processes to terminate
    std::thread::sleep(Duration::from_millis(200));

    // Phase 2: port-based fallback for survivors
    for entry in &entries {
        if is_port_in_use(entry.port) {
            println!(
                "[shutdown] Port {} still in use, force-killing by port",
                entry.port
            );
            kill_port_process(entry.port);
        }
    }

    // Also clean up browser MCP processes (Chrome/Playwright)
    kill_browser_mcp_processes();

    println!("[shutdown] Sidecar cleanup complete.");
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
/// Returns the PID of the spawned process.
fn spawn_sidecar<T: tauri_plugin_shell::ShellExt<tauri::Wry>>(
    shell_host: &T,
    name: &str,
    args: &[&str],
    env_vars: &[(&str, &str)],
) -> Result<u32, String> {
    let sidecar = shell_host
        .shell()
        .sidecar(name)
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?;

    let mut cmd = sidecar.args(args);
    for (key, value) in env_vars {
        cmd = cmd.env(key, value);
    }

    let (_rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", name, e))?;
    let pid = child.pid();
    // Dropping CommandChild does not kill the OS process — it continues running.
    Ok(pid)
}

/// Generic sidecar launcher with port probe, stale cleanup, and health reuse.
/// Registers the sidecar in the global registry for shutdown cleanup.
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
        if let Ok(mut reg) = SIDECAR_REGISTRY.lock() {
            reg.push(SidecarEntry { port, pid: None });
        }
        return Ok(());
    }

    let pid = spawn_sidecar(shell_host, name, args, env_vars)?;
    if let Ok(mut reg) = SIDECAR_REGISTRY.lock() {
        reg.push(SidecarEntry { port, pid: Some(pid) });
    }

    // Wait for sidecar to become healthy before returning
    let max_wait = Duration::from_secs(15);
    let poll_interval = Duration::from_millis(200);
    let start = std::time::Instant::now();
    loop {
        if check_health(port, health_path, health_auth) {
            println!("{} ready on port {} (pid {})", name, port, pid);
            return Ok(());
        }
        if start.elapsed() > max_wait {
            // Kill the unhealthy child and drop it from the registry — otherwise it
            // would leak as a zombie sidecar until app shutdown.
            Command::new("kill").arg(pid.to_string()).output().ok();
            if let Ok(mut reg) = SIDECAR_REGISTRY.lock() {
                reg.retain(|e| e.pid != Some(pid));
            }
            return Err(format!(
                "{} spawned (pid {}) on port {} but did not pass health check at {} within {}s",
                name, pid, port, health_path, max_wait.as_secs()
            ));
        }
        std::thread::sleep(poll_interval);
    }
}

// ── Default workspace ──────────────────────────────────────────────

/// Ensure the default workspace directory exists (~/.ultrawork/workspace/).
/// Returns the absolute path. Idempotent — safe to call every startup.
#[tauri::command]
fn ensure_default_workspace() -> Result<String, String> {
    let dir = ultrawork_dir().join("workspace");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create default workspace: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Open a file with the system default application (e.g. browser for .html, Keynote for .pptx).
/// Uses macOS `open` command.
#[tauri::command]
fn open_file_with_system(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    let output = Command::new("open")
        .arg(&path)
        .output()
        .map_err(|e| format!("Failed to open {}: {}", path, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("open failed: {}", stderr));
    }
    Ok(())
}

/// Read a file's raw bytes for in-app preview (e.g. pdf.js). Returns the bytes
/// as an IPC binary response (efficient, no base64). Uses std::fs so it can read
/// any workspace path the user opens — no plugin scope to configure, which is the
/// whole reason for preferring this over tauri-plugin-fs for arbitrary roots.
// async so Tauri runs it off the main/UI thread — a multi-MB PDF read must not
// block the webview while `std::fs::read` slurps the whole file.
#[tauri::command]
async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err(format!("File not found: {}", path));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Reveal a file in Finder (macOS). Uses `open -R` which highlights the file in its folder.
#[tauri::command]
fn reveal_file_in_finder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    let output = Command::new("open")
        .args(["-R", &path])
        .output()
        .map_err(|e| format!("Failed to reveal {}: {}", path, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("open -R failed: {}", stderr));
    }
    Ok(())
}

/// Check whether a directory exists on disk.
#[tauri::command]
fn check_directory_exists(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
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

// ── Workspace artifact scanning (mtime-based) ──────────────────────
// Surfaces files actually produced during a session — including bash/script
// side-effects the tool-call transcript never names — by walking the session
// directory for entries modified at/after a baseline timestamp. Pairs with the
// desktop artifacts panel's tool-call detection (filesystem truth, not intent).

/// Directory names skipped wholesale during artifact scanning (dotdirs are
/// already excluded by the leading-dot check, listed here only when relevant).
const SCAN_IGNORE_DIRS: &[&str] = &[
    "node_modules",
    "__pycache__",
    "venv",
    "env",
    "dist",
    "build",
    "target",
];

/// File extensions skipped (compiler/runtime scratch, never deliverables).
const SCAN_IGNORE_EXTS: &[&str] = &["pyc", "pyo", "class", "o", "lock"];

const SCAN_MAX_DEPTH: usize = 8;
/// How many matches we keep/return (newest-first).
const SCAN_MAX_FILES: usize = 500;
/// Memory safety cap on matches collected during the walk, before sorting. Set
/// well above SCAN_MAX_FILES so we still pick the newest 500 globally rather
/// than stopping the walk at an arbitrary 500 (which could drop the real,
/// most-recent deliverable). Only a pathological tree (>5000 changed files
/// since the baseline) hits it.
const SCAN_WALK_MAX: usize = 5000;
/// Hard cap on directory entries examined, so a huge workspace (where few files
/// match the baseline, forcing a full traversal) can't make the walk run
/// unbounded. Each entry costs a `metadata()` stat; this bounds worst-case time.
const SCAN_MAX_ENTRIES: usize = 50_000;

/// Walk `root` collecting (absolute path, mtime_ms) for files modified at/after
/// `since_ms`. Skips dotfiles/dotdirs, ignore dirs, ignore exts, symlinks.
/// Bounded by depth, match count, and total entries examined so a huge tree can
/// never hang the caller. Returns the newest SCAN_MAX_FILES, newest first.
fn collect_changed_files(root: &std::path::Path, since_ms: u64) -> Vec<(String, u64)> {
    let mut out: Vec<(String, u64)> = Vec::new();
    let mut visited: usize = 0;
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= SCAN_WALK_MAX || visited >= SCAN_MAX_ENTRIES {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited >= SCAN_MAX_ENTRIES {
                break;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Hidden entries (dotfiles/dotdirs) are noise for artifacts.
            if name.starts_with('.') {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            let path = entry.path();
            if file_type.is_dir() {
                if SCAN_IGNORE_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                if depth + 1 <= SCAN_MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            // Skip symlinks and non-regular files.
            if !file_type.is_file() {
                continue;
            }
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if SCAN_IGNORE_EXTS.contains(&ext.to_lowercase().as_str()) {
                    continue;
                }
            }
            let mtime_ms = match entry.metadata().ok().and_then(|m| m.modified().ok()) {
                Some(t) => t
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                None => continue,
            };
            if mtime_ms >= since_ms {
                out.push((path.to_string_lossy().to_string(), mtime_ms));
                if out.len() >= SCAN_WALK_MAX {
                    break;
                }
            }
        }
    }
    // Newest first, then keep only the newest SCAN_MAX_FILES.
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out.truncate(SCAN_MAX_FILES);
    out
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScannedFile {
    path: String,
    mtime_ms: u64,
}

/// Scan a session workspace for files created/modified at/after `since_ms`
/// (epoch millis). Returns absolute paths + mtime, newest first. Lets the
/// artifacts panel catch outputs produced by bash/script side-effects, not just
/// by write/edit tool calls. The caller filters by per-turn time windows so that
/// sessions sharing a workspace don't show each other's files (mtime alone can't
/// attribute a file to a session). An unset/invalid dir yields an empty list
/// (not an error) so the panel degrades gracefully.
/// async so Tauri runs the (potentially large) filesystem walk off the main/UI
/// thread.
#[tauri::command]
async fn scan_workspace_changes(dir: String, since_ms: u64) -> Result<Vec<ScannedFile>, String> {
    let root = std::path::Path::new(&dir);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    Ok(collect_changed_files(root, since_ms)
        .into_iter()
        .map(|(path, mtime_ms)| ScannedFile { path, mtime_ms })
        .collect())
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

/// Extract the PATH captured between our sentinel markers in shell output.
/// The login shell may print rc-file banners/echoes; the sentinel isolates
/// the real `$PATH` from that noise. Returns None if markers are absent.
fn extract_sentinel(out: &str) -> Option<String> {
    let start = out.find("___UWPATH[")? + "___UWPATH[".len();
    let rest = &out[start..];
    let end = rest.find("]UWPATH___")?;
    let inner = rest[..end].trim();
    if inner.is_empty() { None } else { Some(inner.to_string()) }
}

/// Merge two PATH strings (`:`-separated), preserving order and de-duplicating.
/// Entries from `primary` win placement (login shell PATH first), then any new
/// entries from `secondary`. Empty segments are skipped.
fn merge_paths(primary: &str, secondary: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut parts: Vec<&str> = Vec::new();
    for seg in primary.split(':').chain(secondary.split(':')) {
        if seg.is_empty() {
            continue;
        }
        if seen.insert(seg) {
            parts.push(seg);
        }
    }
    parts.join(":")
}

/// Capture the full PATH from the user's real login shell.
///
/// GUI-launched (Finder/launchd) apps inherit a minimal PATH that does not
/// source shell rc files, so tools installed in custom bundle dirs
/// (`~/.hermes-bundle/wrapper`, `~/.qoder/bin`, …) are invisible. We run the
/// login+interactive shell, which sources `.zprofile`/`.zshrc` (where users
/// export PATH), and read its `$PATH` back. Wrapped in a sentinel to survive
/// rc-file noise; hard 5s timeout so a hanging/interactive rc can never block
/// startup (on failure `rich_path` falls back to `rich_path_base`, never worse).
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    if std::env::var("ULTRAWORK_SKIP_LOGIN_SHELL_PATH").is_ok() {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // -l: login (source .zprofile), -i: interactive (source .zshrc), -c: run.
    let mut child = Command::new(&shell)
        .args(["-lic", "printf '___UWPATH[%s]UWPATH___' \"$PATH\""])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let out = rx.recv_timeout(Duration::from_secs(5)).ok();
    // Best-effort: don't let a slow/hung shell linger.
    let _ = child.kill();
    let _ = child.wait();
    extract_sentinel(&out?)
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<String> {
    None
}

/// Build a rich PATH for spawning sidecars / external agents.
///
/// GUI-launched apps get a minimal PATH (see [`login_shell_path`]). We prefer
/// the user's real login-shell PATH (covers arbitrary custom install dirs),
/// then merge in hard-coded Node.js locations as a fallback for environments
/// where the login shell is unavailable or doesn't export those. Memoized —
/// the login shell is invoked at most once per process.
fn rich_path() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(compute_rich_path).clone()
}

/// Hard-coded portion of [`rich_path`]: common Node.js install locations plus
/// the inherited PATH. Used directly when the login shell is unavailable.
fn rich_path_base() -> String {
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

fn compute_rich_path() -> String {
    let base = rich_path_base();
    match login_shell_path() {
        Some(login) => merge_paths(&login, &base),
        None => base,
    }
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
// MCP config persistence — read/write global opencode.json `mcp` field
// All MCP configs are stored in ~/.config/ultrawork/opencode.json (global only).
// No workspace-level opencode.json is used for MCP configuration.
// ---------------------------------------------------------------------------

fn global_config_dir() -> PathBuf {
    // Must match OpenCode's xdg-basedir: XDG_CONFIG_HOME or ~/.config (NOT ~/Library/Application Support on macOS)
    // Uses OPENCODE_APP_NAME to isolate Ultrawork config from OpenCode CLI
    match std::env::var("XDG_CONFIG_HOME") {
        Ok(val) if !val.is_empty() => PathBuf::from(val).join(OPENCODE_APP_NAME),
        _ => dirs::home_dir().unwrap().join(".config").join(OPENCODE_APP_NAME),
    }
}

fn global_opencode_json_path() -> PathBuf {
    global_config_dir().join("opencode.json")
}

#[tauri::command]
fn get_global_config_dir() -> String {
    global_config_dir().to_string_lossy().to_string()
}

// ---------------------------------------------------------------------------
// Sidecar credentials — random per-install password persisted to
// ~/.config/ultrawork/sidecar-auth.json with 0600 perms.
//
// Env var override: ULTRAWORK_SIDECAR_PASSWORD (used for CI/scripted tests;
// not persisted).
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct SidecarCredentials {
    username: String,
    password: String,
}

fn sidecar_credentials_path() -> PathBuf {
    global_config_dir().join("sidecar-auth.json")
}

fn load_or_create_sidecar_credentials() -> Result<SidecarCredentials, String> {
    // Env var escape hatch for tests / scripted access
    if let Ok(pass) = std::env::var("ULTRAWORK_SIDECAR_PASSWORD") {
        if !pass.is_empty() {
            return Ok(SidecarCredentials {
                username: std::env::var("ULTRAWORK_SIDECAR_USERNAME")
                    .unwrap_or_else(|_| "opencode".to_string()),
                password: pass,
            });
        }
    }

    let path = sidecar_credentials_path();
    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        let creds: SidecarCredentials = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid sidecar credentials in {}: {}", path.display(), e))?;
        return Ok(creds);
    }

    // First run: generate random password
    let dir = global_config_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    }
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("getrandom failed: {}", e))?;
    let password = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    let creds = SidecarCredentials {
        username: "opencode".to_string(),
        password,
    };
    let json = serde_json::to_string_pretty(&creds)
        .map_err(|e| format!("Failed to serialize credentials: {}", e))?;

    // Restrict to owner-read/write on Unix from the moment the file is created,
    // not after the fact — std::fs::write would create with the umask (often 0644)
    // and leave a microsecond window where another process can read the credential.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("Failed to create {}: {}", path.display(), e))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    }
    #[cfg(not(unix))]
    {
        // Windows: rely on default ACL (user-only) inherited from %APPDATA% parent.
        std::fs::write(&path, json)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    }

    Ok(creds)
}

#[tauri::command]
fn get_sidecar_credentials() -> Result<SidecarCredentials, String> {
    load_or_create_sidecar_credentials()
}

// Tauri target triple for the currently-running build. Used to construct sidecar
// binary names of the form `<base>-<target>` (no .exe suffix on non-windows).
const fn current_target_triple() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "aarch64-apple-darwin" } else { "x86_64-apple-darwin" }
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

fn sidecar_binary_name(name: &str) -> String {
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    format!("{}-{}{}", name, current_target_triple(), suffix)
}

// Sidecars that Ultrawork copies into ~/.ultrawork/sidecars/ at startup and
// registers as MCPs in opencode.json. Anchoring the MCP command path in the
// user data dir (instead of the .app or dev tree) keeps it stable across .app
// moves, dev→DMG migration, and cross-machine config copies.
const KNOWN_SIDECAR_NAMES: &[&str] = &["knowledge-sidecar", "acp-client"];

fn user_sidecars_dir() -> PathBuf {
    ultrawork_dir().join("sidecars")
}

fn user_sidecar_path(name: &str) -> PathBuf {
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    user_sidecars_dir().join(format!("{}{}", name, suffix))
}

/// Locate the bundled source binary for a sidecar. Production sources live at
/// <App>/Contents/MacOS/<name> (Tauri strips the arch suffix when bundling);
/// development sources live at src-tauri/binaries/<name>-<target>.
fn source_sidecar_path(name: &str) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
            let prod = dir.join(format!("{}{}", name, suffix));
            if prod.exists() {
                return Some(prod);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(sidecar_binary_name(name));
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// Copy each known sidecar from its bundled source into ~/.ultrawork/sidecars/.
/// Idempotent — skips when the target exists and matches the source by size +
/// mtime. Runs at app startup before any MCP command path is resolved.
fn ensure_sidecar_copies() {
    let dir = user_sidecars_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[sidecar-copy] failed to create {}: {}", dir.display(), e);
        return;
    }

    for &name in KNOWN_SIDECAR_NAMES {
        let Some(source) = source_sidecar_path(name) else {
            eprintln!("[sidecar-copy] no source found for {}; skipping", name);
            continue;
        };
        let target = user_sidecar_path(name);
        let marker = dir.join(format!(".{}.source", name));

        // Idempotence: store "<size>:<mtime-nanos>" of the source on each copy
        // and skip when the source still matches.
        let source_token: Option<String> = std::fs::metadata(&source).ok().and_then(|m| {
            let mtime = m.modified().ok()?
                .duration_since(std::time::UNIX_EPOCH).ok()?
                .as_nanos();
            Some(format!("{}:{}", m.len(), mtime))
        });
        let stored = std::fs::read_to_string(&marker).ok();
        if target.exists() && source_token.is_some() && stored.as_deref() == source_token.as_deref() {
            continue;
        }

        match std::fs::copy(&source, &target) {
            Ok(bytes) => {
                println!(
                    "[sidecar-copy] {} -> {} ({:.1} MB)",
                    source.display(),
                    target.display(),
                    bytes as f64 / 1_048_576.0,
                );
                if let Some(token) = source_token {
                    let _ = std::fs::write(&marker, token);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(meta) = std::fs::metadata(&target) {
                        let mut perms = meta.permissions();
                        perms.set_mode(0o755);
                        let _ = std::fs::set_permissions(&target, perms);
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "[sidecar-copy] failed to copy {} -> {}: {}",
                    source.display(),
                    target.display(),
                    e,
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Built-in skills — bundled under <resource_dir>/skills/builtin (Tauri
// bundle.resources) and copied at startup into
// ~/.config/ultrawork/skills/builtin so the OpenCode sidecar auto-discovers
// them ({skill,skills}/**/SKILL.md over the config dir). vendor untouched, no
// opencode.json mutation. See skills/builtin/README.md + ADR.
// ---------------------------------------------------------------------------

/// Target dir for built-in skills. Sits *inside* the config skills dir so it is
/// scanned, but namespaced under `builtin/` so the sentinel refresh only ever
/// wipes built-ins — never user-installed skills (which live at the skills root).
fn builtin_skills_target() -> PathBuf {
    global_config_dir().join("skills").join("builtin")
}

/// Bounded DFS for the bundled built-in skills dir, identified by its
/// `.builtin-version` sentinel. Robust to Tauri's resource layout (map dest vs
/// `_up_`-mangled `..` segments). Prefers a `skills/builtin` match when several
/// exist. Returns the directory containing `.builtin-version`.
fn find_builtin_source(root: &std::path::Path, max_depth: usize) -> Option<PathBuf> {
    let mut best: Option<PathBuf> = None;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if dir.join(".builtin-version").is_file() {
            let prefers = dir.ends_with("skills/builtin") || dir.ends_with("builtin");
            if prefers {
                return Some(dir);
            }
            best.get_or_insert(dir);
            continue;
        }
        if depth >= max_depth {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    stack.push((entry.path(), depth + 1));
                }
            }
        }
    }
    best
}

/// Idempotently copy bundled built-in skills into the config skills dir,
/// gated by a content-hash sentinel (`.builtin-version`). On an app upgrade the
/// version changes and we wipe-and-recopy `builtin/` only. Non-fatal: any error
/// is logged and startup proceeds (skills simply won't appear).
fn ensure_builtin_skills(app: &tauri::App) {
    use tauri::Manager;
    let Ok(resource_dir) = app.path().resource_dir() else {
        eprintln!("[builtin-skills] no resource dir; skipping");
        return;
    };
    // Tauri can place a `..`-sourced resource at different depths (map form puts
    // it at the mapped destination; glob/array form mangles `..` into `_up_`
    // segments). Rather than guess, search the resource dir for the directory
    // holding our `.builtin-version` sentinel (bounded depth, cheap).
    let Some(src) = find_builtin_source(&resource_dir, 8) else {
        eprintln!(
            "[builtin-skills] bundled source (.builtin-version) not found under {}",
            resource_dir.display()
        );
        return;
    };
    let version = std::fs::read_to_string(src.join(".builtin-version"))
        .unwrap_or_default()
        .trim()
        .to_string();
    let target = builtin_skills_target();
    let sentinel = target.join(".builtin-version");
    let stored = std::fs::read_to_string(&sentinel).ok().map(|s| s.trim().to_string());
    if !builtin_needs_refresh(&version, stored.as_deref(), target.exists()) {
        return; // up to date
    }
    // Refresh: remove ONLY builtin/ — siblings under skills/ are user-installed.
    let _ = std::fs::remove_dir_all(&target);
    if let Err(e) = copy_dir_recursive(&src, &target) {
        eprintln!("[builtin-skills] copy failed ({} -> {}): {}", src.display(), target.display(), e);
        return;
    }
    println!("[builtin-skills] installed -> {} (version {})", target.display(), version);
}

/// Pure refresh decision: copy is needed unless the target exists AND the source
/// version is non-empty AND the stored sentinel already matches it.
fn builtin_needs_refresh(src_version: &str, stored: Option<&str>, target_exists: bool) -> bool {
    !(target_exists && !src_version.is_empty() && stored == Some(src_version))
}

/// One probed external tool required by a built-in skill.
#[derive(Debug, Serialize)]
struct DepStatus {
    name: String,
    available: bool,
    path: Option<String>,
}

const SKILL_DEP_BINS: &[&str] = &[
    "python3", "node", "pandoc", "soffice", "pdftoppm", "git", "markdown-exporter",
];

/// Probe a `:`-separated PATH for each bin (pure; testable).
fn probe_bins(path: &str, bins: &[&str]) -> Vec<DepStatus> {
    let dirs: Vec<&str> = path.split(':').filter(|s| !s.is_empty()).collect();
    bins
        .iter()
        .map(|bin| {
            let found = dirs.iter().map(|d| std::path::Path::new(d).join(bin)).find(|p| p.is_file());
            DepStatus {
                name: bin.to_string(),
                available: found.is_some(),
                path: found.map(|p| p.to_string_lossy().to_string()),
            }
        })
        .collect()
}

/// PATH used to probe skill dependencies. rich_path() is node-centric (volta/nvm/
/// brew) — extend it with the standard system bin dirs so plain system tools like
/// python3/git (in /usr/bin) are found regardless of how the app was launched
/// (Finder vs terminal give different inherited PATHs).
fn skill_dep_path() -> String {
    format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", rich_path())
}

/// Probe the PATH for the external tools built-in skills shell out to. The
/// frontend maps each skill to its required tools (BUILTIN_DEP_MAP) and renders
/// readiness badges.
#[tauri::command]
fn check_skill_dependencies() -> Vec<DepStatus> {
    probe_bins(&skill_dep_path(), SKILL_DEP_BINS)
}

/// Resolve the canonical (user-local) path of a sidecar. After
/// ensure_sidecar_copies has run, every known sidecar lives at
/// ~/.ultrawork/sidecars/<name>. The bundled source is a fallback for the
/// edge case where the copy hasn't happened yet (e.g. install-time race).
fn resolve_sidecar_path(name: &str) -> Result<String, String> {
    let canonical = user_sidecar_path(name);
    if canonical.exists() {
        return Ok(canonical.to_string_lossy().to_string());
    }
    if let Some(source) = source_sidecar_path(name) {
        return Ok(source.to_string_lossy().to_string());
    }
    Err(format!("Sidecar binary not found for: {}", name))
}

#[tauri::command]
fn get_sidecar_path(name: String) -> Result<String, String> {
    resolve_sidecar_path(&name)
}

/// Migrate any pre-existing MCP entries to the canonical ~/.ultrawork/sidecars/<name>
/// path. Recognises both the dev-tree basename (`<name>-<target>`) and the
/// production basename Tauri uses (`<name>`). Anything not recognisable as a
/// managed sidecar is left alone.
fn canonicalize_sidecar_mcp_paths() {
    let mut canonical: std::collections::HashMap<&str, String> = Default::default();
    for &sidecar in KNOWN_SIDECAR_NAMES {
        canonical.insert(sidecar, user_sidecar_path(sidecar).to_string_lossy().to_string());
    }

    let result = modify_global_opencode_json(|root| {
        let Some(mcp) = root.get_mut("mcp").and_then(|m| m.as_object_mut()) else {
            return Ok(());
        };
        for (_name, cfg) in mcp.iter_mut() {
            let Some(cmd) = cfg.get_mut("command").and_then(|c| c.as_array_mut()) else { continue };
            let Some(first) = cmd.first_mut() else { continue };
            let Some(current) = first.as_str() else { continue };

            let basename = std::path::Path::new(current)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let matched: Option<&str> = KNOWN_SIDECAR_NAMES.iter()
                .find(|&&s| basename == s || basename.starts_with(&format!("{}-", s)))
                .copied();
            let Some(name) = matched else { continue };
            let Some(want) = canonical.get(name) else { continue };
            if want == current { continue }

            println!("[sidecar-mcp] migrate path: {} -> {}", current, want);
            *first = serde_json::Value::String(want.clone());
        }
        Ok(())
    });
    if let Err(e) = result {
        eprintln!("[sidecar-mcp] failed to update MCP paths: {}", e);
    }
}

fn read_global_opencode_json() -> Result<serde_json::Value, String> {
    let path = global_opencode_json_path();
    let content = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON in {}: {}", path.display(), e))
}

// Atomic write: serialize to a per-writer .tmp file, then rename over the target.
// rename(2) is atomic on the same filesystem, so readers never see a partial file.
// Including pid + nanos in the tmp filename means two writers (e.g. Ultrawork and
// the OpenCode sidecar updating the same file) never clobber each other's tmp.
fn write_global_opencode_json(root: &serde_json::Value) -> Result<(), String> {
    let dir = global_config_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create config dir {}: {}", dir.display(), e))?;
    }
    let path = global_opencode_json_path();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = path.with_extension(format!("json.{}.{}.tmp", std::process::id(), nanos));

    let mut json = serde_json::to_string_pretty(root)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))?;
    json.push('\n');

    std::fs::write(&tmp_path, json)
        .map_err(|e| format!("Failed to write {}: {}", tmp_path.display(), e))?;
    if let Err(e) = std::fs::rename(&tmp_path, &path) {
        // Best-effort cleanup of the orphan tmp file
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to rename {} -> {}: {}", tmp_path.display(), path.display(), e));
    }
    Ok(())
}

// Serialize all read-modify-write cycles against opencode.json so two Tauri
// commands cannot interleave (e.g. add-MCP racing with remove-MCP). Cross-process
// races (Ultrawork ↔ OpenCode sidecar both writing) still rely on the atomic
// rename above: last writer wins, but the file is never corrupt.
static OPENCODE_JSON_LOCK: Mutex<()> = Mutex::new(());

fn modify_global_opencode_json<F>(modifier: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_json::Value) -> Result<(), String>,
{
    let _guard = OPENCODE_JSON_LOCK.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    let mut root = read_global_opencode_json()?;
    modifier(&mut root)?;
    write_global_opencode_json(&root)
}

#[tauri::command]
fn read_mcp_config() -> Result<serde_json::Value, String> {
    let _guard = OPENCODE_JSON_LOCK.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    let root = read_global_opencode_json()?;
    Ok(root.get("mcp").cloned().unwrap_or(serde_json::json!({})))
}

#[tauri::command]
fn write_mcp_config(name: String, config: serde_json::Value) -> Result<(), String> {
    modify_global_opencode_json(|root| {
        let obj = root.as_object_mut()
            .ok_or("opencode.json root is not an object")?;
        let mcp = obj.entry("mcp")
            .or_insert_with(|| serde_json::json!({}));
        let mcp_obj = mcp.as_object_mut()
            .ok_or("opencode.json mcp field is not an object")?;
        mcp_obj.insert(name, config);
        Ok(())
    })
}

#[tauri::command]
fn remove_mcp_config(name: String) -> Result<(), String> {
    modify_global_opencode_json(|root| {
        let obj = root.as_object_mut()
            .ok_or("opencode.json root is not an object")?;
        if let Some(mcp) = obj.get_mut("mcp") {
            if let Some(mcp_obj) = mcp.as_object_mut() {
                mcp_obj.remove(&name);
                if mcp_obj.is_empty() {
                    obj.remove("mcp");
                }
            }
        }
        Ok(())
    })
}

/// Percent-encode a string for use in HTTP headers (matches the encoding
/// the frontend's api-client uses for x-opencode-directory).
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Trigger OpenCode's lazy MCP InstanceState init so the first user prompt
/// doesn't pay the per-MCP spawn/connect cost. OpenCode constructs its MCP
/// state on first access (via GET /mcp or POST /session/{id}/prompt_async),
/// and that build awaits every MCP server's handshake (now capped to 5s by
/// the vendor patch). Firing this in the background once OpenCode is healthy
/// means by the time the React UI is up and the user hits send, the init has
/// already completed (or is close to done).
///
/// Fire-and-forget. Failures are non-fatal.
fn warm_opencode_mcp(port: u16, auth_header: String) {
    std::thread::spawn(move || {
        // Small delay to let OpenCode finish any post-health bookkeeping
        // before we ask it to do heavy work.
        std::thread::sleep(Duration::from_millis(500));

        // OpenCode caches MCP state per-workspace (keyed by directory in
        // InstanceState), so we have to warm the directory the user is
        // actually about to open. Use ~/.ultrawork/workspace/ — that's the
        // default workspace for fresh installs and a stable fallback for
        // existing users when no last-used workspace is known. Returning
        // users on a custom workspace get a separate init when their
        // frontend's getMCP fires, but our patch B caps that at ~5s.
        let dir = ultrawork_dir().join("workspace");
        // Ensure the directory exists (frontend's ensure_default_workspace
        // runs later on React mount; we'd race with that on first launch).
        let _ = std::fs::create_dir_all(&dir);
        let encoded_dir = url_encode(&dir.to_string_lossy());

        let addr: SocketAddr = ([127, 0, 0, 1], port).into();
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
            eprintln!("[mcp-warm] failed to connect to OpenCode :{}", port);
            return;
        };
        let request = format!(
            "GET /mcp HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nAuthorization: {}\r\nx-opencode-directory: {}\r\nConnection: close\r\n\r\n",
            port, auth_header, encoded_dir,
        );
        if stream.write_all(request.as_bytes()).is_err() {
            return;
        }
        // Read the first byte of the response to confirm the request reached
        // the handler — that's enough to guarantee MCP.status() ran server-side
        // and the lazy InstanceState init kicked off. After that we drop.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
        let mut first = [0u8; 1];
        let _ = stream.read(&mut first);
        let _ = stream.shutdown(std::net::Shutdown::Both);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ensure_default_workspace,
            open_file_with_system,
            reveal_file_in_finder,
            check_directory_exists,
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
            get_global_config_dir,
            get_sidecar_path,
            get_sidecar_credentials,
            check_skill_dependencies,
            scan_workspace_changes,
            read_file_bytes,
        ])
        .setup(|app| {
            // Stage 1: copy bundled sidecars into ~/.ultrawork/sidecars/ so MCPs
            // and any external tooling can use a stable user-local path.
            ensure_sidecar_copies();

            // Stage 1b: copy bundled built-in skills into the config skills dir
            // (before OpenCode starts, so the first /skill scan sees them).
            ensure_builtin_skills(app);

            // Stage 2: migrate any pre-existing MCP entries in opencode.json to
            // point at the canonical user-local path (handles dev → DMG and old
            // app-bundle paths in pre-existing configs).
            canonicalize_sidecar_mcp_paths();

            // Load (or first-time generate) the per-install sidecar credentials before
            // spawning any sidecar — Channel Gateway needs OPENCODE_SERVER_PASSWORD to
            // call the OpenCode HTTP API, and OpenCode itself reads it from env.
            let creds = match load_or_create_sidecar_credentials() {
                Ok(c) => c,
                Err(e) => {
                    app.dialog()
                        .message(format!(
                            "Failed to initialize sidecar credentials:\n\n{}\n\nCheck permissions on ~/.config/ultrawork/",
                            e
                        ))
                        .kind(MessageDialogKind::Error)
                        .title("Startup Error")
                        .blocking_show();
                    return Ok(());
                }
            };
            let auth_header = {
                use base64::Engine;
                let token = base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{}", creds.username, creds.password));
                format!("Basic {}", token)
            };

            // Start Channel Gateway sidecar in background (non-critical, don't block UI)
            let gw_handle = app.handle().clone();
            let gw_password = creds.password.clone();
            std::thread::spawn(move || {
                if let Err(e) = start_sidecar(
                    &gw_handle,
                    "channel-gateway",
                    GATEWAY_PORT,
                    "/channel/health",
                    None,
                    &[],
                    &[("OPENCODE_SERVER_PASSWORD", gw_password.as_str())],
                ) {
                    eprintln!("Channel Gateway startup failed: {}", e);
                    use tauri::Emitter;
                    let _ = gw_handle.emit(
                        "sidecar-startup-failed",
                        serde_json::json!({ "name": "channel-gateway", "error": e }),
                    );
                }
            });

            // Start Knowledge Sidecar in background (non-critical, don't block UI)
            let kb_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = start_sidecar(
                    &kb_handle,
                    "knowledge-sidecar",
                    KNOWLEDGE_PORT,
                    "/kb/health",
                    None,
                    &[],
                    &[],
                ) {
                    eprintln!("Knowledge Sidecar startup failed: {}", e);
                    use tauri::Emitter;
                    let _ = kb_handle.emit(
                        "sidecar-startup-failed",
                        serde_json::json!({ "name": "knowledge-sidecar", "error": e }),
                    );
                }
            });

            // Start ACP Client sidecar in background (non-critical, don't block
            // UI). It spawns external agent commands (bunx / claude), which are
            // not on the minimal Finder-launch PATH — pass the enriched one.
            let acp_handle = app.handle().clone();
            let acp_password = creds.password.clone();
            std::thread::spawn(move || {
                let acp_path = rich_path();
                if let Err(e) = start_sidecar(
                    &acp_handle,
                    "acp-client",
                    ACP_PORT,
                    "/acp/health",
                    None,
                    &[],
                    &[
                        ("PATH", acp_path.as_str()),
                        // In-sidecar orchestrator calls the OpenCode REST API
                        // (same credential channel as channel-gateway).
                        ("OPENCODE_SERVER_PASSWORD", acp_password.as_str()),
                    ],
                ) {
                    eprintln!("ACP Client startup failed: {}", e);
                    use tauri::Emitter;
                    let _ = acp_handle.emit(
                        "sidecar-startup-failed",
                        serde_json::json!({ "name": "acp-client", "error": e }),
                    );
                }
            });

            // Start OpenCode Server sidecar (critical — blocks until ready).
            // Credentials and auth_header were loaded at the top of setup().
            let oc_port = OPENCODE_PORT.to_string();
            if let Err(e) = start_sidecar(
                app,
                "opencode-server",
                OPENCODE_PORT,
                "/global/health",
                Some(&auth_header),
                &["serve", "--port", &oc_port],
                &[
                    ("OPENCODE_SERVER_PASSWORD", creds.password.as_str()),
                    ("OPENCODE_APP_NAME", OPENCODE_APP_NAME),
                ],
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
            } else {
                // OpenCode is healthy — eagerly trigger MCP InstanceState init in
                // the background so the first user prompt doesn't pay the per-MCP
                // spawn/connect cost.
                warm_opencode_mcp(OPENCODE_PORT, auth_header.clone());
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                shutdown_sidecars();
            }
        });
}

#[cfg(test)]
mod scan_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp(tag: &str) -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("uw-scan-{}-{}", tag, n))
    }

    #[test]
    fn collects_eligible_and_skips_noise() {
        let root = unique_tmp("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join("report.pdf"), "x").unwrap();
        std::fs::write(root.join("script.py"), "x").unwrap();
        std::fs::write(root.join("cache.pyc"), "x").unwrap();
        std::fs::write(root.join(".secret"), "x").unwrap();
        std::fs::write(root.join("sub/data.csv"), "x").unwrap();
        std::fs::write(root.join("node_modules/dep.js"), "x").unwrap();
        std::fs::write(root.join(".hidden/h.txt"), "x").unwrap();

        let names: Vec<String> = collect_changed_files(&root, 0)
            .into_iter()
            .map(|(p, _)| p.rsplit('/').next().unwrap().to_string())
            .collect();

        assert!(names.contains(&"report.pdf".to_string()));
        assert!(names.contains(&"script.py".to_string()));
        assert!(names.contains(&"data.csv".to_string())); // nested dir walked
        assert!(!names.contains(&"cache.pyc".to_string())); // ignored ext
        assert!(!names.contains(&".secret".to_string())); // dotfile
        assert!(!names.contains(&"dep.js".to_string())); // node_modules dir
        assert!(!names.contains(&"h.txt".to_string())); // .hidden dir

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn since_filter_excludes_older() {
        let root = unique_tmp("since");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "x").unwrap();
        // Baseline far in the future → nothing qualifies.
        let future =
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 1_000_000;
        assert!(collect_changed_files(&root, future).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_dir_yields_empty() {
        // scan_workspace_changes is async (runs off the UI thread); its dir guard
        // mirrors the helper's read_dir-failure path, tested here synchronously.
        assert!(collect_changed_files(std::path::Path::new("/no/such/dir/xyz"), 0).is_empty());
    }
}

#[cfg(test)]
mod builtin_skills_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp(tag: &str) -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("uw-builtin-{}-{}", tag, n))
    }

    #[test]
    fn needs_refresh_logic() {
        // up to date -> no refresh
        assert!(!builtin_needs_refresh("abc", Some("abc"), true));
        // version bumped -> refresh
        assert!(builtin_needs_refresh("def", Some("abc"), true));
        // target missing -> refresh
        assert!(builtin_needs_refresh("abc", Some("abc"), false));
        // no sentinel yet -> refresh
        assert!(builtin_needs_refresh("abc", None, true));
        // empty source version -> always refresh (defensive)
        assert!(builtin_needs_refresh("", Some(""), true));
    }

    #[test]
    fn copy_dir_recursive_copies_tree() {
        let src = unique_tmp("src");
        let dst = unique_tmp("dst");
        std::fs::create_dir_all(src.join("a/b")).unwrap();
        std::fs::write(src.join("top.txt"), "1").unwrap();
        std::fs::write(src.join("a/b/deep.txt"), "2").unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        assert_eq!(std::fs::read_to_string(dst.join("top.txt")).unwrap(), "1");
        assert_eq!(std::fs::read_to_string(dst.join("a/b/deep.txt")).unwrap(), "2");

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[test]
    fn refresh_only_wipes_builtin_not_siblings() {
        // Simulate the skills dir: builtin/ + a user-installed sibling. The
        // refresh removes only builtin/.
        let skills = unique_tmp("skills");
        let builtin = skills.join("builtin");
        let user = skills.join("my-skill");
        std::fs::create_dir_all(builtin.join("old")).unwrap();
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(user.join("SKILL.md"), "keep me").unwrap();

        let _ = std::fs::remove_dir_all(&builtin); // == the refresh step

        assert!(!builtin.exists(), "builtin wiped");
        assert!(user.join("SKILL.md").exists(), "user skill untouched");

        let _ = std::fs::remove_dir_all(&skills);
    }

    #[test]
    fn find_builtin_source_handles_layouts() {
        // map form: <root>/skills/builtin/.builtin-version
        let root = unique_tmp("res-map");
        let m = root.join("skills/builtin");
        std::fs::create_dir_all(&m).unwrap();
        std::fs::write(m.join(".builtin-version"), "v1").unwrap();
        assert_eq!(find_builtin_source(&root, 8).as_deref(), Some(m.as_path()));
        let _ = std::fs::remove_dir_all(&root);

        // _up_ mangled form: <root>/_up_/_up_/skills/builtin/.builtin-version
        let root2 = unique_tmp("res-up");
        let u = root2.join("_up_/_up_/skills/builtin");
        std::fs::create_dir_all(&u).unwrap();
        std::fs::write(u.join(".builtin-version"), "v1").unwrap();
        assert_eq!(find_builtin_source(&root2, 8).as_deref(), Some(u.as_path()));
        let _ = std::fs::remove_dir_all(&root2);

        // absent: returns None
        let root3 = unique_tmp("res-none");
        std::fs::create_dir_all(root3.join("a/b")).unwrap();
        assert!(find_builtin_source(&root3, 8).is_none());
        let _ = std::fs::remove_dir_all(&root3);
    }

    #[test]
    fn skill_dep_path_includes_system_dirs() {
        let p = skill_dep_path();
        assert!(p.contains("/usr/bin"), "skill dep path must include /usr/bin: {p}");
        // /bin/sh exists on every unix → probe must find it via the dep path.
        let res = probe_bins(&p, &["sh"]);
        assert!(res[0].available, "sh should be found via skill_dep_path");
    }

    #[test]
    fn extract_sentinel_handles_normal_noise_and_missing() {
        // normal
        assert_eq!(
            extract_sentinel("___UWPATH[/a/bin:/b/bin]UWPATH___").as_deref(),
            Some("/a/bin:/b/bin")
        );
        // surrounded by rc-file banner noise
        assert_eq!(
            extract_sentinel("Welcome!\nfoo\n___UWPATH[/x:/y]UWPATH___\ntrailing").as_deref(),
            Some("/x:/y")
        );
        // whitespace inside is trimmed
        assert_eq!(
            extract_sentinel("___UWPATH[  /p:/q  ]UWPATH___").as_deref(),
            Some("/p:/q")
        );
        // markers absent → None
        assert!(extract_sentinel("no markers here").is_none());
        // empty content → None
        assert!(extract_sentinel("___UWPATH[]UWPATH___").is_none());
        assert!(extract_sentinel("___UWPATH[   ]UWPATH___").is_none());
    }

    #[test]
    fn merge_paths_dedups_preserves_order_and_prefers_primary() {
        // primary entries come first, in order
        assert_eq!(merge_paths("/a:/b", "/c:/d"), "/a:/b:/c:/d");
        // duplicates from secondary are dropped, primary placement wins
        assert_eq!(merge_paths("/a:/b", "/b:/c:/a"), "/a:/b:/c");
        // empty segments skipped (trailing colon, double colon)
        assert_eq!(merge_paths("/a::/b:", ":/c::"), "/a:/b:/c");
        // empty primary falls through to secondary
        assert_eq!(merge_paths("", "/c:/d"), "/c:/d");
        // intra-primary dedup
        assert_eq!(merge_paths("/a:/a:/b", ""), "/a:/b");
    }

    #[test]
    fn probe_bins_detects_present_and_missing() {
        let dir = unique_tmp("bin");
        std::fs::create_dir_all(&dir).unwrap();
        let tool = dir.join("faketool");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();

        let path = format!("{}:/no/such/dir", dir.display());
        let res = probe_bins(&path, &["faketool", "definitely-missing-xyz"]);

        assert_eq!(res.len(), 2);
        let found = res.iter().find(|d| d.name == "faketool").unwrap();
        assert!(found.available);
        assert!(found.path.is_some());
        let missing = res.iter().find(|d| d.name == "definitely-missing-xyz").unwrap();
        assert!(!missing.available);
        assert!(missing.path.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
