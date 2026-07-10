#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must precede `run()`: without WebView2 the Builder aborts inside webview
    // creation, and a `windows_subsystem = "windows"` binary has no console to
    // print the panic to. See src/webview_runtime.rs.
    ultrawork_lib::ensure_webview_runtime();
    ultrawork_lib::run()
}
