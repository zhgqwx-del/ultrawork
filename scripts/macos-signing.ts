import path from "node:path"

/** Tauri must sign the app before it copies that app into a disk image. */
export function macosSigningEnvironment(env: NodeJS.ProcessEnv, unsigned: boolean): Record<string, string> {
  const result = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  if (unsigned) {
    // Tauri's explicit ad-hoc identity signs bundled resources before DMG creation.
    // Removing this variable and signing only the external .app afterwards would
    // leave an invalid signature on the copy already sealed inside the DMG.
    result.APPLE_SIGNING_IDENTITY = "-"
    // Tauri notarizes automatically when these credentials are present. An
    // explicitly ad-hoc build must not inherit that certificate/notary flow.
    for (const key of [
      "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY",
      "APPLE_API_ISSUER", "APPLE_API_KEY_PATH", "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
    ]) delete result[key]
  } else if (!result.APPLE_SIGNING_IDENTITY || result.APPLE_SIGNING_IDENTITY === "-") {
    throw new Error("A certificate signing identity is required; use --unsigned for an ad-hoc build")
  }
  return result
}

/** A copyable macOS command, with the complete effective bundle name safely quoted. */
export function quarantineRemovalCommand(productName: string): string {
  const application = path.posix.join("/Applications", `${productName}.app`)
  const quoted = `'${application.replaceAll("'", "'\\''")}'`
  return `xattr -dr com.apple.quarantine ${quoted}`
}
