//! Build-time application identity and the host-owned runtime namespace.
//!
//! Paths are derived without creating files. Only `initialize` acquires the OS
//! lease and publishes a context; a blocked window must not mutate business data.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub schema_version: u8,
    pub brand_id: String,
    pub product_name: String,
    pub identifier: String,
    pub namespace: String,
    pub is_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_binary_name: Option<String>,
}

pub fn identity() -> &'static Identity {
    static IDENTITY: OnceLock<Identity> = OnceLock::new();
    IDENTITY.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/brand.json")))
            .expect("build.rs validated the application brand")
    })
}

pub fn product_name() -> &'static str {
    &identity().product_name
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    pub app_root: PathBuf,
    pub config_root: PathBuf,
    pub data_root: PathBuf,
    pub cache_root: PathBuf,
    pub state_root: PathBuf,
    pub skills_root: PathBuf,
    pub ports_registry_path: PathBuf,
}

impl Paths {
    pub fn resolve(
        identity: &Identity,
        home: &Path,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        if !home.is_absolute() {
            return Err("The user home directory must be absolute".into());
        }
        let xdg = |name: &str, fallback: PathBuf| -> Result<PathBuf, String> {
            match env(name).filter(|s| !s.is_empty()) {
                Some(value) => {
                    let root = PathBuf::from(value);
                    if !root.is_absolute() {
                        return Err(format!("{name} must be an absolute directory; no data was migrated"));
                    }
                    Ok(root)
                }
                None => Ok(fallback),
            }
        };
        let app_root = home.join(format!(".{}", identity.namespace));
        let config_root = xdg("XDG_CONFIG_HOME", home.join(".config"))?.join(&identity.namespace);
        let data_root = xdg("XDG_DATA_HOME", home.join(".local").join("share"))?.join(&identity.namespace);
        let cache_root = xdg("XDG_CACHE_HOME", home.join(".cache"))?.join(&identity.namespace);
        let state_root = xdg("XDG_STATE_HOME", home.join(".local").join("state"))?.join(&identity.namespace);
        Ok(Self {
            skills_root: config_root.join("skills"),
            ports_registry_path: app_root.join("run").join("ports.json"),
            app_root,
            config_root,
            data_root,
            cache_root,
            state_root,
        })
    }
}

pub fn resolve_paths() -> Result<Paths, String> {
    let home = dirs::home_dir().ok_or("Could not resolve the user home directory")?;
    Paths::resolve(identity(), &home, |key| std::env::var(key).ok())
}

pub fn paths() -> Paths {
    if let Some(state) = RUNTIME.get() {
        return state.context.paths();
    }
    // Pure path callers (including dependency probes and tests) do not acquire a
    // lease. Invalid environments are rejected by the startup preflight first.
    resolve_paths().expect("application paths require a successful startup preflight")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContext {
    pub schema_version: u8,
    pub identity: Identity,
    pub instance_id: String,
    pub actual_identifier: String,
    pub owner_pid: u32,
    #[serde(flatten)]
    pub roots: Paths,
}

impl RuntimeContext {
    pub fn paths(&self) -> Paths {
        self.roots.clone()
    }
}

struct RuntimeState {
    context: RuntimeContext,
    // Dropping the handle releases the OS lock, including on process death.
    _lease: DataLease,
}

static RUNTIME: OnceLock<RuntimeState> = OnceLock::new();
static INITIALIZE_LOCK: Mutex<()> = Mutex::new(());

pub fn context() -> Option<&'static RuntimeContext> {
    RUNTIME.get().map(|state| &state.context)
}

pub fn owns_data() -> bool {
    context().is_some()
}

pub fn context_file() -> Option<PathBuf> {
    context().map(|ctx| ctx.roots.app_root.join("run").join("brand-context.json"))
}

