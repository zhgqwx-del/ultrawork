/** Node/Bun runtime adapter. Keep this entry separate from the renderer-safe identity API. */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, normalize, resolve } from "node:path"
import { DEFAULT_BRAND, parseBrandIdentity, type BrandIdentity } from "./index"

export interface BrandPaths {
  appRoot: string
  configRoot: string
  dataRoot: string
  cacheRoot: string
  stateRoot: string
  skillsRoot: string
  portsRegistryPath: string
}

export interface RuntimeBrandContext extends BrandPaths {
  schemaVersion: 1
  identity: BrandIdentity
  instanceId: string
  actualIdentifier?: string
  ownerPid?: number
}

export type BrandEnv = Record<string, string | undefined>
type ReadText = (path: string) => string
const readText: ReadText = (path) => readFileSync(path, "utf8")
const ROOT_KEYS = ["appRoot", "configRoot", "dataRoot", "cacheRoot", "stateRoot", "skillsRoot", "portsRegistryPath"] as const

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime brand context")
  return value as Record<string, unknown>
}

export function parseRuntimeBrandContext(value: unknown): RuntimeBrandContext {
  const item = object(value)
  if (item.schemaVersion !== 1) throw new Error("Unsupported runtime brand context schema")
  const identity = parseBrandIdentity(item.identity)
  if (typeof item.instanceId !== "string" || item.instanceId !== item.instanceId.trim() || !/^[a-zA-Z0-9_-]{8,128}$/.test(item.instanceId)) {
    throw new Error("Missing runtime brand instance identity")
  }
  const paths = {} as BrandPaths
  for (const key of ROOT_KEYS) {
    if (typeof item[key] !== "string" || !isAbsolute(item[key]) || item[key].includes("\0")) {
      throw new Error(`Runtime brand ${key} must be an absolute path`)
    }
    paths[key] = normalize(item[key])
  }
  if (basename(paths.appRoot) !== `.${identity.namespace}`) throw new Error("Runtime appRoot does not belong to its brand")
  for (const key of ["configRoot", "dataRoot", "cacheRoot", "stateRoot"] as const) {
    if (basename(paths[key]) !== identity.namespace) throw new Error(`Runtime ${key} does not belong to its brand`)
  }
  if (paths.skillsRoot !== join(paths.configRoot, "skills") ||
      paths.portsRegistryPath !== join(paths.appRoot, "run", "ports.json")) {
    throw new Error("Runtime brand derived paths do not match their roots")
  }
  if (item.actualIdentifier !== undefined && item.actualIdentifier !== identity.identifier &&
      item.actualIdentifier !== `${identity.identifier}.dev`) throw new Error("Invalid runtime application identifier")
  if (item.ownerPid !== undefined && (!Number.isInteger(item.ownerPid) || Number(item.ownerPid) <= 0)) {
    throw new Error("Invalid runtime owner PID")
  }
  return {
    schemaVersion: 1,
    identity,
    instanceId: item.instanceId,
    ...paths,
    ...(item.actualIdentifier === undefined ? {} : { actualIdentifier: item.actualIdentifier as string }),
    ...(item.ownerPid === undefined ? {} : { ownerPid: item.ownerPid as number }),
  }
}

/** Reads on demand so a test can inject environment before constructing a store. No IO for standalone defaults. */
export function runtimeBrandContext(env: BrandEnv = process.env, read: ReadText = readText): RuntimeBrandContext | undefined {
  const json = env.ULTRAWORK_BRAND_CONTEXT
  const file = env.ULTRAWORK_BRAND_CONTEXT_FILE
  let fromFile: RuntimeBrandContext | undefined
  let fromJson: RuntimeBrandContext | undefined
  if (file) {
    if (!isAbsolute(file)) throw new Error("Runtime brand context file must be absolute")
    fromFile = parseRuntimeBrandContext(JSON.parse(read(file)))
  }
  if (json) fromJson = parseRuntimeBrandContext(JSON.parse(json))
  if (fromFile && fromJson && JSON.stringify(fromFile) !== JSON.stringify(fromJson)) {
    throw new Error("Inherited runtime brand context does not match its context file")
  }
  const context = fromFile ?? fromJson
  if (env.ULTRAWORK_BRAND_MANAGED === "1" && !context) throw new Error("Managed runtime brand context is missing")
  if (context && env.OPENCODE_APP_NAME && env.OPENCODE_APP_NAME !== context.identity.namespace) {
    throw new Error("OPENCODE_APP_NAME conflicts with the runtime brand")
  }
  return context
}

