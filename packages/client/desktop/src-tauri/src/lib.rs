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

/// OS PATH-list separator (";" on Windows, ":" on Unix).
const PATH_LIST_SEP: &str = if cfg!(windows) { ";" } else { ":" };

/// PIDs whose local TCP endpoint is bound to `port`. Unix uses `lsof`, Windows
/// parses `netstat -ano`. Returns empty on any failure (tool missing, no match).
fn pids_on_port(port: u16) -> Vec<u32> {
    let needle = format!(":{}", port);
    if cfg!(target_os = "windows") {
        // `-p tcp` lists IPv4 TCP only — consistent with is_port_in_use/check_health,
        // which connect to 127.0.0.1 (IPv4); sidecars must bind IPv4 to be detected
        // either way, and this conveniently avoids parsing `[::]:port` IPv6 rows.
        let Ok(output) = Command::new("netstat").args(["-ano", "-p", "tcp"]).output() else {
            return Vec::new();
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let mut pids = Vec::new();
        for line in text.lines() {
            // Columns: Proto  LocalAddress  ForeignAddress  State  PID
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 5 && cols[0].eq_ignore_ascii_case("TCP") && cols[1].ends_with(&needle) {
                if let Ok(pid) = cols[4].parse::<u32>() {
                    if pid != 0 && !pids.contains(&pid) {
                        pids.push(pid);
                    }
                }
            }
        }
        pids
    } else {
        let Ok(output) = Command::new("lsof").args(["-ti", &needle]).output() else {
            return Vec::new();
        };
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .collect()
    }
}

/// Terminate a process by PID using the platform-native killer
/// (`taskkill /F` on Windows, `kill` on Unix).
fn kill_pid(pid: u32) {
    if cfg!(target_os = "windows") {
        Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output().ok();
    } else {
        Command::new("kill").arg(pid.to_string()).output().ok();
    }
}

fn kill_port_process(port: u16) {
    for pid in pids_on_port(port) {
        println!("Killing stale process {} on port {}", pid, port);
        kill_pid(pid);
    }
    std::thread::sleep(Duration::from_millis(200));
}

/// Read a process's parent PID via `ps` (Unix). Orphan detection is a Unix
/// concept (launchd reparenting), so this returns None on Windows.
fn process_ppid(pid: u32) -> Option<u32> {
    if cfg!(target_os = "windows") {
        return None;
    }
    let output = Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse::<u32>().ok()
}

/// True if a process *listening* on `port` has been reparented to launchd
/// (ppid == 1) — i.e. it is an orphan left behind by a previous Ultrawork
/// instance that died without running `shutdown_sidecars` (crash / SIGKILL /
/// force-quit). Such a process is healthy but stale: reusing it would silently
/// bind us to a leftover (possibly old-version) sidecar. We detect it here so
/// `prepare_port` can reclaim the port instead of reusing it.
///
/// Windows has no launchd-style reparenting, so there is nothing to detect —
/// a healthy listener is always treated as a live owner there.
fn port_listener_orphaned(port: u16) -> bool {
    if cfg!(target_os = "windows") {
        return false;
    }
    let Ok(output) = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{}", port), "-sTCP:LISTEN", "-t"])
        .output()
    else {
        return false;
    };
    let pids = String::from_utf8_lossy(&output.stdout);
    for line in pids.trim().lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
            if process_ppid(pid) == Some(1) {
                return true;
            }
        }
    }
    false
}

/// Kill all registered sidecar processes on app exit.
/// Two-phase: (1) SIGTERM by PID, (2) port-based fallback for survivors.
fn shutdown_sidecars() {
    println!("[shutdown] Cleaning up sidecar processes...");

    // A pending `lark-cli config init` (office CLI connector) is not in the
    // sidecar registry — kill it here so it can't survive app quit and race a
    // next-launch init on the same CLI config file. Idempotent (slot drained).
    if let Ok(mut slot) = lark_init_slot().lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    let entries = match SIDECAR_REGISTRY.lock() {
        Ok(mut reg) => std::mem::take(&mut *reg),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    };

    // Phase 1: kill by PID
    for entry in &entries {
        if let Some(pid) = entry.pid {
            println!("[shutdown] Killing sidecar pid {} (port {})", pid, entry.port);
            kill_pid(pid);
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

/// Catch SIGINT/SIGTERM/SIGHUP and clean up sidecars before exiting. These are
/// exit paths Tauri's `RunEvent::Exit` does NOT cover (terminal Ctrl+C in dev,
/// `kill <pid>` without -9, some force-quit flows). SIGKILL is uncatchable, so
/// that crash path relies on `prepare_port`'s startup self-heal instead.
///
/// `signal-hook`'s `Signals` iterator delivers on a dedicated thread (not in an
/// async-signal context), so calling `shutdown_sidecars` here — which locks a
/// Mutex and spawns `kill` — is safe. `shutdown_sidecars` is idempotent (it
/// drains the registry), so a later `RunEvent::Exit` is a harmless no-op.
#[cfg(unix)]
fn install_signal_handlers() {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    std::thread::spawn(|| {
        let mut signals = match Signals::new([SIGINT, SIGTERM, SIGHUP]) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[signal] failed to install handlers: {}", e);
                return;
            }
        };
        if let Some(sig) = signals.forever().next() {
            println!("[signal] received signal {}, cleaning up sidecars", sig);
            shutdown_sidecars();
            std::process::exit(128 + sig);
        }
    });
}

/// Windows has no POSIX signals; the only catchable cleanup path is Tauri's
/// `RunEvent::Exit` (wired in `run()`). Console Ctrl+C / taskkill termination
/// falls back to `prepare_port`'s startup self-heal on the next launch.
#[cfg(not(unix))]
fn install_signal_handlers() {}

/// Prepare a port: reuse healthy process, kill stale, or confirm free.
/// Returns Ok(true) if a healthy process is already running (skip spawn),
/// Ok(false) if port is free and ready for a new spawn.
fn prepare_port(port: u16, health_path: &str, health_auth: Option<&str>) -> Result<bool, String> {
    if is_port_in_use(port) {
        // Reuse only a healthy listener that is still owned by a live parent
        // (a genuinely-running prior instance). A healthy *orphan* (ppid==1)
        // is a leftover from a crashed/killed instance — reclaim it rather than
        // bind to a possibly stale binary.
        if check_health(port, health_path, health_auth) {
            if port_listener_orphaned(port) {
                println!(
                    "Port {} healthy but owned by an orphan (prior instance died unclean), killing",
                    port
                );
                kill_port_process(port);
            } else {
                return Ok(true); // reuse
            }
        } else {
            println!("Port {} occupied but unhealthy, killing stale process", port);
            kill_port_process(port);
        }
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
            kill_pid(pid);
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
/// Delegates to tauri-plugin-opener, which uses the platform-native opener
/// (macOS `open` / Windows ShellExecute / Linux xdg-open) — no shell, so no
/// cmd-metacharacter escaping concerns with agent-generated artifact names.
#[tauri::command]
fn open_file_with_system(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    app.opener()
        .open_path(path.clone(), None::<&str>)
        .map_err(|e| format!("Failed to open {}: {}", path, e))
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

#[derive(Serialize)]
struct ProviderTestResult {
    ok: bool,
    status: u16,
    /// Classification consumed by the frontend to pick a localized message:
    /// "ok" | "auth" | "notfound" | "network" | "http".
    message: String,
}

/// Build the model-list URL used to probe a custom provider. OpenAI-compatible
/// base URLs already include the version segment (…/v1) → `{base}/models`.
/// Anthropic base URLs may or may not include `/v1`.
fn build_provider_test_url(base_url: &str, protocol: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if protocol == "anthropic" {
        if base.ends_with("/v1") {
            format!("{}/models", base)
        } else {
            format!("{}/v1/models", base)
        }
    } else {
        format!("{}/models", base)
    }
}

/// Suppress the console window a child process would otherwise flash on
/// Windows release builds (`windows_subsystem = "windows"`). No-op elsewhere.
fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Run a `curl` probe without popping a console window on Windows (release
/// builds are `windows_subsystem = "windows"`; a bare `.output()` flashes a
/// visible console for the probe's lifetime — same fix as `run_probe`).
fn run_curl_probe(args: &[String]) -> std::io::Result<std::process::Output> {
    let mut cmd = Command::new("curl");
    cmd.args(args);
    no_window(&mut cmd);
    cmd.output()
}

/// Map an HTTP status to the frontend message key. status 0 = couldn't connect.
fn classify_provider_status(status: u16) -> &'static str {
    match status {
        0 => "network",
        200..=299 => "ok",
        401 | 403 => "auth",
        404 => "notfound",
        _ => "http",
    }
}

/// Best-effort connectivity + auth check for a custom model provider. Shells out
/// to `curl` (same pattern as download_node — no extra HTTP dependency, no
/// webview CORS) and hits the provider's model-list endpoint. The API key only
/// ever travels to the provider's own host. Returns the HTTP status + a class.
#[tauri::command(async)]
async fn test_provider_connection(
    base_url: String,
    api_key: String,
    protocol: String,
) -> Result<ProviderTestResult, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Base URL is empty".into());
    }
    let url = build_provider_test_url(base, &protocol);
    let key = api_key.trim();

    let mut args: Vec<String> = vec![
        "-sS".into(),
        // Follow redirects so a model-list endpoint behind a 301/302 (common for
        // gateways that normalize trailing slashes) reports the final status, not
        // a bogus "3xx → http error".
        "-L".into(),
        "-o".into(),
        if cfg!(target_os = "windows") { "nul".into() } else { "/dev/null".into() },
        "-w".into(),
        "%{http_code}".into(),
        "-m".into(),
        "15".into(),
    ];
    if !key.is_empty() {
        args.push("-H".into());
        if protocol == "anthropic" {
            args.push(format!("x-api-key: {}", key));
        } else {
            args.push(format!("Authorization: Bearer {}", key));
        }
    }
    if protocol == "anthropic" {
        args.push("-H".into());
        args.push("anthropic-version: 2023-06-01".into());
    }
    args.push(url);

    let output = run_curl_probe(&args).map_err(|e| format!("Failed to run curl: {}", e))?;

    let status: u16 = String::from_utf8_lossy(&output.stdout).trim().parse().unwrap_or(0);
    Ok(ProviderTestResult {
        ok: (200..=299).contains(&status),
        status,
        message: classify_provider_status(status).to_string(),
    })
}

/// Probe URL + JSON body for a BYOK search provider (ADR-042). A minimal real
/// search (1 result, cheapest tier) is the only meaningful auth check — neither
/// Tavily nor Aliyun IQS has a free list/ping endpoint, so one test click costs
/// one search credit (the UI says so).
/// Pure w.r.t. the base URL so tests can't be tripped by ULTRAWORK_* shell env.
fn build_search_probe_with(provider: &str, base_override: Option<String>) -> Result<(String, String), String> {
    match provider {
        "tavily" => {
            let base = base_override.unwrap_or_else(|| "https://api.tavily.com".into());
            Ok((
                format!("{}/search", base.trim_end_matches('/')),
                r#"{"query":"ping","search_depth":"basic","max_results":1}"#.into(),
            ))
        }
        "aliyun-iqs" => {
            let base = base_override.unwrap_or_else(|| "https://cloud-iqs.aliyuncs.com".into());
            Ok((
                format!("{}/search/unified", base.trim_end_matches('/')),
                // Mirror the vendor searchIqs body shape (incl. `contents`) so the
                // probe can't get a spurious 400 from a body the real search never
                // sends — a valid key must not read as broken. summary=false keeps
                // it on the free tier.
                r#"{"query":"ping","engineType":"LiteAdvanced","timeRange":"NoLimit","contents":{"summary":false,"rerankScore":true},"advancedParams":{"numResults":1}}"#.into(),
            ))
        }
        other => Err(format!("Unknown search provider: {}", other)),
    }
}

/// Env-aware wrapper: base URLs are overridable so e2e runs can point the probe
/// at a local stub, mirroring the vendor websearch tool.
fn build_search_probe(provider: &str) -> Result<(String, String), String> {
    let base = match provider {
        "tavily" => std::env::var("ULTRAWORK_TAVILY_BASE_URL").ok(),
        "aliyun-iqs" => std::env::var("ULTRAWORK_ALIYUN_IQS_BASE_URL").ok(),
        _ => None,
    };
    build_search_probe_with(provider, base)
}

/// Connectivity + auth check for a BYOK web-search provider (Tavily/Aliyun IQS).
/// Same curl-out pattern as `test_provider_connection`: no webview CORS, and the
/// key never enters the renderer's network log — it only travels to the
/// provider's own host. Returns the HTTP status + a message class.
#[tauri::command(async)]
async fn test_search_provider(provider: String, api_key: String) -> Result<ProviderTestResult, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("API key is empty".into());
    }
    let (url, body) = build_search_probe(&provider)?;

    let curl_args: Vec<String> = vec![
        "-sS".into(),
        "-o".into(),
        if cfg!(target_os = "windows") { "nul".into() } else { "/dev/null".into() },
        "-w".into(),
        "%{http_code}".into(),
        "-m".into(),
        "15".into(),
        "-X".into(),
        "POST".into(),
        "-H".into(),
        "content-type: application/json".into(),
        "-H".into(),
        format!("Authorization: Bearer {}", key),
        "-d".into(),
        body,
        url,
    ];

    let output = run_curl_probe(&curl_args).map_err(|e| format!("Failed to run curl: {}", e))?;

    let status: u16 = String::from_utf8_lossy(&output.stdout).trim().parse().unwrap_or(0);
    Ok(ProviderTestResult {
        ok: (200..=299).contains(&status),
        status,
        message: classify_provider_status(status).to_string(),
    })
}

/// Reveal a file in the system file manager, highlighting it where supported.
/// Delegates to tauri-plugin-opener (macOS Finder `open -R` / Windows
/// `explorer /select,` / Linux opens the parent folder).
#[tauri::command]
fn reveal_file_in_finder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("Failed to reveal {}: {}", path, e))
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
        .unwrap_or_else(std::env::temp_dir)
        .join(".ultrawork")
}

fn mcp_dir() -> PathBuf {
    ultrawork_dir().join("mcp")
}

fn embedded_node_dir() -> PathBuf {
    ultrawork_dir().join("node")
}