pub fn runtime_env() -> Result<Vec<(String, String)>, String> {
    let ctx = context().ok_or("Application startup has not acquired its data lease")?;
    Ok(vec![
        ("ULTRAWORK_BRAND_CONTEXT".into(), serde_json::to_string(ctx).map_err(|e| e.to_string())?),
        ("ULTRAWORK_BRAND_CONTEXT_FILE".into(), context_file().unwrap().to_string_lossy().into_owned()),
        ("OPENCODE_APP_NAME".into(), ctx.identity.namespace.clone()),
        ("ULTRAWORK_SKILLS_DIR".into(), ctx.roots.skills_root.to_string_lossy().into_owned()),
    ])
}

pub fn managed_args() -> Result<Vec<String>, String> {
    let path = context_file().ok_or("Managed sidecar has no application context")?;
    Ok(vec!["--brand-context".into(), path.to_string_lossy().into_owned()])
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredIdentity {
    schema_version: u8,
    brand_id: String,
    identifier: String,
}

fn identity_matches(stored: &StoredIdentity, identity: &Identity) -> bool {
    stored.schema_version == 1
        && stored.brand_id == identity.brand_id
        && stored.identifier == identity.identifier
}

pub struct DataLease(File);

impl Drop for DataLease {
    fn drop(&mut self) {
        // Explicit unlock also releases a transient fork-inherited descriptor;
        // close-on-exec alone can otherwise delay release during concurrent spawn.
        let _ = self.0.unlock();
    }
}

pub fn acquire_lease(root: &Path) -> Result<DataLease, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("Cannot create {}: {e}", root.display()))?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(root.join(".brand.lock"))
        .map_err(|e| format!("Cannot open application data lease: {e}"))?;
    file.try_lock().map_err(|e| format!(
        "Another process is using {} or its data lock is unavailable ({e}). Close that application and retry.",
        root.display()
    ))?;
    Ok(DataLease(file))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid private-file path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| format!("Cannot publish {}: {e}", path.display()))
}

fn check_identity_root(root: &Path, identity: &Identity) -> Result<(), String> {
    let marker = root.join(".brand-identity.json");
    if marker.exists() {
        let stored: StoredIdentity = serde_json::from_slice(&std::fs::read(&marker).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Invalid identity record at {}: {e}", marker.display()))?;
        if !identity_matches(&stored, identity) {
            return Err(format!("The identity record in {} belongs to another application. No data was changed.", root.display()));
        }
    } else if !identity.is_default && root.exists() {
        let unknown = std::fs::read_dir(root).map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .any(|entry| entry.file_name() != ".brand.lock");
        if unknown {
            return Err(format!(
                "{} contains data but has no trusted brand identity. Back it up and move it aside before first launch; do not delete an identity record to force adoption.",
                root.display()
            ));
        }
    }
    Ok(())
}

fn check_default_aliases(paths: &Paths, identity: &Identity) -> Result<(), String> {
    if identity.is_default {
        return Ok(());
    }
    let mut default = identity.clone();
    default.namespace = "ultrawork".into();
    let home = dirs::home_dir().ok_or("Could not resolve home directory")?;
    let defaults = Paths::resolve(&default, &home, |key| std::env::var(key).ok())?;
    for (own, other) in [
        (&paths.app_root, &defaults.app_root),
        (&paths.config_root, &defaults.config_root),
        (&paths.data_root, &defaults.data_root),
        (&paths.cache_root, &defaults.cache_root),
        (&paths.state_root, &defaults.state_root),
    ] {
        if let (Ok(a), Ok(b)) = (own.canonicalize(), other.canonicalize()) {
            if a == b {
                return Err(format!("{} resolves to another brand's directory. No data was changed.", own.display()));
            }
        }
    }
    Ok(())
}

fn root_identity(identity: &Identity) -> StoredIdentity {
    StoredIdentity { schema_version: 1, brand_id: identity.brand_id.clone(), identifier: identity.identifier.clone() }
}

fn trusted_cleared_cache(paths: &Paths, identity: &Identity) -> bool {
    if paths.cache_root.join(".brand-identity.json").exists() { return false; }
    let Ok(bytes) = std::fs::read(paths.app_root.join(".brand-roots.json")) else { return false };
    let Ok(known) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return false };
    let Ok(actual) = paths.cache_root.canonicalize() else { return false };
    known.get("brandId").and_then(|v| v.as_str()) == Some(identity.brand_id.as_str())
        && known.get("cacheRoot").and_then(|v| v.as_str()).is_some_and(|path| Path::new(path) == actual)
}