/** Validate managed mode before importing any business module which may initialize a database or directory. */
export function initializeManagedBrandContext(argv: string[] = process.argv, env: BrandEnv = process.env): RuntimeBrandContext | undefined {
  const indices = argv.flatMap((arg, i) => arg === "--brand-context" ? [i] : [])
  if (indices.length > 1) throw new Error("Duplicate --brand-context")
  if (indices.length) {
    const file = argv[indices[0] + 1]
    if (!file || file.startsWith("--") || !isAbsolute(file)) throw new Error("--brand-context requires an absolute context file")
    if (env.ULTRAWORK_BRAND_CONTEXT_FILE && resolve(env.ULTRAWORK_BRAND_CONTEXT_FILE) !== resolve(file)) {
      throw new Error("Managed brand argument conflicts with inherited environment")
    }
    env.ULTRAWORK_BRAND_CONTEXT_FILE = file
    env.ULTRAWORK_BRAND_MANAGED = "1"
  }
  const context = runtimeBrandContext(env)
  if (context) {
    env.ULTRAWORK_BRAND_CONTEXT = JSON.stringify(context)
    env.ULTRAWORK_BRAND_MANAGED = "1"
    env.OPENCODE_APP_NAME = context.identity.namespace
    env.ULTRAWORK_SKILLS_DIR = context.skillsRoot
    env.ULTRAWORK_APP_ROOT = context.appRoot
  }
  return context
}

function xdgRoot(env: BrandEnv, key: string, fallback: string): string {
  const value = env[key]
  if (!value) return fallback
  if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path`)
  return value
}

export function brandPaths(env: BrandEnv = process.env): BrandPaths {
  const context = runtimeBrandContext(env)
  if (context) return context
  const home = homedir()
  const namespace = DEFAULT_BRAND.namespace
  const appRoot = join(home, `.${namespace}`)
  const configRoot = join(xdgRoot(env, "XDG_CONFIG_HOME", join(home, ".config")), namespace)
  return {
    appRoot,
    configRoot,
    dataRoot: join(xdgRoot(env, "XDG_DATA_HOME", join(home, ".local", "share")), namespace),
    cacheRoot: join(xdgRoot(env, "XDG_CACHE_HOME", join(home, ".cache")), namespace),
    stateRoot: join(xdgRoot(env, "XDG_STATE_HOME", join(home, ".local", "state")), namespace),
    skillsRoot: join(configRoot, "skills"),
    portsRegistryPath: join(appRoot, "run", "ports.json"),
  }
}

/** Only host-owned routing fields; callers merge these AFTER user agent/MCP environment overrides. */
export function brandEnvironment(env: BrandEnv = process.env): Record<string, string> {
  const context = runtimeBrandContext(env)
  if (!context) return {}
  return {
    ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context),
    ...(env.ULTRAWORK_BRAND_CONTEXT_FILE ? { ULTRAWORK_BRAND_CONTEXT_FILE: env.ULTRAWORK_BRAND_CONTEXT_FILE } : {}),
    ULTRAWORK_BRAND_MANAGED: "1",
    ULTRAWORK_APP_ROOT: context.appRoot,
    ULTRAWORK_SKILLS_DIR: context.skillsRoot,
    OPENCODE_APP_NAME: context.identity.namespace,
    ...Object.fromEntries([
      "OPENCODE_BASE_URL", "ACP_CLIENT_PORT", "KB_PORT", "GATEWAY_PORT",
      "ULTRAWORK_SIDECAR_PASSWORD", "ULTRAWORK_SIDECAR_USERNAME", "OPENCODE_SERVER_PASSWORD",
    ].flatMap((key) => env[key] ? [[key, env[key]!]] : [])),
  }
}

export function managedBrandArguments(env: BrandEnv = process.env): string[] {
  const context = runtimeBrandContext(env)
  if (!context) return []
  if (!env.ULTRAWORK_BRAND_CONTEXT_FILE) throw new Error("Managed child requires an explicit runtime context file")
  return ["--brand-context", env.ULTRAWORK_BRAND_CONTEXT_FILE]
}

/** Context-owned paths win over legacy test/standalone path overrides. */
export function brandPathOverride(variable: string, expected: string, env: BrandEnv = process.env): string {
  const context = runtimeBrandContext(env)
  const value = env[variable]
  if (context && value && normalize(value) !== normalize(expected)) {
    throw new Error(`${variable} conflicts with the managed brand directory`)
  }
  return context ? expected : value || expected
}

export function brandHealthIdentity(env: BrandEnv = process.env): Record<string, string> {
  const context = runtimeBrandContext(env)
  return context ? {
    brandId: context.identity.brandId,
    identifier: context.actualIdentifier ?? context.identity.identifier,
    instanceId: context.instanceId,
  } : {}
}

/** Hosted services never guess another application's preferred port or backend URL. */
export function sidecarPort(variable: string, fallback: number, env: BrandEnv = process.env): number {
  const raw = env[variable]
  if (runtimeBrandContext(env) && !raw) throw new Error(`Managed ${variable} is missing`)
  const value = raw === undefined ? fallback : Number(raw)
  if (raw === "" || !Number.isInteger(value) || value < 0 || value >= 65536) throw new Error(`${variable} is invalid`)
  return value
}

export function opencodeBaseUrl(fallback: string, env: BrandEnv = process.env): string {
  const raw = env.OPENCODE_BASE_URL
  if (runtimeBrandContext(env) && !raw) throw new Error("Managed OPENCODE_BASE_URL is missing")
  const value = raw ?? fallback
  const parsed = new URL(value)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("OPENCODE_BASE_URL is invalid")
  return value
}