fn embedded_node_bin() -> PathBuf {
    // Windows Node ships node.exe at the dist root; Unix uses bin/node.
    if cfg!(target_os = "windows") {
        embedded_node_dir().join("node.exe")
    } else {
        embedded_node_dir().join("bin").join("node")
    }
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

    // Determine platform + arch. Windows uses a .zip with node.exe + node_modules/npm
    // at the dist root; Unix uses a .tar.gz with bin/node + lib/node_modules/npm.
    let (platform, arch) = get_platform_arch()?;
    let is_win = cfg!(target_os = "windows");
    let ext = if is_win { "zip" } else { "tar.gz" };
    let archive_name = format!("node-{}-{}-{}.{}", NODE_VERSION, platform, arch, ext);
    let url = format!("https://nodejs.org/dist/{}/{}", NODE_VERSION, archive_name);
    let extracted_dir = format!("node-{}-{}-{}", NODE_VERSION, platform, arch);

    // Clean up any previous temp
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Download archive via curl (present on macOS, modern Windows 10+, and Linux runners)
    let archive_path = tmp_dir.join(&archive_name);
    let output = Command::new("curl")
        .args(["-fSL", "-o", &archive_path.to_string_lossy(), &url])
        .output()
        .map_err(|e| format!("Failed to run curl: {}", e))?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Download failed: {}", stderr));
    }

    // Extract. bsdtar (Windows 10+ `tar.exe`) auto-detects .zip — pull the whole
    // tree and copy what we need below; Unix extracts only the needed members.
    let extract = if is_win {
        Command::new("tar")
            .args(["-xf", &archive_path.to_string_lossy(), "-C", &tmp_dir.to_string_lossy()])
            .output()
    } else {
        Command::new("tar")
            .args([
                "-xzf", &archive_path.to_string_lossy(),
                "-C", &tmp_dir.to_string_lossy(),
                &format!("{}/bin/node", extracted_dir),
                &format!("{}/bin/npm", extracted_dir),
                &format!("{}/lib/node_modules/npm", extracted_dir),
            ])
            .output()
    };
    let output = extract.map_err(|e| format!("Failed to extract: {}", e))?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err("Failed to extract Node.js archive".to_string());
    }

    // Per-platform source (in the extracted tree) + target (in the embedded dir).
    let src_root = tmp_dir.join(&extracted_dir);
    let (src_node, src_npm, target_npm) = if is_win {
        (
            src_root.join("node.exe"),
            src_root.join("node_modules").join("npm"),
            node_dir.join("node_modules").join("npm"),
        )
    } else {
        (
            src_root.join("bin").join("node"),
            src_root.join("lib").join("node_modules").join("npm"),
            node_dir.join("lib").join("node_modules").join("npm"),
        )
    };

    // Create target parents (target_node parent: <dir> on win, <dir>/bin on unix).
    if let Some(p) = target_node.parent() {
        std::fs::create_dir_all(p)
            .map_err(|e| format!("Failed to create {}: {}", p.display(), e))?;
    }
    if let Some(p) = target_npm.parent() {
        std::fs::create_dir_all(p)
            .map_err(|e| format!("Failed to create {}: {}", p.display(), e))?;
    }

    // Copy node binary
    std::fs::copy(&src_node, &target_node)
        .map_err(|e| format!("Failed to copy node: {}", e))?;
    set_executable(&target_node)?;

    // Strip debug symbols (Unix; ~105MB → ~84MB). Re-sign on macOS (Apple Silicon
    // requires a valid signature). Both are no-ops / unavailable on Windows.
    if !is_win {
        let _ = Command::new("strip").arg(&target_node).output();
    }
    if cfg!(target_os = "macos") {
        let _ = Command::new("codesign")
            .args(["--remove-signature", &target_node.to_string_lossy()])
            .output();
        let _ = Command::new("codesign")
            .args(["-s", "-", &target_node.to_string_lossy()])
            .output();
    }

    // Copy npm package
    if src_npm.exists() {
        if target_npm.exists() {
            std::fs::remove_dir_all(&target_npm).ok();
        }
        copy_dir_recursive(&src_npm, &target_npm)?;
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
    } else if cfg!(target_os = "windows") {
        "win"
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
    for seg in primary.split(PATH_LIST_SEP).chain(secondary.split(PATH_LIST_SEP)) {
        if seg.is_empty() {
            continue;
        }
        if seen.insert(seg) {
            parts.push(seg);
        }
    }
    parts.join(PATH_LIST_SEP)
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
/// GUI-launched apps get a minimal PATH (see [`login_shell_path`]). The
/// app-managed office-cli dir leads (pinned CLIs must beat stale user
/// installs), then the user's real login-shell PATH (covers arbitrary custom
/// install dirs), then hard-coded Node.js locations as a fallback for
/// environments where the login shell is unavailable or doesn't export those.
/// Memoized — the login shell is invoked at most once per process.
fn rich_path() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(compute_rich_path).clone()
}

/// Hard-coded portion of [`rich_path`]: common Node.js install locations plus
/// the inherited PATH. Used directly when the login shell is unavailable.
fn rich_path_base() -> String {
    let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    let home = home.to_string_lossy();
    let current = std::env::var("PATH").unwrap_or_default();
    // Common Node install dirs. On Windows there's no login-shell PATH enrichment
    // (login_shell_path() is None), so add the standard installer / nvm-windows
    // symlink / Volta locations explicitly so `where node` finds a system Node even
    // when it isn't on the GUI-inherited PATH.
    let extras: Vec<String> = if cfg!(target_os = "windows") {
        let pf = std::env::var("ProgramFiles").unwrap_or_default();
        let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        [
            format!(r"{pf}\nodejs"),       // standard installer + nvm-windows active symlink
            format!(r"{pf86}\nodejs"),
            format!(r"{local}\Volta\bin"), // Volta for Windows
            format!(r"{appdata}\npm"),     // npm global bin
        ]
        .into_iter()
        .filter(|p| !p.starts_with('\\')) // drop entries whose env var was empty
        .collect()
    } else {
        vec![
            format!("{home}/.volta/bin"),
            format!("{home}/.local/bin"),
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
        ]
    };
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
    parts.join(PATH_LIST_SEP)
}

fn compute_rich_path() -> String {
    let base = rich_path_base();
    let merged = match login_shell_path() {
        Some(login) => merge_paths(&login, &base),
        None => base,
    };
    // App-managed office CLI installs (~/.ultrawork/office-cli/bin) go FIRST:
    // the dir only ever holds pinned, checksum-verified CLIs, and it must beat
    // any stale user install (brew / npm -g) so the agent's bash resolves the
    // same binary the connector card manages. Unconditional — a nonexistent
    // dir on PATH is harmless, and because rich_path() is memoized (and
    // sidecars inherit it at spawn), a mid-session install becomes visible
    // without an app restart.
    merge_paths(&office_cli_bin_dir().to_string_lossy(), &merged)
}