/// OpenCode clears its whole cache on a cache-version bump. Its content marker
/// can therefore disappear; ownership is also recorded outside that cache.
pub fn restore_cache_identity() -> Result<(), String> {
    let ctx = context().ok_or("Application has not acquired its namespace")?;
    write_private(&ctx.roots.cache_root.join(".brand-identity.json"),
        &serde_json::to_vec_pretty(&root_identity(&ctx.identity)).map_err(|e| e.to_string())?)
}

/// Perform all read-only validation before obtaining the lease, then publish the
/// context before any sidecar, credential, skills installer, or DB is started.
pub fn initialize(actual_identifier: &str) -> Result<&'static RuntimeContext, String> {
    let _guard = INITIALIZE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ctx) = context() {
        return Ok(ctx);
    }
    let brand = identity();
    if actual_identifier != brand.identifier && actual_identifier != format!("{}.dev", brand.identifier) {
        return Err("Compiled brand and Tauri application identifier do not match".into());
    }
    let paths = resolve_paths()?;
    if brand.is_default && std::env::var("XDG_DATA_HOME").ok().as_deref() == Some("") {
        return Err("XDG_DATA_HOME is empty. Older services resolved that value differently; set an explicit absolute data root or unset it before restarting. No data was moved.".into());
    }
    check_default_aliases(&paths, brand)?;
    for root in [&paths.app_root, &paths.config_root, &paths.data_root, &paths.state_root] {
        check_identity_root(root, brand)?;
    }
    if let Err(error) = check_identity_root(&paths.cache_root, brand) {
        if !trusted_cleared_cache(&paths, brand) { return Err(error); }
    }
    let lease = acquire_lease(&paths.app_root)?;
    // The lease file itself is initialization metadata, not unknown user data.
    check_identity_root(&paths.app_root, brand)?;
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|e| e.to_string())?;
    let instance_id = random.iter().map(|b| format!("{b:02x}")).collect();
    let ctx = RuntimeContext {
        schema_version: 1,
        identity: brand.clone(),
        instance_id,
        actual_identifier: actual_identifier.into(),
        owner_pid: std::process::id(),
        roots: paths,
    };
    let stored = root_identity(brand);
    for root in [&ctx.roots.app_root, &ctx.roots.config_root, &ctx.roots.data_root, &ctx.roots.cache_root, &ctx.roots.state_root] {
        write_private(&root.join(".brand-identity.json"), &serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?)?;
    }
    let stable_roots = serde_json::json!({
        "brandId": brand.brand_id,
        "cacheRoot": ctx.roots.cache_root.canonicalize().map_err(|e| e.to_string())?,
    });
    write_private(&ctx.roots.app_root.join(".brand-roots.json"), &serde_json::to_vec_pretty(&stable_roots).map_err(|e| e.to_string())?)?;
    let context_path = ctx.roots.app_root.join("run").join("brand-context.json");
    write_private(&context_path, &serde_json::to_vec_pretty(&ctx).map_err(|e| e.to_string())?)?;
    RUNTIME.set(RuntimeState { context: ctx, _lease: lease }).map_err(|_| "Application runtime already initialized")?;
    Ok(context().unwrap())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub executable: PathBuf,
    pub started_at: String,
    pub parent_pid: Option<u32>,
}

/// Windows PowerShell 5.1 otherwise writes redirected output using its OEM code
/// page. JSON containing a Unicode customer path must reach serde as UTF-8.
pub fn powershell_utf8(script: &str) -> String {
    format!("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); {script}")
}

