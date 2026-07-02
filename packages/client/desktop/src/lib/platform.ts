/** Platform detection — synchronous, zero-dependency, works in Tauri WebView. */
export const isMacOS = navigator.platform.startsWith("Mac")
export const isWindows = navigator.platform.startsWith("Win")
