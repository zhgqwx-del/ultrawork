import { DEFAULT_BRAND, type BrandIdentity } from "@agent/brand"

declare const __ULTRAWORK_BRAND__: BrandIdentity | undefined
declare const __ULTRAWORK_BRAND_UI_LOGO__: string | undefined

/** Build-time data only: no filesystem or Node imports in the renderer. */
export const APP_BRAND: BrandIdentity = typeof __ULTRAWORK_BRAND__ === "undefined"
  ? DEFAULT_BRAND
  : __ULTRAWORK_BRAND__ ?? DEFAULT_BRAND
export const APP_LOGO = typeof __ULTRAWORK_BRAND_UI_LOGO__ === "undefined"
  ? ""
  : __ULTRAWORK_BRAND_UI_LOGO__ ?? ""

// Only product copy is branded. Copyright, license names, paths and third-party
// names retain their original meaning and must never pass through a global replace.
const PRODUCT_COPY_KEYS = new Set([
  "connection.sidecarExited", "connection.apiBaseUrl.auto",
  "skills.zone.builtinNote", "skills.shadowedDetail",
  "screenshot.restartAfterGrant", "screenshot.staleGrant",
  "settings.notifySystemHint", "tray.open", "tray.quit", "tray.tooltip",
  "tray.hintTitle", "notify.appName",
])

export function brandTranslation(key: string, value: string, brand: BrandIdentity = APP_BRAND): string {
  if (brand.isDefault) return value
  if (key === "brand.name") return brand.productName
  return PRODUCT_COPY_KEYS.has(key)
    ? value.replace(/Ultrawork|UltraWork|ultrawork/g, () => brand.productName)
    : value
}
