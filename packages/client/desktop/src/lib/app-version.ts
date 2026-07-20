/**
 * 应用版本号（About 页等 UI 显示用）。
 * 发布 bump 时与 root/desktop package.json、tauri.conf.json、Cargo.toml 五处同步——
 * `scripts/check-docs.ts` 的版本一致性检查会在不同步时报错（CI docs job 拦截）。
 */
export const APP_VERSION = "0.3.2"
