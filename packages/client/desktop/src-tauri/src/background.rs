//! Close-to-background (discussions/061): the window's close button hides the
//! window instead of quitting, so the sidecars — the IM gateway above all — keep
//! running. Quitting is an explicit act: Cmd+Q / the Dock menu on macOS, the tray
//! menu everywhere, or an OS shutdown.
//!
//! Why this is safe against the exit paths that must still work: Cmd+Q goes
//! `terminate:` → tao `applicationWillTerminate` → `LoopDestroyed` → `RunEvent::Exit`,
//! and a Windows shutdown is `WM_ENDSESSION` → `loop_destroyed()`. Neither passes
//! through `CloseRequested`, so intercepting the close button cannot swallow them.
//! Hiding never destroys the window either, so Tauri's "last window destroyed →
//! ExitRequested" chain is simply never entered.
//!
//! Platform notes that shaped the code (all read from the vendored crates):
//! - Linux: the tray library is `dlopen`ed at runtime and a missing
//!   `libayatana-appindicator3` is a **panic**, not an `Err`
//!   (`libappindicator-sys/src/lib.rs`). Tray creation is therefore attempted once,
//!   under `catch_unwind`, and its outcome gates the close decision — without a
//!   tray and without a Dock the user would have no visible way back.
//! - Windows: `window.hide()` only hides the HWND; WebView2 is not told
//!   (`tauri-runtime-wry` sends `WindowMessage::Hide` → `tao.set_visible(false)`,
//!   and wry only calls `SetIsVisible(false)` from `Webview::hide`). A hidden
//!   window would keep compositing off-screen, so the webview is hidden with it.
//! - macOS: tao returns `has_visible_windows` to AppKit from
//!   `applicationShouldHandleReopen`, i.e. **NO** once we are hidden, which tells
//!   AppKit to do nothing — restoring on a Dock click is entirely on us
//!   (`RunEvent::Reopen`, wired in `run()`). A minimized window counts as not
//!   visible too, hence the `unminimize` in `restore_main_window`.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::NotificationExt;

pub const TRAY_ID: &str = "main-tray";
const MENU_OPEN: &str = "tray-open";
const MENU_QUIT: &str = "tray-quit";
const MAIN_WINDOW: &str = "main";

/// Leaving native fullscreen on macOS is animated; hiding the window mid-transition
/// leaves an empty Space behind. Tauri has no "left fullscreen" event, so the hide is
/// deferred past the animation instead.
const FULLSCREEN_EXIT_GRACE: Duration = Duration::from_millis(900);

/// What the close button should do. Decided by [`close_action`], a pure function so
/// the platform matrix is unit-testable without a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Quit,
}

/// `os` is `std::env::consts::OS` at the call site (injected for tests).
///
/// - A failed boot has nothing worth keeping alive, and hiding a broken instance
///   would make the next "reopen" (single-instance) surface the same broken one.
/// - Off macOS there is no Dock: without a tray the hidden app has no visible entry
///   point, so the close button must keep meaning "quit" there.
pub fn close_action(os: &str, tray_ready: bool, boot_failed: bool) -> CloseAction {
    if boot_failed {
        return CloseAction::Quit;
    }
    let has_visible_entry = os == "macos" || tray_ready;
    if has_visible_entry {
        CloseAction::Hide
    } else {
        CloseAction::Quit
    }
}

/// Menu / tooltip / first-hide hint text. Defaults are English; the renderer pushes
/// the UI language's strings via `set_tray_labels` once its i18n is up (and again on
/// every language switch), because the app language lives in the renderer's config,
/// which Rust never reads.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub open: String,
    pub quit: String,
    pub tooltip: String,
    pub hint_title: String,
    pub hint_body: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Open Ultrawork".into(),
            quit: "Quit Ultrawork".into(),
            tooltip: "Ultrawork".into(),
            hint_title: "Ultrawork is still running".into(),
            hint_body: "Closing the window keeps the agent and channels running. Use the tray icon to open or quit.".into(),
        }
    }
}