/// Detect system Node.js ≥v18 (fallback when embedded is unavailable).
fn detect_system_node() -> Option<NodeInfo> {
    let path_env = rich_path();
    // Windows `where` (may return several lines — take the first); Unix `which`.
    let which = if cfg!(target_os = "windows") { "where" } else { "/usr/bin/which" };
    let node_path = Command::new(which)
        .arg("node")
        .env("PATH", &path_env)
        .output()
        .ok()
        .and_then(|o| {
            let p = String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
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

/// Detect a system Chrome/Chromium browser path for the current platform.
#[tauri::command]
fn detect_chrome() -> Option<String> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    } else if cfg!(target_os = "windows") {
        // Per-user installs live under %LOCALAPPDATA%; checked first since Chrome
        // increasingly installs without admin rights.
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let user_chrome = format!(r"{}\Google\Chrome\Application\chrome.exe", local);
        return [
            user_chrome,
            r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string(),
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe".to_string(),
            r"C:\Program Files\Chromium\Application\chrome.exe".to_string(),
        ]
        .into_iter()
        .find(|p| !p.is_empty() && std::path::Path::new(p).exists());
    } else {
        &[
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
        ]
    };
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
    if cfg!(target_os = "windows") {
        // Windows has no pgrep — match by command line via WMI and tree-kill each
        // (taskkill /T also kills the Chrome children spawned by the MCP server).
        // "chrome-profile" (the user-data-dir folder name) is backslash-free, so it
        // needs no WQL LIKE escaping.
        for needle in &["chrome-devtools-mcp", "playwright-mcp", "@playwright/mcp", "chrome-profile"] {
            let ps = format!(
                "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%{}%'\" | \
                 ForEach-Object {{ taskkill /F /T /PID $_.ProcessId 2>$null }}",
                needle
            );
            Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
                .output()
                .ok();
        }
        return;
    }
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
    let mut candidates: Vec<PathBuf> = Vec::new();

    if cfg!(target_os = "windows") {
        // Windows Node (embedded or system): node.exe sits at <base>, with npm at
        // <base>/node_modules/npm/bin/npm-cli.js (no lib/ segment).
        if let Some(base) = node.parent() {
            candidates.push(base.join("node_modules/npm/bin/npm-cli.js"));
        }
    } else {
        // Embedded layout: <base>/bin/node → <base>/lib/node_modules/npm/...
        if let Some(base) = node.parent().and_then(|p| p.parent()) {
            candidates.push(base.join("lib/node_modules/npm/bin/npm-cli.js"));
        }
        // System layout: <bin_dir>/node → <bin_dir>/../lib/node_modules/npm/...
        if let Some(prefix) = node.parent().and_then(|p| p.parent()) {
            candidates.push(prefix.join("lib/node_modules/npm/bin/npm-cli.js"));
        }
    }

    candidates
        .into_iter()
        .find(|c| c.exists())
        .ok_or_else(|| "Cannot find npm-cli.js".to_string())
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
    let enriched_path = format!("{}{}{}", node_bin_dir, PATH_LIST_SEP, current_path);

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
// bundle.resources) as a single skills-builtin.zip + a `.builtin-version`
// sentinel beside it (built by scripts/pack-builtin-skills.ts from the loose
// git tree), and extracted at startup into ~/.config/ultrawork/skills/builtin
// so the OpenCode sidecar auto-discovers them ({skill,skills}/**/SKILL.md over
// the config dir). The zip deliberately does NOT contain the sentinel — the
// installer writes it into the staged tree only after a full extraction, so a
// visible sentinel always means a complete tree. vendor untouched, no
// opencode.json mutation. See skills/builtin/README.md + ADR-032/040.
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

/// Serializes every builtin-skills install/reconcile/override mutation.
/// refresh_builtin_skills and remove_user_skill_override are `async` commands
/// (thread pool) reachable concurrently from several renderer paths; without
/// exclusion two reconciles race on the SHARED staging dirs (.builtin.staging /
/// .builtin.restore) and a rename can land a partial tree as the live builtin.
static BUILTIN_SKILLS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Idempotently copy bundled built-in skills into the config skills dir,
/// gated by a content-hash sentinel (`.builtin-version`). On an app upgrade the
/// version changes and we wipe-and-recopy `builtin/` only. Afterwards (and on
/// every call, even when up to date) same-name shadowing is reconciled — a
/// user-installed skill deterministically wins over its builtin twin (see
/// reconcile_builtin_shadowing). Non-fatal at startup: the caller ignores Err
/// (skills simply won't appear).
fn ensure_builtin_skills(app: &tauri::AppHandle) -> Result<BuiltinSkillsStatus, String> {
    let _guard = BUILTIN_SKILLS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    ensure_builtin_skills_locked(app)
}

/// Body of ensure_builtin_skills; caller must hold BUILTIN_SKILLS_LOCK.
fn ensure_builtin_skills_locked(app: &tauri::AppHandle) -> Result<BuiltinSkillsStatus, String> {
    use tauri::Manager;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("no resource dir: {}", e))?;
    // Tauri can place a `..`-sourced resource at different depths (map form puts
    // it at the mapped destination; glob/array form mangles `..` into `_up_`
    // segments). Rather than guess, search the resource dir for the directory
    // holding our `.builtin-version` sentinel (bounded depth, cheap).
    let Some(src) = find_builtin_source(&resource_dir, 8) else {
        return Err(format!(
            "bundled source (.builtin-version) not found under {}",
            resource_dir.display()
        ));
    };
    let bundle_zip = src.join("skills-builtin.zip");
    if !bundle_zip.is_file() {
        return Err(format!(
            "bundled skills zip missing beside sentinel: {} (run scripts/pack-builtin-skills.ts)",
            bundle_zip.display()
        ));
    }
    let version = std::fs::read_to_string(src.join(".builtin-version"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if version.is_empty() {
        // An empty/unreadable sentinel would make builtin_needs_refresh true on
        // EVERY call (installed "" never matches) — a full 12k-file reinstall
        // per startup/workspace-switch. Fail cleanly like a missing zip instead.
        return Err(format!(
            "bundled sentinel empty/unreadable: {}",
            src.join(".builtin-version").display()
        ));
    }
    let target = builtin_skills_target();
    // Dot-dir staging siblings: excluded from opencode's {skill,skills}/** scan
    // (no `dot` option), so a leftover from an interrupted run is never picked
    // up as duplicate skills. Cleared on every call (lock held).
    let staging = target
        .parent()
        .map(|p| p.join(".builtin.staging"))
        .unwrap_or_else(|| target.with_extension("staging"));
    clear_staging(&staging);
    if let Some(parent) = target.parent() {
        clear_staging(&parent.join(".builtin.restore"));
    }
    let sentinel = target.join(".builtin-version");
    let stored = std::fs::read_to_string(&sentinel).ok().map(|s| s.trim().to_string());
    let mut installed_now = false;
    if builtin_needs_refresh(&version, stored.as_deref(), target.exists()) {
        // Refresh: extract-to-staging then rename so an interrupted extraction
        // (quit/disk-full mid-way through 12k files) can never leave a half tree
        // with a valid sentinel; the swap removes ONLY builtin/ — siblings under
        // skills/ are user-installed.
        let t0 = std::time::Instant::now();
        let files = install_builtin_tree(&bundle_zip, &version, &target, &staging).map_err(|e| {
            format!("install failed ({} -> {}): {}", bundle_zip.display(), target.display(), e)
        })?;
        println!(
            "[builtin-skills] installed {} files -> {} (version {}) in {}ms",
            files,
            target.display(),
            version,
            t0.elapsed().as_millis()
        );
        installed_now = true;
    }
    // Shadowing runs after install: on an upgrade-while-shadowed the fresh copy
    // of a shadowed skill is pruned right back (wasted extraction, but rare +
    // correct).
    let mut status = reconcile_builtin_shadowing(&bundle_zip, &target, &global_config_dir());
    status.changed |= installed_now;
    Ok(status)
}

/// Status of the bundled built-in skills vs user-installed same-name skills.
/// `bundled` = frontmatter names shipped in the app bundle; `shadowed` = the
/// subset currently overridden by a user install (builtin disk copy pruned);
/// `changed` = this call mutated disk (install/prune/restore) — the frontend
/// follows a changed reconcile with a soft refresh so opencode's cached scan
/// matches disk truth again.
#[derive(Debug, Clone, Serialize)]
struct BuiltinSkillsStatus {
    bundled: Vec<String>,
    shadowed: Vec<String>,
    changed: bool,
}

/// Parse the skill identity from SKILL.md the way opencode's registration does
/// (gray-matter + js-yaml + fallbackSanitization + zod `{name, description}`
/// pick, vendor skill/index.ts + config/markdown.ts): returns the frontmatter
/// `name` only when the WHOLE frontmatter block looks like YAML js-yaml would
/// accept AND a real `description` value is present — opencode silently SKIPS
/// files failing either, so a None here means "opencode will not register this
/// file". Callers must never prune a builtin based on a None/mismatch (that
/// would delete the builtin with no live replacement).
///
/// The validation is a conservative line-oriented approximation. Divergence
/// policy: when unsure return None — that fails OPEN (no prune; worst case the
/// duplicate race persists). Concretely: BOM stripped; the opening `---` must
/// be at column 0 and the fence must CLOSE; tab indentation rejected (js-yaml
/// errors); every unindented line must be a clean `key: value` (space after
/// the colon required — `key:x` is not a YAML mapping), keys must not repeat
/// (js-yaml throws on duplicates), and every value must be a shape we can
/// vouch for (plain/balanced-quoted scalar, `>`/`|` block header, single-line
/// balanced flow collection, or empty for nested blocks).
fn skill_registration_name(skill_md: &std::path::Path) -> Option<String> {
    let raw_text = std::fs::read_to_string(skill_md).ok()?;
    skill_registration_name_from_str(&raw_text)
}

/// Same predicate over in-memory content (SKILL.md read out of the bundled
/// zip); `skill_registration_name` is the on-disk wrapper.
fn skill_registration_name_from_str(raw_text: &str) -> Option<String> {
    let text = raw_text.strip_prefix('\u{feff}').unwrap_or(raw_text);
    let mut lines = text.lines();
    // gray-matter requires the file to START with the fence (column 0).
    let first = lines.next()?.strip_prefix("---")?;
    if !first.trim().is_empty() {
        return None;
    }
    let mut name: Option<String> = None;
    let mut has_description = false;
    let mut seen_keys: std::collections::HashSet<String> = Default::default();
    let mut closed = false;
    for line in lines {
        if line.starts_with('\t') {
            return None; // tab indentation is a js-yaml error
        }
        if line.starts_with(' ') {
            continue; // nested mapping / block-scalar continuation
        }
        let t = line.trim_end();
        if t == "---" {
            closed = true;
            break;
        }
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let colon = t.find(':')?;
        let (key, rest) = t.split_at(colon);
        let rest = &rest[1..];
        // `key:value` without a space is a plain scalar to YAML, not a mapping
        // entry — inside a block mapping js-yaml throws and opencode skips.
        if !rest.is_empty() && !rest.starts_with(' ') {
            return None;
        }
        let key = key.trim_end();
        if key.is_empty()
            || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return None; // quoted/complex keys — can't vouch, fail open
        }
        if !seen_keys.insert(key.to_string()) {
            return None; // js-yaml throws on duplicate mapping keys
        }
        let value = rest.trim();
        match key {
            "name" => {
                // Block-scalar names fold to a value we can't compute (fail
                // open via None from the scalar parser).
                name = parse_yaml_name_scalar(value);
            }
            "description" => {
                if value.is_empty() {
                    has_description = false; // null -> zod rejects
                } else if matches!(value.chars().next(), Some('>' | '|')) {
                    has_description = true; // folded block scalar
                } else if parse_yaml_name_scalar(value).is_some() {
                    has_description = true;
                } else {
                    return None; // comment-only / unterminated quote etc.
                }
            }
            _ => {
                if !yaml_line_value_ok(value) {
                    return None; // a throwing line anywhere skips the whole file
                }
            }
        }
    }
    if closed && has_description { name } else { None }
}

/// Can we vouch that js-yaml (plus opencode's fallbackSanitization) accepts
/// this single-line value? Empty = null/nested block; `>`/`|` = block scalar;
/// balanced single-line flow collections; otherwise a clean scalar.
fn yaml_line_value_ok(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    match value.chars().next() {
        Some('>' | '|') => true,
        Some('[') => value.ends_with(']'),
        Some('{') => value.ends_with('}'),
        _ => parse_yaml_name_scalar(value).is_some(),
    }
}

/// Conservative single-line YAML scalar for a `key: value` line. None on any
/// shape js-yaml would treat differently from a plain literal (see caller).
fn parse_yaml_name_scalar(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.starts_with('#') {
        return None; // empty / comment-only value = null
    }
    for q in ['"', '\''] {
        if let Some(body) = raw.strip_prefix(q) {
            // Unterminated quote makes js-yaml throw -> opencode skips the skill.
            let v = body.strip_suffix(q)?;
            return if v.is_empty() { None } else { Some(v.to_string()) };
        }
    }
    if matches!(raw.chars().next(), Some('>' | '|' | '&' | '*')) {
        return None; // block scalar / anchor — js-yaml resolves these; fail open
    }
    // YAML comments start at whitespace + '#' in plain scalars.
    let end = [" #", "\t#"]
        .iter()
        .filter_map(|m| raw.find(m))
        .min()
        .unwrap_or(raw.len());
    let v = raw[..end].trim();
    if v.is_empty() { None } else { Some(v.to_string()) }
}

/// Case-SENSITIVE lookup of a `SKILL.md` file in `dir`. `dir.join("SKILL.md")
/// .is_file()` would also match `skill.md` on case-insensitive filesystems
/// (macOS/Windows) which opencode's glob does not — pruning on such a match
/// would delete the builtin without a live replacement.
fn exact_skill_md(dir: &std::path::Path) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()) {
        if entry.file_name() == "SKILL.md" {
            let p = entry.path();
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// A user-installed skill discovered under the config skill roots.
/// `dir` is the directory containing its SKILL.md.
struct UserSkill {
    name: String,
    dir: PathBuf,
}

/// Bounded scan for user-installed skills under the CONFIG-DIR skill roots
/// (`skill/` and `skills/` — where skill-installer and the builtin pipeline
/// write). Deliberately narrower than opencode's full scan surface (which also
/// covers ~/.claude/skills, ~/.agents/skills, project dirs and cfg.skills.paths
/// — same-name skills there still race; out of scope per ADR-040) and than the
/// `**` glob (bounded depth, no descent past a skill dir — nested SKILL.md are
/// reference templates, not installs). Skips the managed builtin dir and
/// dot-dirs (staging leftovers), never reports a root itself (a stray SKILL.md
/// at the root would otherwise make the override-removal path delete the whole
/// roots tree), and only reports dirs opencode would actually register
/// (skill_registration_name — see fail-open policy there). Symlinked dirs are
/// followed (opencode's glob follows symlinks; depth bound caps cycles).
fn collect_user_skills(config_dir: &std::path::Path, builtin_dir: &std::path::Path, max_depth: usize) -> Vec<UserSkill> {
    let mut out = Vec::new();
    for root in ["skill", "skills"] {
        let root_path = config_dir.join(root);
        let mut stack = vec![(root_path, 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            if dir == builtin_dir {
                continue;
            }
            let fname = dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if depth > 0 && fname.starts_with('.') {
                continue;
            }
            if depth > 0 {
                if let Some(skill_md) = exact_skill_md(&dir) {
                    if let Some(name) = skill_registration_name(&skill_md) {
                        out.push(UserSkill { name, dir });
                    }
                    // Registered or not, don't descend past a skill-shaped dir.
                    continue;
                }
            }
            if depth >= max_depth {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let Ok(ft) = entry.file_type() else { continue };
                    if ft.is_dir() || (ft.is_symlink() && entry.path().is_dir()) {
                        stack.push((entry.path(), depth + 1));
                    }
                }
            }
        }
    }
    out
}

/// Deterministic same-name shadowing between bundled built-ins and user
/// installs (discussions/025 §5). opencode registers all skills from ONE glob
/// scan with unbounded concurrency — two same-name SKILL.md files race and the
/// winner is arbitrary. Resolved at the filesystem layer so the scan only ever
/// sees one copy:
///   prune   — a user skill with the same frontmatter name exists → delete the
///             builtin disk copy (user version PERMANENTLY wins, even across
///             app upgrades, until the user removes it);
///   restore — no user twin and the builtin dir is missing (previously pruned,
///             or hand-deleted) → recopy from the bundle via stage+rename, so
///             "remove user version → builtin returns" works without waiting
///             for an app upgrade to rotate the sentinel.
/// Errors are logged, not fatal: worst case the race window stays open until
/// the next reconcile.
fn reconcile_builtin_shadowing(
    bundle_zip: &std::path::Path,
    target: &std::path::Path,
    config_dir: &std::path::Path,
) -> BuiltinSkillsStatus {
    let user = collect_user_skills(config_dir, target, 6);
    let user_names: std::collections::HashSet<&str> =
        user.iter().map(|u| u.name.as_str()).collect();
    let mut bundled = Vec::new();
    let mut shadowed = Vec::new();
    let mut changed = false;
    // Enumerate bundled skills straight from the zip central directory: every
    // entry exactly at `<dir>/SKILL.md` marks a skill dir (mirrors the loose
    // tree's read_dir + SKILL.md gate; the root README.md has no dir and the
    // sentinel is not in the zip at all). A broken/missing zip fails OPEN —
    // empty bundled list means no prunes and no restores, logged, never fatal.
    let mut archive = match open_builtin_zip(bundle_zip) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[builtin-skills] reconcile: {}", e);
            return BuiltinSkillsStatus { bundled, shadowed, changed };
        }
    };
    let mut skill_dirs: Vec<(String, usize)> = Vec::new();
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index_raw(i) else { continue };
        let mut parts = entry.name().split('/');
        if let (Some(dir), Some("SKILL.md"), None) = (parts.next(), parts.next(), parts.next()) {
            // Mirror extract_builtin_zip's tamper-rejection on the derived dir
            // name: it keys `target.join` + `remove_dir_all` below, so a
            // hostile "../SKILL.md" entry (dir "..") would otherwise aim the
            // prune at the skills ROOT. Dot-prefixed names ("."/".."/
            // ".builtin-version" — deleting the live sentinel would thrash-
            // reinstall forever) are rejected wholesale: opencode's glob never
            // scans dot-dirs and the pack script never emits such names.
            let safe = !dir.is_empty()
                && !dir.starts_with('.')
                && !dir.contains('\\')
                && !dir.contains(':');
            if safe {
                skill_dirs.push((dir.to_string(), i));
            } else {
                eprintln!("[builtin-skills] ignoring unsafe zip skill dir: {}", entry.name());
            }
        }
    }
    skill_dirs.sort();
    for (dir_name, idx) in skill_dirs {
        // Bundle content is controlled (fetch script guarantees frontmatter);
        // the dirname fallback here can never mis-key a prune — pruning keys on
        // USER names, which have no fallback (see collect_user_skills).
        let name = archive
            .by_index(idx)
            .ok()
            .and_then(|mut f| {
                use std::io::Read;
                let mut s = String::new();
                f.read_to_string(&mut s).ok()?;
                skill_registration_name_from_str(&s)
            })
            .unwrap_or_else(|| dir_name.clone());
        bundled.push(name.clone());
        let installed = target.join(&dir_name);
        if user_names.contains(name.as_str()) {
            if installed.exists() {
                match std::fs::remove_dir_all(&installed) {
                    Ok(()) => {
                        changed = true;
                        println!(
                            "[builtin-skills] pruned builtin '{}' (shadowed by user install)",
                            name
                        );
                    }
                    Err(e) => {
                        eprintln!("[builtin-skills] prune {} failed: {}", installed.display(), e);
                        continue; // both copies still on disk — do not report as shadowed
                    }
                }
            }
            shadowed.push(name);
        } else if exact_skill_md(&installed).is_none() {
            // Missing OR partial (no SKILL.md — e.g. an interrupted earlier
            // restore): re-extract this skill's subtree from the bundled zip
            // (prefix-selective) so the tree self-heals without waiting for an
            // app upgrade to rotate the sentinel.
            let staging = target
                .parent()
                .map(|p| p.join(".builtin.restore"))
                .unwrap_or_else(|| target.with_extension("restore"));
            clear_staging(&staging);
            let _ = std::fs::create_dir_all(target);
            let t0 = std::time::Instant::now();
            let result = extract_builtin_zip(bundle_zip, Some(&dir_name), &staging).and_then(|n| {
                // A partial tree (or a stray plain FILE, which remove_dir_all
                // can't remove) at `installed` would make the rename fail.
                let _ = std::fs::remove_dir_all(&installed);
                let _ = std::fs::remove_file(&installed);
                std::fs::rename(&staging, &installed)
                    .map(|_| n)
                    .map_err(|e| format!("rename {} -> {}: {}", staging.display(), installed.display(), e))
            });
            match result {
                Ok(n) => {
                    changed = true;
                    println!(
                        "[builtin-skills] restored builtin '{}' from bundle ({} files in {}ms)",
                        name,
                        n,
                        t0.elapsed().as_millis()
                    );
                }
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&staging);
                    eprintln!("[builtin-skills] restore '{}' failed: {}", name, e);
                }
            }
        }
    }
    BuiltinSkillsStatus { bundled, shadowed, changed }
}

/// Re-run the builtin-skills install/shadowing reconcile on demand. The skills
/// settings page calls this before soft-refreshing opencode so a skill just
/// installed by skill-installer (mid-session, same name as a builtin) never
/// coexists with the builtin copy in a scan (`async`: real fs work off the UI
/// thread).
#[tauri::command(async)]
fn refresh_builtin_skills(app: tauri::AppHandle) -> Result<BuiltinSkillsStatus, String> {
    ensure_builtin_skills(&app)
}

/// Delete the user-installed override(s) of a BUILTIN skill and restore the
/// bundled copy. Refuses names that are not currently-shadowed builtins, so
/// this can never delete an unrelated user skill.
#[tauri::command(async)]
fn remove_user_skill_override(
    app: tauri::AppHandle,
    name: String,
) -> Result<BuiltinSkillsStatus, String> {
    // Hold the lock across verify → delete → restore so a concurrent
    // refresh_builtin_skills can't interleave with the mutation.
    let _guard = BUILTIN_SKILLS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let status = ensure_builtin_skills_locked(&app)?;
    if !status.shadowed.contains(&name) {
        return Err(format!("'{}' is not a shadowed builtin skill", name));
    }
    let config_dir = global_config_dir();
    let builtin = builtin_skills_target();
    let candidates = collect_user_skills(&config_dir, &builtin, 6);
    let mut removed = 0usize;
    for u in candidates.iter().filter(|u| u.name == name) {
        // Belt-and-suspenders: collect_user_skills already excludes builtin/ and
        // the roots themselves; verify anyway before a recursive delete.
        let under_root = ["skill", "skills"].iter().any(|r| {
            let root = config_dir.join(r);
            u.dir.starts_with(&root) && u.dir != root
        });
        if !under_root || u.dir.starts_with(&builtin) {
            return Err(format!("refusing to delete unexpected path {}", u.dir.display()));
        }
        // Never delete THROUGH a symlinked ancestor: `u.dir` may sit lexically
        // under the skills root while its contents physically live elsewhere
        // (skills/group -> ~/dev/my-skills); remove_dir_all would then destroy
        // the user's real source files. Refuse — manual removal is the safe out.
        let linked_ancestor = u
            .dir
            .ancestors()
            .skip(1)
            .take_while(|a| a.starts_with(&config_dir) && *a != config_dir.as_path())
            .any(|a| {
                std::fs::symlink_metadata(a)
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false)
            });
        if linked_ancestor {
            return Err(format!(
                "refusing to delete {} through a symlinked parent directory — remove it manually",
                u.dir.display()
            ));
        }
        // A symlinked install (skill dev workflow): remove only the link, never
        // the target it points to. Windows directory symlinks/junctions must be
        // removed with remove_dir — remove_file fails on them (unix symlinks
        // are files).
        let is_link = std::fs::symlink_metadata(&u.dir)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        let result = if is_link {
            if cfg!(target_os = "windows") {
                std::fs::remove_dir(&u.dir).or_else(|_| std::fs::remove_file(&u.dir))
            } else {
                std::fs::remove_file(&u.dir)
            }
        } else {
            std::fs::remove_dir_all(&u.dir)
        };
        result.map_err(|e| format!("remove {}: {}", u.dir.display(), e))?;
        println!("[builtin-skills] removed user override {} ('{}')", u.dir.display(), name);
        removed += 1;
    }
    if removed == 0 {
        return Err(format!("no user install of '{}' found to remove", name));
    }
    // Reconcile again: restores the builtin copy now that the override is gone.
    let mut fresh = ensure_builtin_skills_locked(&app)?;
    fresh.changed = true; // the delete itself mutated disk
    Ok(fresh)
}