/// A missing identity probe is not evidence of process death. None means that
/// the platform probe itself could not establish presence and callers must wait.
pub fn process_present(pid: u32) -> Option<bool> {
    if cfg!(target_os = "linux") {
        return match std::fs::metadata(PathBuf::from("/proc").join(pid.to_string())) {
            Ok(_) => Some(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(false),
            Err(_) => None,
        };
    }
    if cfg!(target_os = "windows") {
        let script = powershell_utf8(&format!("[bool](Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' -ErrorAction Stop)"));
        let output = crate::sys_cmd("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().ok()?;
        if !output.status.success() { return None; }
        return match String::from_utf8(output.stdout).ok()?.trim() { "True" => Some(true), "False" => Some(false), _ => None };
    }
    let output = crate::sys_cmd("ps").args(["-p", &pid.to_string(), "-o", "pid="]).output().ok()?;
    if output.status.success() { return Some(String::from_utf8(output.stdout).ok()?.trim().parse::<u32>().ok() == Some(pid)); }
    (output.status.code() == Some(1)).then_some(false)
}

/// OS identity, not a basename guess. If a platform cannot establish it, callers
/// leave the process alone. Commands use the shared hidden-console constructor.
pub fn process_identity(pid: u32) -> Option<ProcessIdentity> {
    if cfg!(target_os = "linux") {
        let root = PathBuf::from("/proc").join(pid.to_string());
        let executable = std::fs::read_link(root.join("exe")).ok()?;
        let executable = PathBuf::from(executable.to_string_lossy().trim_end_matches(" (deleted)"));
        let stat = std::fs::read_to_string(root.join("stat")).ok()?;
        let rest = stat.rsplit_once(") ")?.1.split_whitespace().collect::<Vec<_>>();
        Some(ProcessIdentity { pid, executable, started_at: rest.get(19)?.to_string(), parent_pid: rest.get(1)?.parse().ok() })
    } else if cfg!(target_os = "windows") {
        let script = powershell_utf8(&format!("Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' | Select-Object ExecutablePath,CreationDate,ParentProcessId | ConvertTo-Json -Compress"));
        let output = crate::sys_cmd("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().ok()?;
        if !output.status.success() { return None; }
        let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
        Some(ProcessIdentity {
            pid,
            executable: PathBuf::from(json.get("ExecutablePath")?.as_str()?),
            started_at: json.get("CreationDate")?.to_string(),
            parent_pid: json.get("ParentProcessId").and_then(|v| v.as_u64()).map(|v| v as u32),
        })
    } else {
        let query = |field: &str| -> Option<String> {
            let output = crate::sys_cmd("ps").args(["-p", &pid.to_string(), "-o", field]).output().ok()?;
            if !output.status.success() { return None; }
            let text = String::from_utf8(output.stdout).ok()?.trim().to_owned();
            (!text.is_empty()).then_some(text)
        };
        Some(ProcessIdentity {
            pid,
            executable: PathBuf::from(query("comm=")?),
            started_at: query("lstart=")?,
            parent_pid: query("ppid=").and_then(|s| s.parse().ok()),
        })
    }
}

pub fn same_process(expected: &ProcessIdentity) -> bool {
    process_identity(expected.pid).is_some_and(|actual| {
        actual.pid == expected.pid && actual.executable == expected.executable && actual.started_at == expected.started_at
    })
}

pub fn current_processes() -> BTreeMap<u32, Option<u32>> {
    if cfg!(target_os = "linux") {
        return std::fs::read_dir("/proc").into_iter().flatten().filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
            .filter_map(|pid| process_identity(pid).map(|p| (pid, p.parent_pid)))
            .collect();
    }
    if cfg!(target_os = "windows") {
        let script = powershell_utf8("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress");
        let output = crate::sys_cmd("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output();
        let Ok(output) = output else { return BTreeMap::new() };
        let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(&output.stdout) else { return BTreeMap::new() };
        return rows.into_iter().filter_map(|v| Some((v.get("ProcessId")?.as_u64()? as u32, v.get("ParentProcessId").and_then(|x| x.as_u64()).map(|x| x as u32)))).collect();
    }
    let Ok(output) = crate::sys_cmd("ps").args(["-axo", "pid=,ppid="]).output() else { return BTreeMap::new() };
    String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| {
        let mut parts = line.split_whitespace();
        Some((parts.next()?.parse().ok()?, parts.next().and_then(|p| p.parse().ok())))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom() -> Identity {
        Identity { schema_version: 1, brand_id: "mywork".into(), product_name: "MyWork".into(), identifier: "com.ultrawork.mywork".into(), namespace: "mywork".into(), is_default: false, main_binary_name: Some("mywork".into()) }
    }

    fn temp(label: &str) -> PathBuf {
        let mut bytes = [0u8; 8];
        getrandom::getrandom(&mut bytes).unwrap();
        std::env::temp_dir().join(format!("brand-test-{label}-{}-{}", std::process::id(), bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()))
    }

    #[test]
    fn paths_are_namespace_scoped_and_xdg_empty_matches_unset() {
        let home = temp("home");
        let a = Paths::resolve(&custom(), &home, |_| None).unwrap();
        let b = Paths::resolve(&custom(), &home, |_| Some(String::new())).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.app_root, home.join(".mywork"));
        assert_eq!(a.config_root, home.join(".config").join("mywork"));
        assert_eq!(a.ports_registry_path, home.join(".mywork").join("run").join("ports.json"));
        assert!(Paths::resolve(&custom(), &home, |_| Some("relative".into())).is_err());
        assert!(!home.exists());
    }

    #[test]
    fn default_paths_preserve_the_original_namespace() {
        let home = temp("default");
        let mut default = custom();
        default.namespace = "ultrawork".into();
        let paths = Paths::resolve(&default, &home, |_| None).unwrap();
        assert_eq!(paths.app_root, home.join(".ultrawork"));
        assert_eq!(paths.data_root, home.join(".local").join("share").join("ultrawork"));
    }

    #[test]
    fn unknown_custom_root_is_not_adopted_or_modified() {
        let root = temp("unknown");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("existing.txt"), "keep").unwrap();
        assert!(check_identity_root(&root, &custom()).is_err());
        assert_eq!(std::fs::read_to_string(root.join("existing.txt")).unwrap(), "keep");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_cleared_cache_is_recovered_only_from_its_external_identity() {
        let home = temp("cache-owner");
        let paths = Paths::resolve(&custom(), &home, |_| None).unwrap();
        std::fs::create_dir_all(&paths.app_root).unwrap();
        std::fs::create_dir_all(&paths.cache_root).unwrap();
        std::fs::write(paths.cache_root.join("version"), "21").unwrap();
        assert!(!trusted_cleared_cache(&paths, &custom()));
        let known = serde_json::json!({ "brandId": "mywork", "cacheRoot": paths.cache_root.canonicalize().unwrap() });
        std::fs::write(paths.app_root.join(".brand-roots.json"), serde_json::to_vec(&known).unwrap()).unwrap();
        assert!(trusted_cleared_cache(&paths, &custom()));
        std::fs::write(paths.cache_root.join(".brand-identity.json"), b"another identity").unwrap();
        assert!(!trusted_cleared_cache(&paths, &custom()), "never override an existing cache marker");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn development_and_production_share_a_stable_identity_record() {
        let brand = custom();
        let stored = StoredIdentity { schema_version: 1, brand_id: brand.brand_id.clone(), identifier: brand.identifier.clone() };
        assert!(identity_matches(&stored, &brand));
        let bad = StoredIdentity { schema_version: 1, brand_id: brand.brand_id.clone(), identifier: format!("{}.dev", brand.identifier) };
        assert!(!identity_matches(&bad, &brand));
    }

    #[test]
    fn file_lease_blocks_a_second_handle_and_releases_on_drop() {
        let root = temp("lease");
        let lease = acquire_lease(&root).unwrap();
        assert!(acquire_lease(&root).is_err());
        drop(lease);
        let again = acquire_lease(&root).unwrap();
        drop(again);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn os_process_identity_is_stable_and_detects_reused_identity() {
        let Some(current) = process_identity(std::process::id()) else {
            panic!("current process identity probe must work on the test platform");
        };
        assert!(same_process(&current));
        let mut changed = current;
        changed.started_at.push_str("-not-the-same-process");
        assert!(!same_process(&changed));
    }

    #[test]
    fn process_presence_distinguishes_this_process_from_an_absent_pid() {
        assert_eq!(process_present(std::process::id()), Some(true));
        assert_eq!(process_present(u32::MAX - 1), Some(false));
    }

    #[test]
    fn macos_ps_locale_child_probe() {
        if !cfg!(target_os = "macos") { return; }
        let Ok(root) = std::env::var("ULTRAWORK_PS_LOCALE_PROBE_ROOT") else { return };
        assert_eq!(std::env::var("LC_ALL").unwrap(), "C");
        let executable = PathBuf::from(root).join("客户 空格").join("sleep");
        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
        }
        let child = OwnedChild(crate::sys_cmd(&executable).arg("30").env("LC_ALL", "C").env("LANG", "C").spawn().unwrap());
        let actual = process_identity(child.0.id()).expect("macOS Unicode process identity must be queryable");
        assert_eq!(actual.executable, executable, "GUI/C locale must not turn UTF-8 paths into BSD ps M- escapes");
        assert!(same_process(&actual));
        assert!(same_process(&actual), "repeated identity queries must be locale-stable");
        let command = crate::process_command_lines().into_iter().find(|(pid, _)| *pid == child.0.id()).expect("command-line probe must find the child").1;
        assert!(command.contains(executable.to_str().unwrap()), "command-line queries must preserve Unicode too: {command}");
    }

    #[test]
    fn macos_unicode_process_identity_survives_a_gui_style_c_locale() {
        if !cfg!(target_os = "macos") { return; }
        let root = temp("ps-locale");
        std::fs::create_dir_all(root.join("客户 空格")).unwrap();
        let root = root.canonicalize().unwrap();
        std::fs::copy("/bin/sleep", root.join("客户 空格").join("sleep")).unwrap();
        let output = crate::sys_cmd(std::env::current_exe().unwrap())
            .args(["--exact", "brand::tests::macos_ps_locale_child_probe", "--nocapture"])
            .env("ULTRAWORK_PS_LOCALE_PROBE_ROOT", &root).env("LC_ALL", "C").env("LANG", "C")
            .output().unwrap();
        let _ = std::fs::remove_dir_all(&root);
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }

    #[test]
    fn windows_json_probe_preserves_unicode_with_a_legacy_console_codepage() {
        if !cfg!(target_os = "windows") { return; }
        let expected = r"C:\Users\客户 é\MyWork\mywork.exe";
        let body = format!("[PSCustomObject]@{{ExecutablePath='{expected}';CreationDate='stable';ParentProcessId=123}} | ConvertTo-Json -Compress");
        let script = format!("[Console]::OutputEncoding=[System.Text.Encoding]::GetEncoding(437); {}", powershell_utf8(&body));
        let output = crate::sys_cmd("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("PowerShell JSON must be UTF-8 even on a legacy code page");
        assert_eq!(value["ExecutablePath"], expected);
    }

    #[test]
    fn lease_child_probe() {
        let Ok(root) = std::env::var("ULTRAWORK_LEASE_PROBE_ROOT") else { return };
        let root = PathBuf::from(root);
        let _lease = acquire_lease(&root).unwrap();
        std::fs::write(root.join("child-ready"), "ready").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn file_lease_is_released_after_a_child_is_killed() {
        let root = temp("death");
        std::fs::create_dir_all(&root).unwrap();
        let mut child = crate::sys_cmd(std::env::current_exe().unwrap())
            .args(["--exact", "brand::tests::lease_child_probe", "--nocapture"])
            .env("ULTRAWORK_LEASE_PROBE_ROOT", &root)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn().unwrap();
        let start = std::time::Instant::now();
        while !root.join("child-ready").exists() && start.elapsed() < std::time::Duration::from_secs(5) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(root.join("child-ready").exists(), "child did not acquire the file lease");
        assert!(acquire_lease(&root).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
        drop(acquire_lease(&root).unwrap());
        let _ = std::fs::remove_dir_all(root);
    }
}