struct TrayHandles {
    open: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

static TRAY_READY: AtomicBool = AtomicBool::new(false);
/// The "still running" balloon is shown once per process, on the first hide.
static HINT_SHOWN: AtomicBool = AtomicBool::new(false);
static LABELS: Mutex<Option<TrayLabels>> = Mutex::new(None);
static TRAY: Mutex<Option<TrayHandles>> = Mutex::new(None);

fn current_labels() -> TrayLabels {
    LABELS
        .lock()
        .ok()
        .and_then(|l| l.clone())
        .unwrap_or_default()
}

pub fn tray_ready() -> bool {
    TRAY_READY.load(Ordering::SeqCst)
}

/// Create the tray icon. Called once from `setup()` — instantaneous, and both GTK
/// and AppKit want it on the main thread. Never panics out: a missing Linux
/// appindicator library aborts only the tray, and `tray_ready()` stays false so
/// the close button keeps quitting on that machine (see [`close_action`]).
pub fn install_tray(app: &AppHandle) {
    let outcome = catch_unwind(AssertUnwindSafe(|| build_tray(app)));
    match outcome {
        Ok(Ok(())) => {
            TRAY_READY.store(true, Ordering::SeqCst);
        }
        Ok(Err(e)) => {
            eprintln!("[tray] not available ({e}); the close button will quit");
        }
        Err(_) => {
            eprintln!("[tray] creation panicked (missing appindicator library?); the close button will quit");
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let labels = current_labels();
    let open = MenuItem::with_id(app, MENU_OPEN, &labels.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, &labels.quit, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(&labels.tooltip)
        // Menu-bar convention on macOS is "click opens the menu"; on Windows the
        // convention is "left click opens the app, right click the menu". Linux
        // (appindicator) never delivers click events at all — the menu is the way in.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_main_window(tray.app_handle());
            }
        });

    if cfg!(target_os = "macos") {
        // Menu-bar icons are alpha-only "template" images tinted by the system.
        // `tray-template@2x.png` is a grayscale cut of the app icon (placeholder until
        // a designed glyph exists); the colored icon as a template would be a blob.
        let template = Image::from_bytes(include_bytes!("../icons/tray-template@2x.png"))?;
        builder = builder.icon(template).icon_as_template(true);
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    if let Ok(mut slot) = TRAY.lock() {
        *slot = Some(TrayHandles { open, quit });
    }
    Ok(())
}

/// Tray-menu dispatch. Registered through `Builder::on_menu_event` in `run()`; ids
/// that are not ours are ignored so a future window menu can share the hook.
pub fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_OPEN => restore_main_window(app),
        // `exit` raises ExitRequested{code: Some} → Exit → shutdown_sidecars().
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

/// Bring the main window back, from whichever entry point: Dock (`Reopen`), tray,
/// tray menu, or a second launch (single-instance).
pub fn restore_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    if cfg!(target_os = "windows") {
        // Mirror of `hide_now`: WebView2's IsVisible is only touched via the webview.
        let webview: &tauri::Webview<Wry> = window.as_ref();
        let _ = webview.show();
    }
    let _ = window.set_focus();
}

/// The close button. On `Hide` the window has already been hidden here and the
/// caller must `prevent_close`; on `Quit` the caller lets the close proceed.
pub fn on_close_requested(window: &tauri::Window<Wry>) -> CloseAction {
    // Only the main window is kept alive; any other window (none today) closes normally.
    if window.label() != MAIN_WINDOW {
        return CloseAction::Quit;
    }
    let action = close_action(
        std::env::consts::OS,
        tray_ready(),
        super::boot_stage() == super::BOOT_STAGE_FAILED,
    );
    if action == CloseAction::Hide {
        hide_to_background(window);
    }
    action
}

fn hide_to_background(window: &tauri::Window<Wry>) {
    let fullscreen = cfg!(target_os = "macos") && window.is_fullscreen().unwrap_or(false);
    if fullscreen {
        let _ = window.set_fullscreen(false);
        let w = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FULLSCREEN_EXIT_GRACE);
            hide_now(&w);
        });
    } else {
        hide_now(window);
    }
    maybe_show_hint(window.app_handle());
}

fn hide_now(window: &tauri::Window<Wry>) {
    if cfg!(target_os = "windows") {
        for webview in window.webviews() {
            let _ = webview.hide();
        }
    }
    let _ = window.hide();
}

/// One-time "we're still here" balloon. Windows and Linux users read the close
/// button as "quit"; the Dock icon already says otherwise on macOS.
fn maybe_show_hint(app: &AppHandle) {
    if cfg!(target_os = "macos") {
        return;
    }
    if HINT_SHOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    let labels = current_labels();
    let _ = app
        .notification()
        .builder()
        .title(labels.hint_title)
        .body(labels.hint_body)
        .show();
}

/// Renderer → Rust: the UI language's tray strings. Idempotent; safe to call before
/// the tray exists (the stored labels are picked up at build time) and again on
/// every language switch.
#[tauri::command]
pub fn set_tray_labels(app: AppHandle, labels: TrayLabels) {
    if let Ok(mut slot) = LABELS.lock() {
        *slot = Some(labels.clone());
    }
    if let Ok(slot) = TRAY.lock() {
        if let Some(handles) = slot.as_ref() {
            let _ = handles.open.set_text(&labels.open);
            let _ = handles.quit.set_text(&labels.quit);
        }
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        // Unsupported on Linux — the Err is expected there.
        let _ = tray.set_tooltip(Some(&labels.tooltip));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_hides_even_without_a_tray() {
        assert_eq!(close_action("macos", false, false), CloseAction::Hide);
        assert_eq!(close_action("macos", true, false), CloseAction::Hide);
    }

    #[test]
    fn windows_and_linux_hide_only_with_a_tray() {
        for os in ["windows", "linux"] {
            assert_eq!(close_action(os, true, false), CloseAction::Hide, "{os}");
            assert_eq!(close_action(os, false, false), CloseAction::Quit, "{os}");
        }
    }

    #[test]
    fn failed_boot_always_quits() {
        for os in ["macos", "windows", "linux"] {
            assert_eq!(close_action(os, true, true), CloseAction::Quit, "{os}");
        }
    }

    #[test]
    fn labels_deserialize_from_renderer_camel_case() {
        let l: TrayLabels = serde_json::from_str(
            r#"{"open":"打开","quit":"退出","tooltip":"U","hintTitle":"t","hintBody":"b"}"#,
        )
        .unwrap();
        assert_eq!(l.hint_title, "t");
        assert_eq!(l.hint_body, "b");
    }

    #[test]
    fn defaults_are_english_before_the_renderer_speaks() {
        let d = TrayLabels::default();
        assert!(d.open.contains("Open"));
        assert!(d.quit.contains("Quit"));
    }
}