/// Clear a staging path before use, robust to a SYMLINK planted there:
/// `remove_dir_all` errors on a top-level symlink (an error the `let _ =`
/// call sites swallow), after which extraction would write THROUGH the link
/// into whatever it points at. Kill links/files with remove_file/remove_dir
/// (Windows dir-symlinks need remove_dir), trees with remove_dir_all.
fn clear_staging(path: &std::path::Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    if meta.file_type().is_symlink() || meta.file_type().is_file() {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir(path);
    } else {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Open the bundled skills zip (built by scripts/pack-builtin-skills.ts,
/// shipped beside the `.builtin-version` sentinel in bundle.resources).
fn open_builtin_zip(
    zip_path: &std::path::Path,
) -> Result<zip::ZipArchive<std::io::BufReader<std::fs::File>>, String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("open {}: {}", zip_path.display(), e))?;
    zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("read zip {}: {}", zip_path.display(), e))
}

/// Extract the bundled skills zip into `dest` — all entries, or (for the
/// shadowing restore path) only those under `prefix/` with the prefix
/// stripped. Returns the number of files written; 0 matches is an error (a
/// rename of an empty staging dir would land a hollow tree that the SKILL.md
/// self-heal gate re-restores forever).
///
/// Security (zip-slip): every entry path must be "enclosed" — no absolute
/// paths, no `..` traversal (`enclosed_name`). Symlink entries are refused
/// outright: the pack script never emits them, and extracting one could
/// redirect later writes outside `dest`. Unix mode bits are restored so
/// bundled scripts keep their executable bit.
fn extract_builtin_zip(
    zip_path: &std::path::Path,
    prefix: Option<&str>,
    dest: &std::path::Path,
) -> Result<usize, String> {
    let mut archive = open_builtin_zip(zip_path)?;
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir {}: {}", dest.display(), e))?;
    let mut written = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry #{}: {}", i, e))?;
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(format!("refusing symlink zip entry: {}", entry.name()));
            }
        }
        // enclosed_name() SANITIZES an absolute name (strips the leading '/')
        // instead of rejecting it. Our own pack script never emits absolute
        // names, '\' separators or drive letters — any of those means a
        // tampered bundle, so refuse outright rather than guess.
        let raw = entry.name();
        if raw.starts_with('/') || raw.contains('\\') || raw.contains(':') {
            return Err(format!("unsafe zip entry path: {}", raw));
        }
        let Some(path) = entry.enclosed_name() else {
            return Err(format!("unsafe zip entry path: {}", entry.name()));
        };
        let rel = match prefix {
            Some(p) => match path.strip_prefix(p) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue, // other skills' entries
            },
            None => path,
        };
        if rel.as_os_str().is_empty() || entry.is_dir() {
            let _ = std::fs::create_dir_all(dest.join(&rel));
            continue;
        }
        let out_path = dest.join(&rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
        let mut out = std::fs::File::create(&out_path)
            .map_err(|e| format!("create {}: {}", out_path.display(), e))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("write {}: {}", out_path.display(), e))?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode & 0o777));
        }
        written += 1;
    }
    if written == 0 {
        return Err(format!(
            "no zip entries matched{} in {}",
            prefix.map(|p| format!(" prefix '{}'", p)).unwrap_or_default(),
            zip_path.display()
        ));
    }
    Ok(written)
}

/// Extract-to-staging-then-rename install of the builtin skills tree. The
/// sentinel is written into the staged tree only AFTER the full extraction
/// succeeded and becomes visible at `target` atomically with the rename
/// (same-volume); interruption leaves either the old consistent target or no
/// target at all — never "sentinel says done, tree is partial".
fn install_builtin_tree(
    zip_path: &std::path::Path,
    version: &str,
    target: &std::path::Path,
    staging: &std::path::Path,
) -> Result<usize, String> {
    clear_staging(staging);
    let written = extract_builtin_zip(zip_path, None, staging).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(staging);
    })?;
    std::fs::write(staging.join(".builtin-version"), format!("{}\n", version)).map_err(|e| {
        let _ = std::fs::remove_dir_all(staging);
        format!("write staged sentinel: {}", e)
    })?;
    let _ = std::fs::remove_dir_all(target);
    // A stray plain FILE at the target path (remove_dir_all can't remove it)
    // would fail the rename on every call — same belt-and-suspenders as restore.
    let _ = std::fs::remove_file(target);
    std::fs::rename(staging, target).map_err(|e| {
        let _ = std::fs::remove_dir_all(staging);
        format!("rename staging -> {}: {}", target.display(), e)
    })?;
    Ok(written)
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
    "lark-cli",
];

/// Probe a PATH-list (platform separator) for each bin (pure; testable).
fn probe_bins(path: &str, bins: &[&str]) -> Vec<DepStatus> {
    let dirs: Vec<&str> = path.split(PATH_LIST_SEP).filter(|s| !s.is_empty()).collect();
    // On Windows an executable on PATH carries an extension (PATHEXT).
    let exts: &[&str] = if cfg!(target_os = "windows") {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    bins
        .iter()
        .map(|bin| {
            let found = dirs
                .iter()
                .flat_map(|d| {
                    exts.iter()
                        .map(move |ext| std::path::Path::new(d).join(format!("{}{}", bin, ext)))
                })
                .find(|p| p.is_file());
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
    if cfg!(target_os = "windows") {
        // System dirs (System32, …) are already part of the inherited PATH.
        rich_path()
    } else {
        format!(
            "{p}{s}/usr/bin{s}/bin{s}/usr/sbin{s}/sbin",
            p = rich_path(),
            s = PATH_LIST_SEP
        )
    }
}

/// Run a probe command with output capture, a hard deadline, and no console
/// window on Windows. Returns None on spawn failure, timeout, or non-zero exit —
/// probes must never hang the caller (a stuck interpreter would otherwise pin
/// the skills page in "checking" forever).
fn run_probe(cmd: &mut Command, timeout: Duration) -> Option<std::process::Output> {
    let out = run_probe_capture(cmd, timeout)?;
    if out.status.success() { Some(out) } else { None }
}

/// Like [`run_probe`] but returns the output regardless of exit status. Needed
/// for CLIs that report state via typed exit codes with structured stdout
/// (lark-cli exits 3 for "not configured" while printing a JSON error object).
/// stdout/stderr drain on reader threads, so even a chatty or long-running
/// child (device-flow token polling) can never stall on a full pipe.
fn run_probe_capture(cmd: &mut Command, timeout: Duration) -> Option<std::process::Output> {
    no_window(cmd);
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    let out_h = child.stdout.take().map(spawn_drain);
    let err_h = child.stderr.take().map(spawn_drain);
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    };
    let stdout = out_h.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = err_h.and_then(|h| h.join().ok()).unwrap_or_default();
    Some(std::process::Output { status, stdout, stderr })
}

/// Reader thread draining a child stream to bytes (see run_probe_capture).
fn spawn_drain(
    stream: impl std::io::Read + Send + 'static,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut s = stream;
        let mut buf = Vec::new();
        let _ = s.read_to_end(&mut buf);
        buf
    })
}

/// macOS ships /usr/bin/python3 as an Xcode CLT shim; EXECUTING it without CLT
/// installed pops the system "install developer tools" dialog. Only run it when
/// CLT is actually present (`xcode-select -p` succeeds, cheap and dialog-free).
fn python_probe_allowed(python: &str) -> bool {
    if cfg!(target_os = "macos") && python == "/usr/bin/python3" {
        return Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    true
}

/// One-shot feature probe inside a python interpreter: (version >= 3.10, pptx
/// importable). `find_spec` avoids actually importing the package (fast, no side
/// effects). Returns None when the interpreter can't run the probe at all (spawn
/// failure / timeout / non-zero exit, e.g. a Windows Store alias stub) so the
/// caller can try the next candidate.
fn run_python_feature_probe(python: &str, timeout: Duration) -> Option<(bool, bool)> {
    const CODE: &str = "import sys, importlib.util\nprint(1 if sys.version_info >= (3, 10) else 0)\nprint(1 if importlib.util.find_spec('pptx') else 0)";
    let out = run_probe(Command::new(python).args(["-c", CODE]), timeout)?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let ver = lines.next().map(|l| l.trim() == "1")?;
    let pptx = lines.next().map(|l| l.trim() == "1")?;
    Some((ver, pptx))
}

/// Probe the PATH for the external tools built-in skills shell out to, plus
/// python feature probes (interpreter version / pip libraries — invisible to
/// PATH probing, gotchas §10). The frontend maps each skill to its required
/// tools (BUILTIN_DEP_MAP) and renders readiness badges.
/// `async`: runs off the UI thread — the python probes spawn real processes.
#[tauri::command(async)]
fn check_skill_dependencies() -> Vec<DepStatus> {
    let mut deps = probe_bins(&skill_dep_path(), SKILL_DEP_BINS);

    // Candidate interpreters, in order. On Windows the python.org installer
    // provides only `python.exe` (no python3) and `python3.exe` may be a Store
    // App-Execution-Alias stub — the execution-based probe rejects stubs
    // (non-zero exit) and falls through to the next candidate.
    let mut candidates: Vec<String> = deps
        .iter()
        .filter(|d| d.name == "python3" && d.available)
        .filter_map(|d| d.path.clone())
        .collect();
    if cfg!(target_os = "windows") {
        candidates.extend(
            probe_bins(&skill_dep_path(), &["python"])
                .into_iter()
                .filter(|d| d.available)
                .filter_map(|d| d.path),
        );
    }

    // ppt-master hard-requires Python >= 3.10 (module-level `X | None` unions)
    // and python-pptx for the PPTX export step (svg_to_pptx.py).
    let mut ver = false;
    let mut pptx = false;
    // The interpreter the verdict is about — surfaced in the badge tooltip so a
    // "still missing after install" case is self-explanatory (e.g. the user
    // installed a versioned `python3.11` while `python3` still resolves to 3.9).
    let mut probed: Option<String> = None;
    for c in &candidates {
        if !python_probe_allowed(c) {
            continue;
        }
        if let Some((v, p)) = run_python_feature_probe(c, Duration::from_secs(5)) {
            ver = v;
            pptx = p;
            probed = Some(c.clone());
            break;
        }
    }
    deps.push(DepStatus { name: "python3.10+".into(), available: ver, path: probed.clone() });
    deps.push(DepStatus { name: "python-pptx".into(), available: pptx, path: probed });
    deps
}

// ── Office CLI connectors (lark-cli; discussions/027) ──────────────
//
// A "CLI connector" is an official, agent-native vendor CLI (Feishu/Lark
// today; DingTalk / WeCom in later phases) that the Settings page installs,
// health-checks and authorizes. The CLI keeps its own credentials (OS
// keychain) — the app never touches tokens. Usage happens through the
// agent's bash tool (a built-in skill routes to `lark-cli skills read …`),
// NOT through MCP, so nothing here writes OpenCode `mcp` config.

const LARK_CLI_VERSION: &str = "1.0.65";

/// sha256 digests of the official release archives, copied from the npm
/// package's checksums.txt for the pinned version (the darwin-arm64 entry was
/// additionally verified against a live GitHub download on 2026-07-06).
/// Update together with LARK_CLI_VERSION.
const LARK_CLI_CHECKSUMS: &[(&str, &str)] = &[
    ("lark-cli-1.0.65-darwin-amd64.tar.gz", "7d8a4539ade2b1bda46936ceae2a73e42a414e444a75b9e2e0f39294b8e61b07"),
    ("lark-cli-1.0.65-darwin-arm64.tar.gz", "9135e0412cf6bcb0ce6e6de3308ba878f6f16a887af46c806bdaa17d7d86e768"),
    ("lark-cli-1.0.65-linux-amd64.tar.gz", "2d8fbd33e79d06efcd7243971d3a4e1a049ad91d04f0ca97214c6730e10c24c8"),
    ("lark-cli-1.0.65-linux-arm64.tar.gz", "f3f11a2e163b2ea9698ae4c5f923a4fbca28274f44cd0a4689bf7588f229242e"),
    ("lark-cli-1.0.65-windows-amd64.zip", "6175f8a45fa0039467e785397745665f46a02f6260d36c6cf46f67b597f157d8"),
    ("lark-cli-1.0.65-windows-arm64.zip", "249bb01c366d64080d91e39cecb79dcd0a47a0fd46b9eab0e16fff17d2068ed2"),
];

fn office_cli_dir() -> PathBuf {
    ultrawork_dir().join("office-cli")
}

fn office_cli_bin_dir() -> PathBuf {
    office_cli_dir().join("bin")
}

/// PATH for locating office CLIs: the app-managed dir first, then everything
/// the skill probes see (rich login-shell PATH + system dirs) so a
/// user-installed lark-cli (brew / npm -g) is honored too.
fn office_cli_probe_path() -> String {
    merge_paths(&office_cli_bin_dir().to_string_lossy(), &skill_dep_path())
}

fn find_lark_cli() -> Option<String> {
    probe_bins(&office_cli_probe_path(), &["lark-cli"])
        .into_iter()
        .find(|d| d.available)
        .and_then(|d| d.path)
}

/// Base lark-cli invocation: notifier `_notice` noise suppressed so JSON
/// output stays machine-readable (documented in the CLI's lark-shared skill).
fn lark_cmd(bin: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .env("LARKSUITE_CLI_NO_UPDATE_NOTIFIER", "1")
        .env("LARKSUITE_CLI_NO_SKILLS_NOTIFIER", "1");
    cmd
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CliConnectorState {
    NotInstalled,
    NotConfigured,
    NotAuthorized,
    Connected,
    Error,
}

#[derive(Debug, Serialize)]
struct CliConnectorStatus {
    id: String,
    state: CliConnectorState,
    path: Option<String>,
    version: Option<String>,
    /// User-facing detail: identity name when connected, error hint otherwise.
    detail: Option<String>,
}

/// Pure classifier for `lark-cli auth status --json` output. Two real shapes
/// (device-verified 2026-07-06, v1.0.65):
/// - typed error document `{ok:false, error:{type,subtype,message,hint}}` on
///   stderr with a nonzero exit (e.g. not_configured, exit 3);
/// - status document on stdout with exit 0 once configured — **no `ok` field
///   at all**: `{appId, brand, identities:{bot:{status,available,…},
///   user:{status:"missing"|…, available:bool, …}}, identity, note}`.
///   `identities.user.available` is the authorization verdict.
fn classify_lark_auth_status(stdout: &str) -> (CliConnectorState, Option<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        // Error verdicts must always carry a non-empty detail: the UI banner
        // renders off it and "" is falsy in JS (real-device lesson — an empty
        // detail shows a red badge with no explanation to act on).
        let tail: String = stdout.trim().chars().take(200).collect();
        let detail = if tail.is_empty() { "empty output from lark-cli".to_string() } else { tail };
        return (CliConnectorState::Error, Some(detail));
    };
    // Typed error document (`"error": null` from a Go struct counts too —
    // it still means "not a status document").
    if v.get("error").is_some() {
        let etype = v.pointer("/error/type").and_then(|s| s.as_str()).unwrap_or("");
        let esub = v.pointer("/error/subtype").and_then(|s| s.as_str()).unwrap_or("");
        if esub == "not_configured" {
            return (CliConnectorState::NotConfigured, None);
        }
        if etype == "auth" {
            return (CliConnectorState::NotAuthorized, None);
        }
        let msg = v
            .pointer("/error/message")
            .and_then(|s| s.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "lark-cli reported an unrecognized error".to_string());
        return (CliConnectorState::Error, Some(msg));
    }
    // Status document: configured; the user identity decides authorization.
    if let Some(user) = v.pointer("/identities/user") {
        let available = user.get("available").and_then(|b| b.as_bool()).unwrap_or(false);
        // Defensive: a dead token must never render a green card even if the
        // CLI still reports the identity as available.
        let token_status = user.get("tokenStatus").and_then(|s| s.as_str()).unwrap_or("");
        if !available || matches!(token_status, "expired" | "invalid" | "revoked") {
            return (CliConnectorState::NotAuthorized, None);
        }
        let name = user
            .get("userName")
            .or_else(|| user.get("name"))
            .and_then(|s| s.as_str())
            .map(str::to_string);
        return (CliConnectorState::Connected, name);
    }
    // Bare ok:true without identities (shape from the CLI's lark-shared doc).
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        return (CliConnectorState::Connected, None);
    }
    (CliConnectorState::Error, Some("unrecognized auth status output".into()))
}

