import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { resolveIdentity } from "./index"
import {
  brandEnvironment, brandHealthIdentity, brandPathOverride, brandPaths,
  initializeManagedBrandContext, managedBrandArguments, parseRuntimeBrandContext,
  runtimeBrandContext, sidecarPort, opencodeBaseUrl, type BrandEnv, type RuntimeBrandContext,
} from "./node"

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brand-runtime-"))
  directories.push(root)
  const identity = resolveIdentity({ brandId: "mywork", productName: "MyWork" })
  const context: RuntimeBrandContext = {
    schemaVersion: 1, identity, instanceId: "test_instance_123", ownerPid: 123,
    appRoot: join(root, ".mywork"), configRoot: join(root, "config", "mywork"),
    dataRoot: join(root, "data", "mywork"), cacheRoot: join(root, "cache", "mywork"),
    stateRoot: join(root, "state", "mywork"), skillsRoot: join(root, "config", "mywork", "skills"),
    portsRegistryPath: join(root, ".mywork", "run", "ports.json"),
  }
  const file = join(root, "context.json")
  writeFileSync(file, JSON.stringify(context))
  return { root, context, file }
}

describe("runtime brand isolation", () => {
  it("keeps standalone default roots and treats empty XDG values as unset", () => {
    const paths = brandPaths({ XDG_CONFIG_HOME: "", XDG_DATA_HOME: "" })
    expect(paths.appRoot).toBe(join(homedir(), ".ultrawork"))
    expect(paths.configRoot).toBe(join(homedir(), ".config", "ultrawork"))
    expect(paths.dataRoot).toBe(join(homedir(), ".local", "share", "ultrawork"))
    expect(() => brandPaths({ XDG_CONFIG_HOME: "relative" })).toThrow("absolute")
  })

  it("loads explicit managed mode before directory consumers and preserves instance identity", () => {
    const { context, file } = fixture()
    const env: BrandEnv = {}
    initializeManagedBrandContext(["sidecar", "--brand-context", file], env)
    expect(env.ULTRAWORK_BRAND_MANAGED).toBe("1")
    expect(env.OPENCODE_APP_NAME).toBe("mywork")
    expect(brandPaths(env).configRoot).toBe(context.configRoot)
    expect(managedBrandArguments(env)).toEqual(["--brand-context", file])
    expect(brandHealthIdentity(env)).toEqual({ brandId: "mywork", identifier: "com.ultrawork.mywork", instanceId: context.instanceId })
    expect(brandEnvironment(env).ULTRAWORK_SKILLS_DIR).toBe(context.skillsRoot)
  })

  it("does not downgrade malformed or missing managed context to the default brand", () => {
    const { context, file } = fixture()
    expect(() => runtimeBrandContext({ ULTRAWORK_BRAND_MANAGED: "1" })).toThrow("missing")
    for (const instanceId of ["test_instance_123\n", "test_instance_123\r\n"]) {
      expect(() => parseRuntimeBrandContext({ ...context, instanceId })).toThrow("instance")
    }
    expect(() => initializeManagedBrandContext(["sidecar", "--brand-context", file + ".missing"], {})).toThrow()
    expect(() => parseRuntimeBrandContext({ ...context, appRoot: join(context.appRoot, "..", ".ultrawork") })).toThrow("brand")
    expect(() => parseRuntimeBrandContext({ ...context, skillsRoot: join(context.configRoot, "..", "ultrawork", "skills") })).toThrow("derived")
  })

  it("rejects stale inherited metadata, overrides and another context file", () => {
    const { context, file } = fixture()
    expect(() => runtimeBrandContext({
      ULTRAWORK_BRAND_CONTEXT_FILE: file,
      ULTRAWORK_BRAND_CONTEXT: JSON.stringify({ ...context, instanceId: "stale_instance_1" }),
    })).toThrow("does not match")
    expect(() => runtimeBrandContext({ ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context), OPENCODE_APP_NAME: "ultrawork" })).toThrow("conflicts")
    const env = { ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context), ACP_DATA_DIR: join(context.dataRoot, "..", "ultrawork") }
    expect(() => brandPathOverride("ACP_DATA_DIR", join(context.dataRoot, "acp-sessions"), env)).toThrow("conflicts")
    expect(() => initializeManagedBrandContext(["sidecar", "--brand-context", file], { ULTRAWORK_BRAND_CONTEXT_FILE: file + "-other" })).toThrow("conflicts")
  })

  it("lets managed host fields win after arbitrary agent environment overrides", () => {
    const { context } = fixture()
    const host = { ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context) }
    const child = { ...host, OPENCODE_APP_NAME: "ultrawork", ULTRAWORK_SKILLS_DIR: "wrong", ...brandEnvironment(host) }
    expect(child.OPENCODE_APP_NAME).toBe("mywork")
    expect(child.ULTRAWORK_SKILLS_DIR).toBe(context.skillsRoot)
    expect(brandPaths(child).dataRoot).toBe(context.dataRoot)
  })

  it("requires explicit managed service routing instead of preferred-port fallback", () => {
    const { context } = fixture()
    const env = { ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context) }
    expect(() => sidecarPort("ACP_CLIENT_PORT", 4099, env)).toThrow("missing")
    expect(() => opencodeBaseUrl("http://localhost:4096", env)).toThrow("missing")
    expect(sidecarPort("ACP_CLIENT_PORT", 4099, { ...env, ACP_CLIENT_PORT: "51234" })).toBe(51234)
    expect(sidecarPort("ACP_CLIENT_PORT", 4099, {})).toBe(4099)
    expect(() => sidecarPort("ACP_CLIENT_PORT", 4099, { ACP_CLIENT_PORT: "bad" })).toThrow("invalid")
  })

  it("accepts a development system identifier without changing backend namespace", () => {
    const { context } = fixture()
    const env = { ULTRAWORK_BRAND_CONTEXT: JSON.stringify({ ...context, actualIdentifier: "com.ultrawork.mywork.dev" }) }
    expect(brandHealthIdentity(env).identifier).toBe("com.ultrawork.mywork.dev")
    expect(brandPaths(env).appRoot).toBe(context.appRoot)
  })
})
