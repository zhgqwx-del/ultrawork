//! WebView2 preflight (Windows only).
//!
//! Windows ships no webview with the app: the binary links against the system's
//! Evergreen WebView2 runtime. Our installer plants it (`webviewInstallMode:
//! embedBootstrapper`), but nothing stops a user or a group policy from removing
//! it afterwards — clash-verge-rev#1150 is that bug in the wild.
//!
//! Without the runtime `tauri::Builder::run` aborts while creating the webview,
//! and release builds are `windows_subsystem = "windows"`, so the panic goes to
//! a console nobody has: the app simply never appears. Check before the Builder
//! exists, while there is still a way to reach the user.
//!
//! discussions/030 §2.1 · §9.3-D

/// Kept separate from `ensure_webview_runtime` so tests can ask the question
/// without risking the `exit(1)`.
fn runtime_missing() -> bool {
    // `&&` short-circuits, so `webview_version()` never runs off-Windows. Where it
    // does run it is `GetAvailableCoreWebView2BrowserVersionString`, the detection
    // call Microsoft documents; `Err` means "no runtime at all", not "outdated".
    cfg!(target_os = "windows") && tauri::webview_version().is_err()
}

/// Exits the process if Windows lacks the WebView2 runtime. No-op elsewhere.
///
/// Call before `tauri::Builder`.
pub fn ensure_webview_runtime() {
    if !runtime_missing() {
        return;
    }

    // `rfd` and `explorer.exe` are Windows-only, so this cannot be a runtime
    // `if cfg!(...)` branch the way ADR-037 prefers: a host `cargo check` on
    // macOS never type-checks it. The Windows CI job is the gate (gotchas §12).
    #[cfg(windows)]
    {
        // Microsoft's consumer download page. Their distribution guidance names
        // redirecting users here as the supported fallback for apps that rely on
        // the Evergreen runtime instead of bundling a fixed one.
        const WEBVIEW2_DOWNLOAD_URL: &str =
            "https://developer.microsoft.com/en-us/microsoft-edge/webview2/consumer/";

        // tauri-plugin-dialog pulls rfd with `common-controls-v6` on, and Cargo
        // features union across the tree, so this dialog goes through
        // TaskDialogIndirect (which relies on the Common-Controls v6 assembly in
        // Tauri's default app manifest) rather than a bare MessageBoxW. Custom
        // button labels would need that same feature; YesNo renders correctly on
        // both backends, so use it and sidestep the coupling.
        let go_download = rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title("缺少 Microsoft Edge WebView2 运行时")
            .set_description(concat!(
                "Ultrawork 需要 Microsoft Edge WebView2 运行时才能显示界面，",
                "但当前系统上没有找到它。\n\n",
                "安装完成后重新启动 Ultrawork 即可，无需重启电脑。\n\n",
                "现在前往下载页？",
            ))
            .set_buttons(rfd::MessageButtons::YesNo)
            .show()
            == rfd::MessageDialogResult::Yes;

        if go_download {
            // Not `cmd /C start`: release builds carry no console, so spawning one
            // flashes a black window. explorer.exe is already a GUI process.
            let _ = std::process::Command::new("explorer")
                .arg(WEBVIEW2_DOWNLOAD_URL)
                .spawn();
        }
    }

    std::process::exit(1);
}

#[cfg(test)]
mod webview_runtime_tests {
    // Windows is deliberately untested here: a runner without WebView2 would take
    // `exit(1)` and kill the test binary. That branch is covered by the real-machine
    // checklist in discussions/030 §12-6.
    #[cfg(not(windows))]
    #[test]
    fn no_op_where_the_webview_ships_with_the_os() {
        assert!(!super::runtime_missing());
        super::ensure_webview_runtime();
    }
}