/// lark-cli prints typed *error* JSON to stderr (unix convention: errors →
/// stderr even when structured) and success JSON to stdout. Real-device
/// finding 2026-07-06: probing stdout alone reads "" for the not_configured
/// state and misclassifies it as Error. Prefer stdout, fall back to stderr.
fn lark_json_output(out: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() {
        String::from_utf8_lossy(&out.stderr).into_owned()
    } else {
        stdout.into_owned()
    }
}

/// "lark-cli version 1.0.65" → "1.0.65".
fn parse_lark_cli_version(s: &str) -> Option<String> {
    s.split_whitespace()
        .last()
        .filter(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_string)
}

/// Version strings keyed by resolved binary path. The UI polls
/// check_cli_connectors every 3s during the hosted-config flow; the binary's
/// version can't change under a stable path except through install_office_cli
/// (which invalidates the entry), so cache it instead of spawning
/// `lark-cli --version` on every poll. A user upgrading an external install
/// mid-session shows a stale version label until restart — cosmetic only.
static CLI_VERSION_CACHE: OnceLock<Mutex<std::collections::HashMap<String, String>>> =
    OnceLock::new();

fn cli_version_cache() -> &'static Mutex<std::collections::HashMap<String, String>> {
    CLI_VERSION_CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn probe_lark_status() -> CliConnectorStatus {
    let Some(bin) = find_lark_cli() else {
        return CliConnectorStatus {
            id: "lark".into(),
            state: CliConnectorState::NotInstalled,
            path: None,
            version: None,
            detail: None,
        };
    };
    let cached = cli_version_cache().lock().ok().and_then(|m| m.get(&bin).cloned());
    let version = cached.or_else(|| {
        let v = run_probe(&mut lark_cmd(&bin, &["--version"]), Duration::from_secs(5))
            .and_then(|o| parse_lark_cli_version(&String::from_utf8_lossy(&o.stdout)));
        if let (Some(v), Ok(mut m)) = (&v, cli_version_cache().lock()) {
            m.insert(bin.clone(), v.clone());
        }
        v
    });
    let (state, detail) = match run_probe_capture(
        &mut lark_cmd(&bin, &["auth", "status", "--json"]),
        Duration::from_secs(5),
    ) {
        Some(out) => classify_lark_auth_status(&lark_json_output(&out)),
        None => (
            CliConnectorState::Error,
            Some("lark-cli auth status timed out".into()),
        ),
    };
    CliConnectorStatus { id: "lark".into(), state, path: Some(bin), version, detail }
}

/// Probe every known office CLI connector (Phase 1: Feishu/Lark only).
/// `async`: spawns real probe processes off the UI thread.
#[tauri::command(async)]
fn check_cli_connectors() -> Vec<CliConnectorStatus> {
    reap_finished_config_init();
    vec![probe_lark_status()]
}

fn lark_cli_archive_name() -> Result<String, String> {
    // lark-cli uses Go release naming (darwin/linux/windows + amd64/arm64) —
    // distinct from Node's darwin/win + x64 naming in get_platform_arch().
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        return Err("Unsupported platform for lark-cli".to_string());
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "amd64"
    } else {
        return Err("Unsupported architecture for lark-cli".to_string());
    };
    let ext = if cfg!(target_os = "windows") { "zip" } else { "tar.gz" };
    Ok(format!("lark-cli-{LARK_CLI_VERSION}-{platform}-{arch}.{ext}"))
}

/// Download chain mirroring the official npm installer: GitHub Releases
/// first, the public npmmirror binary proxy as the mainland-China fallback.
fn lark_cli_download_urls(archive: &str) -> Vec<String> {
    vec![
        format!("https://github.com/larksuite/cli/releases/download/v{LARK_CLI_VERSION}/{archive}"),
        format!("https://registry.npmmirror.com/-/binary/lark-cli/v{LARK_CLI_VERSION}/{archive}"),
    ]
}

fn expected_lark_checksum(archive: &str) -> Option<&'static str> {
    LARK_CLI_CHECKSUMS
        .iter()
        .find(|(name, _)| *name == archive)
        .map(|(_, hash)| *hash)
}

/// Streamed sha256 of a file as lowercase hex (archives are ~12MB).
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::Digest;
    let mut file = std::fs::File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read {}: {}", path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Everything the generic install pipeline needs for one connector. Phase 2/3
/// (dingtalk / wecom) add a spec, not a copy of the pipeline.
struct CliInstallSpec {
    archive: String,
    urls: Vec<String>,
    expected_sha256: &'static str,
    /// Binary name at the archive root (the official npm installer copies
    /// `tmpDir/<name>` for every platform, confirming the flat layout).
    bin_name: &'static str,
}

fn lark_install_spec() -> Result<CliInstallSpec, String> {
    let archive = lark_cli_archive_name()?;
    let expected_sha256 = expected_lark_checksum(&archive)
        .ok_or_else(|| format!("no pinned checksum for {archive}"))?;
    let urls = lark_cli_download_urls(&archive);
    let bin_name = if cfg!(target_os = "windows") { "lark-cli.exe" } else { "lark-cli" };
    Ok(CliInstallSpec { archive, urls, expected_sha256, bin_name })
}

/// Download → sha256-verify → extract → install one pinned CLI binary into
/// ~/.ultrawork/office-cli/bin. Returns the installed binary path.
fn install_pinned_cli(spec: &CliInstallSpec) -> Result<PathBuf, String> {
    let bin_dir = office_cli_bin_dir();
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("create {}: {}", bin_dir.display(), e))?;
    let tmp = office_cli_dir().join(".install-tmp");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("create {}: {}", tmp.display(), e))?;
    // Everything below cleans up tmp on both success and failure.
    let result = (|| {
        let archive_path = tmp.join(&spec.archive);

        let mut last_err = String::from("no download source succeeded");
        let mut downloaded = false;
        for url in &spec.urls {
            let args: Vec<String> = [
                "-fSL",
                "--connect-timeout", "10",
                "--max-time", "180",
                "-o", &archive_path.to_string_lossy(),
                url,
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            match run_curl_probe(&args) {
                Ok(out) if out.status.success() => {
                    downloaded = true;
                    break;
                }
                Ok(out) => last_err = String::from_utf8_lossy(&out.stderr).trim().to_string(),
                Err(e) => last_err = format!("failed to run curl: {e}"),
            }
        }
        if !downloaded {
            return Err(format!("Download failed: {last_err}"));
        }

        let actual = sha256_file(&archive_path)?;
        if !actual.eq_ignore_ascii_case(spec.expected_sha256) {
            return Err(format!(
                "[security] checksum mismatch for {}: expected {}, got {actual}",
                spec.archive, spec.expected_sha256
            ));
        }

        // Extract in the temp dir. bsdtar (Windows 10+ tar.exe) auto-detects .zip.
        let tar_flag = if cfg!(target_os = "windows") { "-xf" } else { "-xzf" };
        let mut tar = Command::new("tar");
        tar.args([
            tar_flag,
            &archive_path.to_string_lossy(),
            "-C",
            &tmp.to_string_lossy(),
        ]);
        no_window(&mut tar);
        let out = tar.output().map_err(|e| format!("failed to run tar: {e}"))?;
        if !out.status.success() {
            return Err(format!("Failed to extract {}", spec.archive));
        }

        let src = tmp.join(spec.bin_name);
        let dest = bin_dir.join(spec.bin_name);
        std::fs::copy(&src, &dest).map_err(|e| format!("failed to install binary: {e}"))?;
        set_executable(&dest)?;
        Ok(dest)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Install (or repair) an office CLI into ~/.ultrawork/office-cli/bin.
/// Pinned version + pinned sha256; GitHub → npmmirror download chain.
#[tauri::command(async)]
fn install_office_cli(id: String) -> Result<CliConnectorStatus, String> {
    if id != "lark" {
        return Err(format!("unknown CLI connector: {id}"));
    }
    let dest = install_pinned_cli(&lark_install_spec()?)?;
    // The binary under this path just changed — drop the cached version label.
    if let Ok(mut m) = cli_version_cache().lock() {
        m.remove(&dest.to_string_lossy().to_string());
    }
    Ok(probe_lark_status())
}

/// The pending `config init` child, if any. The process stays alive until the
/// user completes the hosted setup flow in the browser (or it expires), so it
/// outlives the invoke that spawned it.
static LARK_INIT_CHILD: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();

fn lark_init_slot() -> &'static Mutex<Option<std::process::Child>> {
    LARK_INIT_CHILD.get_or_init(|| Mutex::new(None))
}

/// Reap a completed config-init child (called from the status probe, which the
/// UI polls while waiting for the hosted flow — a natural reap point).
fn reap_finished_config_init() {
    if let Ok(mut slot) = lark_init_slot().lock() {
        let exited = slot
            .as_mut()
            .map(|c| matches!(c.try_wait(), Ok(Some(_)) | Err(_)))
            .unwrap_or(false);
        if exited {
            *slot = None; // try_wait already reaped it
        }
    }
}

/// First `https://` token in a `config init` output line that looks like the
/// hosted setup URL (it carries the `user_code` pairing parameter). Pure.
fn find_lark_config_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let token: String = line[start..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    if token.contains("user_code=") { Some(token) } else { None }
}

fn spawn_line_reader(
    stream: impl std::io::Read + Send + 'static,
    tx: std::sync::mpsc::Sender<String>,
) {
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stream);
        // Keep draining to EOF even after the receiver is gone — a blocked
        // pipe would stall the long-lived child mid-flow.
        for line in reader.lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
}

/// Kick off `lark-cli config init --new` and return the hosted setup URL from
/// its output. The child keeps running (it completes the local config write
/// only when the user finishes in the browser); the UI polls
/// `check_cli_connectors` to observe completion.
#[tauri::command(async)]
fn start_office_cli_config(id: String, lang: Option<String>) -> Result<String, String> {
    if id != "lark" {
        return Err(format!("unknown CLI connector: {id}"));
    }
    let bin = find_lark_cli().ok_or("lark-cli is not installed")?;

    let mut cmd = lark_cmd(&bin, &["config", "init", "--new"]);
    if let Some(l) = lang.as_deref().filter(|l| !l.is_empty()) {
        cmd.args(["--lang", l]);
    }
    no_window(&mut cmd);
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start lark-cli: {e}"))?;

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    if let Some(out) = child.stdout.take() {
        spawn_line_reader(out, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        spawn_line_reader(err, tx.clone());
    }
    drop(tx);

    // Park the child in the slot IMMEDIATELY (pipes already taken), replacing —
    // and killing — any previous pending init: two concurrent hosted-page
    // flows would race on the same config file, and storing early means a
    // second invoke always finds (and kills) this child rather than both
    // slipping past an empty slot (double-click race).
    let child_pid = child.id();
    if let Ok(mut slot) = lark_init_slot().lock() {
        if let Some(mut old) = slot.replace(child) {
            let _ = old.kill();
            let _ = old.wait();
        }
    }
    // From here on, the child is owned by the slot; clean up via the slot with
    // a pid guard so we never kill a successor started by a newer invoke.
    let kill_ours = || {
        if let Ok(mut slot) = lark_init_slot().lock() {
            if slot.as_ref().map(std::process::Child::id) == Some(child_pid) {
                if let Some(mut ours) = slot.take() {
                    let _ = ours.kill();
                    let _ = ours.wait();
                }
            }
        }
    };

    let deadline = std::time::Instant::now() + Duration::from_secs(25);
    let mut tail: Vec<String> = Vec::new();
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        match rx.recv_timeout(deadline - now) {
            Ok(line) => {
                if let Some(url) = find_lark_config_url(&line) {
                    // Child stays parked in the slot: it completes the local
                    // config write only when the user finishes in the browser.
                    return Ok(url);
                }
                // Keep a short non-QR tail for the error message.
                if !line.trim().is_empty() && !line.contains('█') {
                    tail.push(line.trim().to_string());
                    if tail.len() > 5 {
                        tail.remove(0);
                    }
                }
            }
            // Disconnected = both streams hit EOF (process exited early).
            Err(_) => break,
        }
    }
    kill_ours();
    Err(format!(
        "config init did not produce a setup URL: {}",
        tail.join(" / ")
    ))
}

#[derive(Debug, Serialize)]
struct CliDeviceLogin {
    device_code: String,
    user_code: Option<String>,
    verification_uri: Option<String>,
    verification_uri_complete: Option<String>,
    expires_in: Option<u64>,
    interval: Option<u64>,
}

/// Pure parser for `lark-cli auth login --no-wait --json`. Top-level OAuth
/// device-flow fields (json tags confirmed in the binary); if real-device
/// acceptance reveals a different nesting, the missing-device_code error below
/// fails loudly and the fix is local.
fn parse_lark_device_login(stdout: &str) -> Result<CliDeviceLogin, String> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| format!("unparseable auth login output: {}", stdout.trim().chars().take(200).collect::<String>()))?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(false) {
        let msg = v
            .pointer("/error/message")
            .and_then(|s| s.as_str())
            .unwrap_or("auth login failed");
        return Err(msg.to_string());
    }
    let s = |k: &str| -> Option<String> { v.get(k).and_then(|x| x.as_str()).map(str::to_string) };
    let n = |k: &str| -> Option<u64> { v.get(k).and_then(|x| x.as_u64()) };
    Ok(CliDeviceLogin {
        device_code: s("device_code").ok_or("missing device_code in auth login output")?,
        user_code: s("user_code"),
        // Real shape (device-verified 2026-07-06, v1.0.65): the field is
        // `verification_url` and it already embeds the user_code — the
        // `verification_uri`/`_complete` spellings (json tags of another
        // struct in the binary) are kept as fallbacks.
        verification_uri: s("verification_url").or_else(|| s("verification_uri")),
        verification_uri_complete: s("verification_uri_complete"),
        expires_in: n("expires_in"),
        interval: n("interval"),
    })
}

