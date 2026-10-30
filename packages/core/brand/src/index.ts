/** Pure identity contract shared by build tools, renderer and runtime adapters. */
export interface BrandIdentity {
  readonly schemaVersion: 1
  readonly brandId: string
  readonly productName: string
  readonly identifier: string
  readonly namespace: string
  readonly isDefault: boolean
  readonly mainBinaryName?: string
}

export const DEFAULT_BRAND: BrandIdentity = Object.freeze({
  schemaVersion: 1,
  brandId: "ultrawork",
  productName: "Ultrawork",
  identifier: "com.ultrawork.desktop",
  namespace: "ultrawork",
  isDefault: true,
})

const RESERVED = new Set(["ultrawork", "desktop", "opencode", "codex", "claude", "gemini", "qoder", "hermes"])
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function validateBrandId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > 32 ||
      value !== value.trim() || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) || RESERVED.has(value) || DEVICE_NAME.test(value)) {
    throw new Error("brandId must be a unique, non-reserved lowercase ASCII name (2–32 characters)")
  }
}

export function validateProductName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 80 || value !== value.trim() ||
      /[\u0000-\u001f<>:"/\\|?*]/.test(value) || /[. ]$/.test(value) || DEVICE_NAME.test(value)) {
    throw new Error("productName must be a valid application filename (1–80 characters)")
  }
  if (["ultrawork", "ultrawork dev"].includes(value.normalize("NFKC").toLowerCase())) {
    throw new Error("Custom productName conflicts with the default Ultrawork application")
  }
}

export function resolveIdentity(config?: { schemaVersion?: unknown; brandId: unknown; productName: unknown }): BrandIdentity {
  if (!config) return DEFAULT_BRAND
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) throw new Error("Unsupported brand schemaVersion")
  validateBrandId(config.brandId)
  validateProductName(config.productName)
  return Object.freeze({
    schemaVersion: 1,
    brandId: config.brandId,
    productName: config.productName,
    identifier: `com.ultrawork.${config.brandId}`,
    namespace: config.brandId,
    mainBinaryName: config.brandId,
    isDefault: false,
  })
}

/** Validate untrusted JSON without accepting arbitrary identifier/path overrides. */
export function parseBrandIdentity(value: unknown): BrandIdentity {
  if (typeof value !== "object" || value === null) throw new Error("Missing brand identity")
  const item = value as Record<string, unknown>
  const expected = item.brandId === DEFAULT_BRAND.brandId ? DEFAULT_BRAND : resolveIdentity({
    schemaVersion: item.schemaVersion, brandId: item.brandId, productName: item.productName,
  })
  for (const key of ["schemaVersion", "brandId", "productName", "identifier", "namespace", "isDefault", "mainBinaryName"] as const) {
    if (item[key] !== expected[key]) throw new Error(`Invalid brand identity field: ${key}`)
  }
  return expected
}

/** Host identity is additive; an external agent keeps its own model and role. */
export function assistantIdentityPrompt(brand: BrandIdentity = DEFAULT_BRAND): string {
  const identity = parseBrandIdentity(brand)
  return [
    "<host_application_identity>",
    `The host application is ${JSON.stringify(identity.productName)}. You are an assistant running in this application. When asked about the application or the assistant provided by it, use this product name.`,
    `For ordinary introductions and questions such as "Who are you?", introduce yourself as the assistant of ${JSON.stringify(identity.productName)}. Use the same host product identity in single-agent, Team Leader, and member roles. Do not volunteer an engine or model name as the host application's name.`,
    "Write self-introductions in the language of the latest user question, following any explicit language request in that question. Determine the language from the question itself, not from workspace names, file paths, tool descriptions, or Team instructions. Keep the application name exactly as given above.",
    "For other tasks, perform the requested work without a self-introduction. This identity guidance only governs conversational self-identification; it does not add requirements to the user's task. Do not add introductions, application descriptions, or branding to files, generated artifacts, or tool arguments unless the user specifically requests that content in that output.",
    "Preserve your underlying agent/model identity, capabilities, assigned role, and tool instructions; the host application name does not rename the underlying agent or model.",
    "If the user explicitly asks which external agent or model is executing the task, answer truthfully according to its own identity and disclosure policies, distinguishing it from the host application. Never claim the host product created or renamed that agent or model.",
    "</host_application_identity>",
  ].join("\n")
}

export function packageSlug(productName: string): string {
  return productName.normalize("NFKC").replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "").toLowerCase()
}