/// Initiate the OAuth device flow (`auth login --no-wait --json`). Returns the
/// verification URL + device code; the UI opens the URL, then calls
/// `complete_office_cli_auth` to poll for the token exchange.
#[tauri::command(async)]
fn start_office_cli_auth(id: String) -> Result<CliDeviceLogin, String> {
    if id != "lark" {
        return Err(format!("unknown CLI connector: {id}"));
    }
    let bin = find_lark_cli().ok_or("lark-cli is not installed")?;
    let out = run_probe_capture(
        &mut lark_cmd(&bin, &["auth", "login", "--domain", "all", "--no-wait", "--json"]),
        Duration::from_secs(30),
    )
    .ok_or("lark-cli auth login timed out")?;
    parse_lark_device_login(&lark_json_output(&out))
}

/// String-typed convenience over [`run_probe_capture`] for long-running calls
/// whose output the caller inspects on failure (device-flow token polling).
fn run_streaming(cmd: &mut Command, timeout: Duration) -> Option<(bool, String, String)> {
    let out = run_probe_capture(cmd, timeout)?;
    Some((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// Complete the device flow: blocks while the CLI polls the token endpoint
/// (`auth login --device-code …`), bounded by the device code's own expiry.
#[tauri::command(async)]
fn complete_office_cli_auth(
    id: String,
    device_code: String,
    expires_in: Option<u64>,
) -> Result<CliConnectorStatus, String> {
    if id != "lark" {
        return Err(format!("unknown CLI connector: {id}"));
    }
    let bin = find_lark_cli().ok_or("lark-cli is not installed")?;
    let timeout = Duration::from_secs(expires_in.unwrap_or(300).min(900) + 30);
    let (ok, stdout, stderr) = run_streaming(
        &mut lark_cmd(&bin, &["auth", "login", "--device-code", &device_code, "--json"]),
        timeout,
    )
    .ok_or("authorization polling timed out")?;
    classify_complete_auth(ok, &stdout, &stderr)?;
    Ok(probe_lark_status())
}

/// Pure verdict for `auth login --device-code` output: Ok when the flow
/// completed, Err(message) otherwise. Real-device finding 2026-07-06: when
/// some requested scopes aren't enabled on the app (we ask --domain all; a
/// fresh hosted app only has the basics), the CLI COMPLETES the authorization,
/// reports event:"authorization_complete" with granted/missing lists on
/// stderr, and still exits nonzero — that's a success for the connector; the
/// status probe is the truth, and missing domains are granted incrementally at
/// runtime by the skill (lark-shared guidance).
fn classify_complete_auth(exit_ok: bool, stdout: &str, stderr: &str) -> Result<(), String> {
    if exit_ok {
        return Ok(());
    }
    // Error JSON arrives on stderr (see lark_json_output) — pick the
    // populated stream first.
    let raw = if stdout.trim().is_empty() { stderr } else { stdout };
    let v = serde_json::from_str::<serde_json::Value>(raw.trim()).ok();
    let auth_complete = v
        .as_ref()
        .and_then(|v| v.get("event"))
        .and_then(|s| s.as_str())
        == Some("authorization_complete");
    if auth_complete {
        return Ok(());
    }
    Err(v
        .and_then(|v| {
            v.pointer("/error/message")
                .and_then(|s| s.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| raw.trim().chars().take(300).collect()))
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
            check_cli_connectors,
            install_office_cli,
            start_office_cli_config,
            start_office_cli_auth,
            complete_office_cli_auth,
            refresh_builtin_skills,
            remove_user_skill_override,
            scan_workspace_changes,
            read_file_bytes,
            test_provider_connection,
            test_search_provider,
        ])
        .setup(|app| {
            // Stage 0: catch catchable termination signals so sidecars are
            // cleaned up on exit paths RunEvent::Exit misses (Ctrl+C, plain kill).
            install_signal_handlers();

            // Stage 1: copy bundled sidecars into ~/.ultrawork/sidecars/ so MCPs
            // and any external tooling can use a stable user-local path.
            ensure_sidecar_copies();

            // Stage 1b: copy bundled built-in skills into the config skills dir
            // (before OpenCode starts, so the first /skill scan sees them) and
            // reconcile same-name shadowing (user installs win, gotchas §10).
            if let Err(e) = ensure_builtin_skills(app.handle()) {
                eprintln!("[builtin-skills] {}", e);
            }

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
            // PATH: rich (login-shell) PATH, same as acp-client — skills shell out
            // to python3/pandoc/… and a Finder-launched app only inherits the
            // minimal GUI PATH. This also keeps the skill-dependency probes
            // (skill_dep_path, rich-based) consistent with what skill bash
            // actually resolves at runtime.
            let oc_port = OPENCODE_PORT.to_string();
            let oc_path = rich_path();
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
                    ("PATH", oc_path.as_str()),
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
mod search_probe_tests {
    use super::*;

    // Test the pure variant: build_search_probe reads ULTRAWORK_* env overrides,
    // which a developer shell (pointing at an e2e stub) could have exported.
    #[test]
    fn tavily_probe_defaults() {
        let (url, body) = build_search_probe_with("tavily", None).unwrap();
        assert_eq!(url, "https://api.tavily.com/search");
        assert!(body.contains("\"max_results\":1"));
        assert!(body.contains("\"search_depth\":\"basic\""));
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["query"], "ping");
    }

    #[test]
    fn iqs_probe_uses_cheapest_engine() {
        let (url, body) = build_search_probe_with("aliyun-iqs", None).unwrap();
        assert_eq!(url, "https://cloud-iqs.aliyuncs.com/search/unified");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["engineType"], "LiteAdvanced");
        assert_eq!(v["advancedParams"]["numResults"], 1);
    }

    #[test]
    fn base_override_trims_trailing_slash() {
        let (url, _) = build_search_probe_with("tavily", Some("http://127.0.0.1:8093/".into())).unwrap();
        assert_eq!(url, "http://127.0.0.1:8093/search");
    }

    #[test]
    fn unknown_provider_rejected() {
        assert!(build_search_probe_with("exa", None).is_err());
        assert!(build_search_probe_with("", None).is_err());
    }
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
            .map(|(p, _)| {
                std::path::Path::new(&p).file_name().unwrap().to_string_lossy().to_string()
            })
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
    #[cfg(unix)] // asserts POSIX system dirs / sh; skill_dep_path() differs on Windows
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
    #[cfg(unix)] // hardcodes ":" PATH separator; PATH_LIST_SEP is ";" on Windows
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
    #[cfg(unix)] // uses ":" PATH separator + POSIX dirs; PATH_LIST_SEP differs on Windows
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

    #[test]
    #[cfg(unix)] // fake interpreters are shell scripts
    fn run_python_feature_probe_parses_and_rejects() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_tmp("pylib");
        std::fs::create_dir_all(&dir).unwrap();
        let mk = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        };

        // modern python with pptx
        let both = mk("py-both", "#!/bin/sh\necho 1\necho 1\n");
        assert_eq!(run_python_feature_probe(both.to_str().unwrap(), Duration::from_secs(5)), Some((true, true)));
        // modern python, no pptx
        let ver_only = mk("py-ver", "#!/bin/sh\necho 1\necho 0\n");
        assert_eq!(run_python_feature_probe(ver_only.to_str().unwrap(), Duration::from_secs(5)), Some((true, false)));
        // broken interpreter / Store alias stub (non-zero exit) -> None (try next candidate)
        let stub = mk("py-stub", "#!/bin/sh\nexit 9\n");
        assert_eq!(run_python_feature_probe(stub.to_str().unwrap(), Duration::from_secs(5)), None);
        // missing binary -> None, no panic
        assert_eq!(run_python_feature_probe(dir.join("nope").to_str().unwrap(), Duration::from_secs(5)), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn run_probe_kills_hung_process_on_timeout() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_tmp("probe-hang");
        std::fs::create_dir_all(&dir).unwrap();
        let hang = dir.join("hang");
        std::fs::write(&hang, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&hang, std::fs::Permissions::from_mode(0o755)).unwrap();

        let start = std::time::Instant::now();
        let out = run_probe(&mut Command::new(hang.to_str().unwrap()), Duration::from_millis(300));
        assert!(out.is_none());
        assert!(start.elapsed() < Duration::from_secs(5), "timeout did not bound the probe");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Build a small test zip mirroring the pack script's output shape
    /// (file entries only, '/' separators, no sentinel inside).
    fn write_test_zip(path: &std::path::Path, entries: &[(&str, &str)]) {
        use std::io::Write;
        let file = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(content.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn install_builtin_tree_stages_then_swaps() {
        let root = unique_tmp("ibt");
        std::fs::create_dir_all(&root).unwrap();
        let zip = root.join("skills-builtin.zip");
        write_test_zip(&zip, &[("ppt-master/SKILL.md", "---\nname: x\n---\n")]);
        let target = root.join("target");
        let staging = root.join("staging");

        // Pre-existing garbage in staging (interrupted previous run) must not leak.
        std::fs::create_dir_all(staging.join("stale")).unwrap();
        // Old target content must be fully replaced.
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("old-file"), "x").unwrap();

        let n = install_builtin_tree(&zip, "v1", &target, &staging).unwrap();

        assert_eq!(n, 1);
        // Sentinel is written by the installer from the OUTSIDE version (the
        // zip itself has none) and must be visible only in the final tree.
        assert_eq!(
            std::fs::read_to_string(target.join(".builtin-version")).unwrap().trim(),
            "v1"
        );
        assert!(target.join("ppt-master/SKILL.md").is_file());
        assert!(!target.join("old-file").exists(), "old target content not wiped");
        assert!(!target.join("stale").exists(), "stale staging content must not leak");
        assert!(!staging.exists(), "staging must be consumed by the rename");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_refresh_preserves_old_consistent_tree() {
        // Extraction happens INTO STAGING before the old target is touched — a
        // corrupt bundle zip must leave the previously installed tree (and its
        // sentinel) fully intact. Anchors the code ordering: reordering
        // remove_dir_all(target) before the extract would break this.
        let root = unique_tmp("keepold");
        std::fs::create_dir_all(&root).unwrap();
        let zip = root.join("skills-builtin.zip");
        write_test_zip(&zip, &[("ppt-master/SKILL.md", "old")]);
        let target = root.join("target");
        let staging = root.join("staging");
        install_builtin_tree(&zip, "v1", &target, &staging).unwrap();

        std::fs::write(&zip, b"this is not a zip").unwrap();
        assert!(install_builtin_tree(&zip, "v2", &target, &staging).is_err());

        assert_eq!(
            std::fs::read_to_string(target.join(".builtin-version")).unwrap().trim(),
            "v1",
            "old sentinel must survive a failed refresh"
        );
        assert!(target.join("ppt-master/SKILL.md").is_file(), "old tree must survive");
        assert!(!staging.exists(), "failed staging must be cleaned");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_rejects_zip_slip_and_absolute_paths() {
        let root = unique_tmp("zipslip");
        std::fs::create_dir_all(&root).unwrap();
        for evil in ["../evil.txt", "a/../../evil.txt"] {
            let zip = root.join("z.zip");
            write_test_zip(&zip, &[("ok/SKILL.md", "x"), (evil, "boom")]);
            let dest = root.join("out");
            let _ = std::fs::remove_dir_all(&dest);
            assert!(
                extract_builtin_zip(&zip, None, &dest).is_err(),
                "entry {} must be rejected",
                evil
            );
            assert!(!root.join("evil.txt").exists(), "{} escaped the dest dir", evil);
        }

        // ZipWriter itself normalizes a leading '/', so a genuinely absolute
        // entry (what a hostile zip would carry) is forged by byte-patching an
        // equal-length name in both the local header and central directory.
        let zip = root.join("abs.zip");
        write_test_zip(&zip, &[("aa/evil.txt", "boom")]);
        let bytes = std::fs::read(&zip).unwrap();
        let patched: Vec<u8> = {
            let from = b"aa/evil.txt";
            let to = b"/a/evil.txt";
            let mut out = bytes.clone();
            let mut i = 0;
            while i + from.len() <= out.len() {
                if &out[i..i + from.len()] == from {
                    out[i..i + to.len()].copy_from_slice(to);
                }
                i += 1;
            }
            out
        };
        std::fs::write(&zip, patched).unwrap();
        assert!(
            extract_builtin_zip(&zip, None, &root.join("out-abs")).is_err(),
            "absolute entry path must be rejected"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_rejects_symlink_entries() {
        let root = unique_tmp("ziplink");
        std::fs::create_dir_all(&root).unwrap();
        let zip = root.join("z.zip");
        {
            use std::io::Write;
            let f = std::fs::File::create(&zip).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("ok/SKILL.md", opts).unwrap();
            w.write_all(b"x").unwrap();
            w.add_symlink("ok/link", "/etc/passwd", opts).unwrap();
            w.finish().unwrap();
        }
        let dest = root.join("out");
        assert!(extract_builtin_zip(&zip, None, &dest).is_err());
        assert!(!dest.join("ok/link").exists(), "symlink entry must not materialize");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_prefix_selects_single_skill_and_strips_prefix() {
        let root = unique_tmp("zipprefix");
        std::fs::create_dir_all(&root).unwrap();
        let zip = root.join("z.zip");
        write_test_zip(
            &zip,
            &[
                ("ppt-master/SKILL.md", "a"),
                ("ppt-master/scripts/tool.py", "b"),
                // Same string prefix but a different dir — must NOT match
                // (component-wise strip_prefix, not starts_with on the string).
                ("ppt-master-extra/SKILL.md", "c"),
                ("doc-edit/SKILL.md", "d"),
            ],
        );
        let dest = root.join("out");
        let n = extract_builtin_zip(&zip, Some("ppt-master"), &dest).unwrap();
        assert_eq!(n, 2);
        assert!(dest.join("SKILL.md").is_file(), "prefix must be stripped");
        assert!(dest.join("scripts/tool.py").is_file());
        assert!(!dest.join("doc-edit").exists());
        assert!(!dest.join("ppt-master-extra").exists());

        // Zero matches is an error — a rename of a hollow staging dir would
        // otherwise land a tree the SKILL.md self-heal gate re-restores forever.
        assert!(extract_builtin_zip(&zip, Some("nope"), &root.join("out2")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reconcile_ignores_hostile_traversal_skill_dirs() {
        // A tampered bundle carrying "../SKILL.md" (dir "..") must never key a
        // prune/restore: target.join("..") is the skills ROOT and a prune there
        // would remove_dir_all every user skill.
        let (config, _src, target) = shadow_fixture("shadow-hostile");
        let zip = config.join("bundle-src").join("hostile.zip");
        write_test_zip(
            &zip,
            &[
                ("../SKILL.md", "---\nname: alpha\ndescription: x\n---\n"),
                ("./SKILL.md", "---\nname: alpha\ndescription: x\n---\n"),
                // Deleting target/.builtin-version via a restore would
                // thrash-reinstall forever — dot-prefixed dirs are rejected.
                (".builtin-version/SKILL.md", "---\nname: alpha\ndescription: x\n---\n"),
                ("doc-edit/SKILL.md", "---\nname: doc-edit\ndescription: bundled\n---\n"),
            ],
        );
        // A user skill whose name the hostile entry claims — the bait.
        let user = config.join("skills").join("alpha");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(user.join("SKILL.md"), "---\nname: alpha\ndescription: x\n---\n").unwrap();

        let status = reconcile_builtin_shadowing(&zip, &target, &config);

        assert!(config.join("skills").exists(), "skills root must survive");
        assert!(user.join("SKILL.md").is_file(), "user skill must survive");
        assert!(target.join("doc-edit/SKILL.md").is_file(), "builtin must survive");
        assert!(
            !status.bundled.iter().any(|n| n == "alpha"),
            "hostile entries must not enter the bundled list: {:?}",
            status.bundled
        );
        let _ = std::fs::remove_dir_all(&config);
    }

    #[cfg(unix)]
    #[test]
    fn install_replaces_symlinked_staging_instead_of_writing_through() {
        // A symlink planted at the staging path must be REPLACED, not followed:
        // remove_dir_all errors on a top-level symlink (swallowed by `let _ =`),
        // after which extraction would write through it into the victim dir.
        let root = unique_tmp("stg-link");
        std::fs::create_dir_all(&root).unwrap();
        let zip = root.join("skills-builtin.zip");
        write_test_zip(&zip, &[("ppt-master/SKILL.md", "x")]);
        let victim = root.join("victim");
        std::fs::create_dir_all(&victim).unwrap();
        let staging = root.join("staging");
        std::os::unix::fs::symlink(&victim, &staging).unwrap();
        let target = root.join("target");

        install_builtin_tree(&zip, "v1", &target, &staging).unwrap();

        assert!(
            !victim.join("ppt-master").exists(),
            "extraction must not write through the planted symlink"
        );
        assert!(target.join("ppt-master/SKILL.md").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn extract_restores_exec_bits() {
        use std::os::unix::fs::PermissionsExt;
        let root = unique_tmp("zipmode");
        std::fs::create_dir_all(&root).unwrap();
        let zip = root.join("z.zip");
        {
            use std::io::Write;
            let f = std::fs::File::create(&zip).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let x = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            w.start_file("s/run.py", x).unwrap();
            w.write_all(b"#!/usr/bin/env python3\n").unwrap();
            w.finish().unwrap();
        }
        let dest = root.join("out");
        extract_builtin_zip(&zip, None, &dest).unwrap();
        let mode = std::fs::metadata(dest.join("s/run.py")).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "exec bits must survive extraction: {:o}", mode);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skill_registration_name_mirrors_opencode_predicate() {
        let dir = unique_tmp("fm");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("SKILL.md");

        std::fs::write(&f, "---\nname: ppt-master\ndescription: x\n---\nbody").unwrap();
        assert_eq!(skill_registration_name(&f).as_deref(), Some("ppt-master"));

        // Block-scalar description (ppt-master upstream shape) counts as present.
        std::fs::write(&f, "---\nname: ppt-master\ndescription: >\n  folded text\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f).as_deref(), Some("ppt-master"));

        std::fs::write(&f, "---\nname: \"quoted-name\"\ndescription: x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f).as_deref(), Some("quoted-name"));

        // Trailing comment on an unquoted scalar is stripped (js-yaml semantics).
        std::fs::write(&f, "---\nname: ppt-master # my fork\ndescription: x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f).as_deref(), Some("ppt-master"));

        // BOM before the frontmatter fence must not break parsing.
        std::fs::write(&f, "\u{feff}---\nname: ppt-master\ndescription: x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f).as_deref(), Some("ppt-master"));

        // CRLF (Windows checkout) parses identically.
        std::fs::write(&f, "---\r\nname: ppt-master\r\ndescription: x\r\n---\r\n").unwrap();
        assert_eq!(skill_registration_name(&f).as_deref(), Some("ppt-master"));

        // opencode requires name AND description — either missing means the
        // file is never registered, so it must never key a prune.
        std::fs::write(&f, "---\nname: ppt-master\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // Unterminated quote makes js-yaml throw -> opencode skips.
        std::fs::write(&f, "---\nname: \"ppt-master\ndescription: x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // Block-scalar NAME is resolved by js-yaml to a folded value we don't
        // implement — fail open.
        std::fs::write(&f, "---\nname: >\n  ppt-master\ndescription: x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // Indented `name:` is nested under another key (e.g. metadata:) — not
        // the skill name.
        std::fs::write(&f, "---\nmetadata:\n   name: nested\ndescription: x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // No frontmatter fence at all.
        std::fs::write(&f, "# just markdown\nname: not-frontmatter\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // Comment-valued description = null to js-yaml -> zod rejects -> skip.
        std::fs::write(&f, "---\nname: ppt-master\ndescription: # TODO write\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // `key:value` without a space is NOT a YAML mapping entry — js-yaml
        // throws inside a block mapping and opencode skips the file.
        std::fs::write(&f, "---\nname:ppt-master\ndescription: x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);
        std::fs::write(&f, "---\nname: ppt-master\ndescription:x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // A throwing line ANYWHERE in the block skips the whole file.
        std::fs::write(&f, "---\nname: ppt-master\ndescription: x\nlicense: \"MIT\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);
        std::fs::write(&f, "---\nname: ppt-master\ntags: [a, b\ndescription: x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // Duplicate mapping keys make js-yaml throw.
        std::fs::write(&f, "---\nname: a\nname: ppt-master\ndescription: x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // gray-matter requires the opening fence at column 0.
        std::fs::write(&f, "   ---\nname: ppt-master\ndescription: x\n---\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // Unclosed frontmatter never yields data.
        std::fs::write(&f, "---\nname: ppt-master\ndescription: x\n").unwrap();
        assert_eq!(skill_registration_name(&f), None);

        // Benign shapes real skills use must PASS: single-line flow sequence,
        // nested mappings (indented), empty-valued parent keys.
        std::fs::write(
            &f,
            "---\nname: ppt-master\ndescription: x\nx-requires: [python3.10+, python-pptx]\nmetadata:\n   author: someone\n---\n",
        ).unwrap();
        assert_eq!(skill_registration_name(&f).as_deref(), Some("ppt-master"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn all_real_bundled_skill_md_parse_as_registrable() {
        // The whole-block validator must never reject our own shipped skills —
        // a false negative here would break shadowing for that skill (and a
        // regression would only surface at runtime).
        let bundled = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../skills/builtin");
        let mut checked = 0;
        for entry in std::fs::read_dir(&bundled).expect("skills/builtin missing") {
            let entry = entry.unwrap();
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let name = skill_registration_name(&skill_md);
            assert!(
                name.is_some(),
                "bundled skill {} failed the registration parser",
                skill_md.display()
            );
            checked += 1;
        }
        assert!(checked >= 6, "expected >= 6 bundled skills, found {}", checked);
    }

    /// Lay out a fake config dir with a bundled zip (two skills, plus a root
    /// README.md that must never count as a skill) and an installed builtin
    /// tree, returning (config_dir, bundle_zip, builtin_target).
    fn shadow_fixture(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let config = unique_tmp(tag);
        std::fs::create_dir_all(config.join("bundle-src")).unwrap();
        let src = config.join("bundle-src").join("skills-builtin.zip");
        write_test_zip(
            &src,
            &[
                ("ppt-master/SKILL.md", "---\nname: ppt-master\ndescription: bundled\n---\n"),
                ("ppt-master/scripts/tool.py", "print('hi')\n"),
                ("doc-edit/SKILL.md", "---\nname: doc-edit\ndescription: bundled\n---\n"),
                ("doc-edit/scripts/tool.py", "print('hi')\n"),
                ("README.md", "not a skill\n"),
            ],
        );
        let target = config.join("skills").join("builtin");
        extract_builtin_zip(&src, None, &target).unwrap();
        (config, src, target)
    }

    #[test]
    fn reconcile_prunes_builtin_when_user_installs_same_name() {
        let (config, src, target) = shadow_fixture("shadow-prune");
        // User install under a DIFFERENT dir name but same frontmatter name —
        // shadowing must key on the frontmatter name (opencode's index key).
        let user = config.join("skills").join("my-ppt");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(user.join("SKILL.md"), "---\nname: ppt-master\ndescription: mine\n---\nuser version").unwrap();

        let status = reconcile_builtin_shadowing(&src, &target, &config);

        assert_eq!(status.shadowed, vec!["ppt-master"]);
        assert!(status.changed, "prune must report changed");
        assert!(status.bundled.contains(&"ppt-master".to_string()));
        assert!(status.bundled.contains(&"doc-edit".to_string()));
        assert!(!target.join("ppt-master").exists(), "builtin copy must be pruned");
        assert!(target.join("doc-edit/SKILL.md").is_file(), "unrelated builtin untouched");
        assert!(user.join("SKILL.md").is_file(), "user install untouched");

        // Idempotent: a second run keeps the exact same state and reports no change.
        let again = reconcile_builtin_shadowing(&src, &target, &config);
        assert_eq!(again.shadowed, vec!["ppt-master"]);
        assert!(!again.changed, "steady state must not report changed");
        assert!(!target.join("ppt-master").exists());

        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn reconcile_never_prunes_for_dirs_opencode_would_not_register() {
        let (config, src, target) = shadow_fixture("shadow-junk");
        // A junk dir named like the builtin but with frontmatter opencode
        // rejects (no description / no name): opencode registers NEITHER it nor
        // a replacement — pruning would make the skill vanish entirely.
        let junk = config.join("skills").join("ppt-master");
        std::fs::create_dir_all(&junk).unwrap();
        std::fs::write(junk.join("SKILL.md"), "just some notes, no frontmatter").unwrap();

        let status = reconcile_builtin_shadowing(&src, &target, &config);
        assert!(status.shadowed.is_empty(), "junk dir must not shadow");
        assert!(target.join("ppt-master/SKILL.md").is_file(), "builtin must survive");

        // Same for name-without-description (zod pick requires both).
        std::fs::write(junk.join("SKILL.md"), "---\nname: ppt-master\n---\n").unwrap();
        let status = reconcile_builtin_shadowing(&src, &target, &config);
        assert!(status.shadowed.is_empty(), "name-only frontmatter must not shadow");
        assert!(target.join("ppt-master/SKILL.md").is_file());

        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn reconcile_restores_builtin_after_user_removed() {
        let (config, src, target) = shadow_fixture("shadow-restore");
        let user = config.join("skills").join("ppt-master");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(user.join("SKILL.md"), "---\nname: ppt-master\ndescription: mine\n---\n").unwrap();
        reconcile_builtin_shadowing(&src, &target, &config);
        assert!(!target.join("ppt-master").exists());

        // User removes their copy → builtin restored from bundle (full tree).
        std::fs::remove_dir_all(&user).unwrap();
        let status = reconcile_builtin_shadowing(&src, &target, &config);

        assert!(status.shadowed.is_empty());
        assert!(status.changed, "restore must report changed");
        assert!(target.join("ppt-master/SKILL.md").is_file());
        assert!(target.join("ppt-master/scripts/tool.py").is_file());
        assert!(
            !config.join("skills").join(".builtin.restore").exists(),
            "restore staging must be consumed"
        );

        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn reconcile_heals_partial_builtin_tree() {
        let (config, src, target) = shadow_fixture("shadow-heal");
        // Simulate an interrupted earlier restore: builtin dir exists but has
        // no SKILL.md (partial tree). The old `.exists()` gate would keep this
        // corpse forever (sentinel still valid); the SKILL.md gate self-heals.
        std::fs::remove_dir_all(target.join("ppt-master")).unwrap();
        std::fs::create_dir_all(target.join("ppt-master/scripts")).unwrap();
        std::fs::write(target.join("ppt-master/scripts/leftover.py"), "x").unwrap();

        let status = reconcile_builtin_shadowing(&src, &target, &config);
        assert!(status.changed);
        assert!(target.join("ppt-master/SKILL.md").is_file(), "partial tree must be re-restored");
        assert!(target.join("ppt-master/scripts/tool.py").is_file());
        assert!(!target.join("ppt-master/scripts/leftover.py").exists(), "partial content replaced wholesale");

        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn collect_user_skills_skips_builtin_dotdirs_and_roots() {
        let (config, _src, target) = shadow_fixture("shadow-collect");
        // builtin/ content must never count as a user skill.
        // Dot-dir (staging leftover) must be skipped.
        let stg = config.join("skills").join(".builtin.staging").join("ppt-master");
        std::fs::create_dir_all(&stg).unwrap();
        std::fs::write(stg.join("SKILL.md"), "---\nname: ppt-master\ndescription: x\n---\n").unwrap();
        // A stray SKILL.md at the skills ROOT must not be reported (deleting a
        // "skill" that is the root itself would nuke every user skill).
        std::fs::write(config.join("skills").join("SKILL.md"), "---\nname: root\ndescription: x\n---\n").unwrap();
        // Legit skills under both roots, one nested.
        let a = config.join("skill").join("alpha");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("SKILL.md"), "---\nname: alpha\ndescription: x\n---\n").unwrap();
        let b = config.join("skills").join("group").join("beta");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("SKILL.md"), "---\nname: beta\ndescription: x\n---\n").unwrap();
        // A lowercase `skill.md` is not what opencode's case-sensitive glob
        // matches — must not be reported even on case-insensitive filesystems.
        let c = config.join("skills").join("lowercase");
        std::fs::create_dir_all(&c).unwrap();
        std::fs::write(c.join("skill.md"), "---\nname: lower\ndescription: x\n---\n").unwrap();

        let found = collect_user_skills(&config, &target, 6);
        let names: Vec<&str> = found.iter().map(|u| u.name.as_str()).collect();
        assert!(names.contains(&"alpha"));
        assert!(names.contains(&"beta"));
        assert!(!names.contains(&"root"), "root SKILL.md must not be reported");
        assert!(!names.contains(&"lower"), "lowercase skill.md must not be reported");
        assert!(
            !names.contains(&"ppt-master") && !names.contains(&"doc-edit"),
            "builtin/ and dot-dir content leaked into user skills: {:?}",
            names
        );

        let _ = std::fs::remove_dir_all(&config);
    }

    #[cfg(unix)]
    #[test]
    fn collect_user_skills_follows_symlinked_installs() {
        let (config, _src, target) = shadow_fixture("shadow-link");
        // Skill-dev workflow: skills/ppt-master -> ~/dev/my-ppt (opencode's
        // glob follows symlinks, so shadowing must see it too).
        let real = config.join("elsewhere").join("my-ppt");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("SKILL.md"), "---\nname: ppt-master\ndescription: dev\n---\n").unwrap();
        std::os::unix::fs::symlink(&real, config.join("skills").join("ppt-master")).unwrap();

        let found = collect_user_skills(&config, &target, 6);
        assert!(
            found.iter().any(|u| u.name == "ppt-master"),
            "symlinked install must be collected"
        );

        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn check_skill_dependencies_includes_python_probes() {
        // The command must always report the two python probe entries (frontend
        // BUILTIN_DEP_MAP requires them for ppt-master) — regardless of host state.
        let deps = check_skill_dependencies();
        for name in ["python3", "python3.10+", "python-pptx"] {
            assert!(
                deps.iter().any(|d| d.name == name),
                "missing dep entry: {}",
                name
            );
        }
    }

    #[test]
    fn feature_probe_code_runs_on_any_real_python() {
        // The probe snippet must be valid syntax even on old interpreters (it
        // GATES 3.10+, so it has to run on 3.9 and just print 0). Tolerant of
        // hosts without python (fake-interpreter tests cover parsing).
        let found = probe_bins(&skill_dep_path(), &["python3"]);
        let Some(py) = found.iter().find(|d| d.available).and_then(|d| d.path.clone()) else {
            return;
        };
        if !python_probe_allowed(&py) {
            return; // macOS CLT shim without CLT — executing it would pop a dialog
        }
        let Some((ver, _pptx)) = run_python_feature_probe(&py, Duration::from_secs(10)) else {
            return; // interpreter present but not runnable (stub) — probe correctly rejected it
        };
        let Ok(out) = Command::new(&py)
            .args(["-c", "import sys; print(sys.version_info >= (3, 10))"])
            .output()
        else {
            return;
        };
        let expect = String::from_utf8_lossy(&out.stdout).trim() == "True";
        assert_eq!(ver, expect);
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    #[cfg(unix)] // process_ppid uses `ps` and is intentionally None on Windows
    fn process_ppid_resolves_self_and_misses_dead_pid() {
        // The current test process always has a live parent.
        let ppid = process_ppid(std::process::id());
        assert!(ppid.is_some(), "current process must have a parent pid");

        // A PID that cannot exist (max u32) has no ppid.
        assert_eq!(process_ppid(u32::MAX), None);
    }

    #[test]
    fn free_port_has_no_orphaned_listener() {
        // Nothing listens on this port in the test environment, so there is no
        // orphan to report. (We pick a high, unlikely-bound port.)
        assert!(!port_listener_orphaned(59_237));
    }
}

#[cfg(test)]
mod provider_test_tests {
    use super::*;

    #[test]
    fn openai_url_appends_models() {
        assert_eq!(
            build_provider_test_url("https://api.example.com/v1", "openai"),
            "https://api.example.com/v1/models"
        );
        // Trailing slash is trimmed (no double slash).
        assert_eq!(
            build_provider_test_url("https://api.example.com/v1/", "openai"),
            "https://api.example.com/v1/models"
        );
    }

    #[test]
    fn anthropic_url_inserts_v1_when_missing() {
        assert_eq!(
            build_provider_test_url("https://api.anthropic.com", "anthropic"),
            "https://api.anthropic.com/v1/models"
        );
        // …but does not double it when already present.
        assert_eq!(
            build_provider_test_url("https://gw.example.com/v1", "anthropic"),
            "https://gw.example.com/v1/models"
        );
    }

    #[test]
    fn status_classification() {
        assert_eq!(classify_provider_status(0), "network");
        assert_eq!(classify_provider_status(200), "ok");
        assert_eq!(classify_provider_status(204), "ok");
        assert_eq!(classify_provider_status(401), "auth");
        assert_eq!(classify_provider_status(403), "auth");
        assert_eq!(classify_provider_status(404), "notfound");
        assert_eq!(classify_provider_status(500), "http");
    }

    // ── Office CLI connectors (lark-cli) ────────────────────────────

    #[test]
    fn lark_archive_name_has_pinned_checksum() {
        // Whatever platform this test runs on, the derived archive name must
        // resolve to a pinned digest — otherwise install_office_cli can never
        // succeed on that platform (riscv64 is deliberately unsupported).
        let archive = lark_cli_archive_name().expect("supported platform");
        assert!(
            expected_lark_checksum(&archive).is_some(),
            "no pinned checksum for {}",
            archive
        );
        assert!(archive.starts_with(&format!("lark-cli-{}-", LARK_CLI_VERSION)));
    }

    #[test]
    fn lark_download_urls_pin_version_and_order() {
        let urls = lark_cli_download_urls("lark-cli-1.0.65-darwin-arm64.tar.gz");
        assert_eq!(urls.len(), 2);
        assert!(urls[0].starts_with("https://github.com/larksuite/cli/releases/download/v1.0.65/"));
        assert!(urls[1].starts_with("https://registry.npmmirror.com/-/binary/lark-cli/v1.0.65/"));
    }

    #[test]
    fn lark_config_url_extraction() {
        // Real output line (2026-07-06 live run): bare URL on its own line.
        assert_eq!(
            find_lark_config_url("  https://open.feishu.cn/page/cli?user_code=PTHH-PBKL&lpv=1.0.65&ocv=1.0.65&from=cli"),
            Some("https://open.feishu.cn/page/cli?user_code=PTHH-PBKL&lpv=1.0.65&ocv=1.0.65&from=cli".to_string())
        );
        // Prose around the URL must not leak into the token.
        assert_eq!(
            find_lark_config_url("open https://x.cn/cli?user_code=AB-CD now"),
            Some("https://x.cn/cli?user_code=AB-CD".to_string())
        );
        // URLs without the pairing parameter are not the setup URL.
        assert_eq!(find_lark_config_url("see https://open.feishu.cn/document"), None);
        // QR-code noise and plain text yield nothing.
        assert_eq!(find_lark_config_url("████ ▄▄▄▄▄ ████"), None);
        assert_eq!(find_lark_config_url("等待配置应用..."), None);
    }

    #[test]
    fn lark_auth_status_classification() {
        // Real not-configured output (2026-07-06 live run, stderr, exit 3).
        let (state, _) = classify_lark_auth_status(
            r#"{"ok":false,"error":{"type":"config","subtype":"not_configured","message":"not configured","hint":"run config init"}}"#,
        );
        assert_eq!(state, CliConnectorState::NotConfigured);

        let (state, _) = classify_lark_auth_status(
            r#"{"ok":false,"error":{"type":"auth","subtype":"user_unauthorized","message":"not logged in"}}"#,
        );
        assert_eq!(state, CliConnectorState::NotAuthorized);

        // Real configured-but-not-logged-in status document (2026-07-06 live
        // run, stdout, exit 0 — note: NO `ok` field at all).
        let (state, _) = classify_lark_auth_status(
            r#"{"appId":"cli_aac1ebcc423adbc6","brand":"feishu","defaultAs":"auto","identities":{"bot":{"status":"ready","available":true,"message":"Bot identity: ready"},"user":{"status":"missing","available":false,"message":"User identity: missing (no user logged in)","hint":"run: lark-cli auth login --help"}},"identity":"bot","note":"User identity is missing"}"#,
        );
        assert_eq!(state, CliConnectorState::NotAuthorized);

        // Authorized status document (user identity available).
        let (state, name) = classify_lark_auth_status(
            r#"{"appId":"cli_x","brand":"feishu","identities":{"bot":{"status":"ready","available":true},"user":{"status":"ready","available":true,"userName":"张三"}},"identity":"user"}"#,
        );
        assert_eq!(state, CliConnectorState::Connected);
        assert_eq!(name.as_deref(), Some("张三"));

        // Available user but dead token — never paint the card green.
        let (state, _) = classify_lark_auth_status(
            r#"{"identities":{"user":{"status":"ready","available":true,"tokenStatus":"expired"}}}"#,
        );
        assert_eq!(state, CliConnectorState::NotAuthorized);

        // Bare ok:true (lark-shared doc shape, no identities).
        let (state, _) = classify_lark_auth_status(r#"{"ok":true}"#);
        assert_eq!(state, CliConnectorState::Connected);

        let (state, detail) = classify_lark_auth_status("segfault: not json");
        assert_eq!(state, CliConnectorState::Error);
        assert!(detail.unwrap().contains("segfault"));

        let (state, detail) = classify_lark_auth_status(
            r#"{"ok":false,"error":{"type":"network","message":"dial timeout"}}"#,
        );
        assert_eq!(state, CliConnectorState::Error);
        assert_eq!(detail.as_deref(), Some("dial timeout"));

        // Unrecognized-but-valid JSON is an explicit error with a detail (an
        // empty detail would suppress the UI banner — real-device lesson).
        let (state, detail) = classify_lark_auth_status(r#"{"something":"else"}"#);
        assert_eq!(state, CliConnectorState::Error);
        assert!(detail.is_some());

        // Every Error verdict must carry a NON-EMPTY detail ("" is falsy in
        // JS and hides the banner): null error object, message-less error,
        // and fully empty output all get a generic explanation.
        for raw in [r#"{"ok":false,"error":null}"#, r#"{"ok":false,"error":{"type":"weird"}}"#, ""] {
            let (state, detail) = classify_lark_auth_status(raw);
            assert_eq!(state, CliConnectorState::Error, "raw={raw}");
            assert!(
                detail.as_deref().is_some_and(|d| !d.trim().is_empty()),
                "empty detail for raw={raw}"
            );
        }
    }

    #[test]
    #[cfg(unix)] // ExitStatus::from_raw is unix-only; the fn under test is pure
    fn lark_json_output_prefers_stdout_falls_back_to_stderr() {
        use std::os::unix::process::ExitStatusExt as _;
        let mk = |stdout: &str, stderr: &str| std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        };
        // Success JSON on stdout wins even when stderr has noise.
        assert_eq!(lark_json_output(&mk(r#"{"ok":true}"#, "notice")), r#"{"ok":true}"#);
        // Typed error JSON on stderr (real-device finding: not_configured
        // arrives there with empty stdout) is picked up.
        assert_eq!(
            lark_json_output(&mk("  \n", r#"{"ok":false}"#)),
            r#"{"ok":false}"#
        );
        assert_eq!(lark_json_output(&mk("", "")), "");
    }

    #[test]
    fn complete_auth_classification() {
        // exit 0 → success regardless of output.
        assert!(classify_complete_auth(true, "", "").is_ok());
        // Real partial-grant payload (2026-07-06 live run): nonzero exit +
        // authorization_complete on stderr with granted/missing lists — this
        // IS success (the status probe decides the final state).
        assert!(classify_complete_auth(
            false,
            "",
            r#"{"already_granted":[],"event":"authorization_complete","granted":["im:message:recall","contact:user.basic_profile:readonly","auth:user.id:read","offline_access"],"missing":["approval:approval:read","attendance:attendance:read"]}"#,
        )
        .is_ok());
        // Same event on stdout also counts.
        assert!(classify_complete_auth(false, r#"{"event":"authorization_complete","granted":[]}"#, "").is_ok());
        // Typed error surfaces its message.
        let err = classify_complete_auth(
            false,
            "",
            r#"{"ok":false,"error":{"type":"auth","subtype":"expired","message":"device code expired"}}"#,
        )
        .unwrap_err();
        assert_eq!(err, "device code expired");
        // Garbage output → raw tail, capped.
        let err = classify_complete_auth(false, "boom not json", "").unwrap_err();
        assert!(err.contains("boom"));
    }

    #[test]
    fn lark_version_parse() {
        assert_eq!(parse_lark_cli_version("lark-cli version 1.0.65\n"), Some("1.0.65".to_string()));
        assert_eq!(parse_lark_cli_version(""), None);
        assert_eq!(parse_lark_cli_version("command not found"), None);
    }

    #[test]
    fn lark_device_login_parse() {
        // Real shape (2026-07-06 live run, v1.0.65): verification_url with the
        // user_code embedded; no separate user_code/interval fields.
        let login = parse_lark_device_login(
            r#"{"device_code":"O_sB.xyz","expires_in":600,"hint":"**MUST generate QR code**","verification_url":"https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=F1&user_code=UEJ9-TT8C"}"#,
        )
        .expect("parses real shape");
        assert_eq!(login.device_code, "O_sB.xyz");
        assert_eq!(
            login.verification_uri.as_deref(),
            Some("https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=F1&user_code=UEJ9-TT8C")
        );
        assert_eq!(login.expires_in, Some(600));

        // Doc-derived spelling still accepted as fallback.
        let login = parse_lark_device_login(
            r#"{"ok":true,"device_code":"dc123","user_code":"AB-CD","verification_uri":"https://v","verification_uri_complete":"https://v?u=AB-CD","expires_in":300,"interval":5}"#,
        )
        .expect("parses");
        assert_eq!(login.device_code, "dc123");
        assert_eq!(login.verification_uri.as_deref(), Some("https://v"));
        assert_eq!(login.verification_uri_complete.as_deref(), Some("https://v?u=AB-CD"));
        assert_eq!(login.expires_in, Some(300));

        // Typed error surfaces its message.
        let err = parse_lark_device_login(
            r#"{"ok":false,"error":{"type":"config","subtype":"not_configured","message":"not configured"}}"#,
        )
        .unwrap_err();
        assert!(err.contains("not configured"));

        // Missing device_code is an error, not a panic.
        assert!(parse_lark_device_login(r#"{"ok":true}"#).is_err());
        assert!(parse_lark_device_login("garbage").is_err());
    }

    #[test]
    fn sha256_file_matches_known_digest() {
        let dir = std::env::temp_dir().join(format!("uw-sha-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("abc.txt");
        std::fs::write(&f, "abc").unwrap();
        assert_eq!(
            sha256_file(&f).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn office_cli_bin_dir_leads_rich_path() {
        // The managed install dir must be the FIRST PATH segment sidecars and
        // probes inherit: it only holds pinned checksum-verified CLIs and has
        // to beat any stale user install (brew / npm -g) so the agent's bash
        // resolves the same binary the connector card manages.
        let path = compute_rich_path();
        let dir = office_cli_bin_dir().to_string_lossy().to_string();
        assert_eq!(
            path.split(PATH_LIST_SEP).next(),
            Some(dir.as_str()),
            "office-cli bin dir must lead the rich PATH"
        );
    }

    #[test]
    fn probe_lark_status_never_panics() {
        // Whatever the host state (installed or not), probing must return a
        // stable id and some state — the settings card renders directly off it.
        let status = probe_lark_status();
        assert_eq!(status.id, "lark");
    }
}
