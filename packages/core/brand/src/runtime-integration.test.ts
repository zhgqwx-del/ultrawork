import { afterEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { DEFAULT_BRAND, resolveIdentity, type BrandIdentity } from "./index"
import type { RuntimeBrandContext } from "./node"

const repo = resolve(import.meta.dirname, "../../../..")
const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brand-integration-"))
  temporary.push(root)
  const home = join(root, "home")
  mkdirSync(home)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state") }
  for (const key of ["ULTRAWORK_BRAND_CONTEXT", "ULTRAWORK_BRAND_CONTEXT_FILE", "ULTRAWORK_BRAND_MANAGED", "OPENCODE_APP_NAME",
    "ACP_DATA_DIR", "ORCHESTRATOR_DATA_DIR", "ORCHESTRATOR_HIDDEN_DIR", "TEAM_SESSIONS_FILE", "ULTRAWORK_WORKTREES_DIR", "ULTRAWORK_SKILLS_DIR"]) delete env[key]
  return { root, home, env }
}
function contextFor(root: string, home: string, identity: BrandIdentity): RuntimeBrandContext {
  const appRoot = join(home, `.${identity.namespace}`)
  const configRoot = join(root, "config", identity.namespace)
  return { schemaVersion: 1, identity, instanceId: `instance_${identity.brandId}`, appRoot, configRoot,
    dataRoot: join(root, "data", identity.namespace), cacheRoot: join(root, "cache", identity.namespace),
    stateRoot: join(root, "state", identity.namespace), skillsRoot: join(configRoot, "skills"),
    portsRegistryPath: join(appRoot, "run", "ports.json") }
}
const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(join(repo, relative)).href)

const storeProbe = `
  import {mkdirSync,writeFileSync} from 'node:fs'; import {homedir} from 'node:os'; import {dirname,join} from 'node:path';
  const brand = await import(${moduleUrl("packages/core/brand/src/node.ts")});
  brand.initializeManagedBrandContext(); const paths=brand.brandPaths();
  mkdirSync(dirname(paths.portsRegistryPath),{recursive:true});
  const context=brand.runtimeBrandContext();
  writeFileSync(paths.portsRegistryPath,JSON.stringify({brandId:context.identity.brandId,instanceId:context.instanceId,acp:{port:54321}}));
  const shim=await import(${moduleUrl("packages/agent/acp-client/src/delegate-mcp.ts")});
  const shimUrl=shim.shimDepsFromEnv().baseUrl;
  writeFileSync(paths.portsRegistryPath,JSON.stringify({brandId:'wrongbrand',instanceId:context.instanceId,acp:{port:4099}}));
  let staleRejected=false; try {shim.shimDepsFromEnv().baseUrl}catch{staleRejected=true}
  const acp=await import(${moduleUrl("packages/agent/acp-client/src/session-store.ts")});
  const before=acp.loadAllSessions().length;
  acp.saveSession({version:1,sessionId:'same-session',acpSessionId:'external',agentId:'fixture',cwd:homedir(),messages:[]});
  const gateway=await import(${moduleUrl("packages/channel/gateway/src/config-store.ts")});
  await gateway.addConfig({id:'same-channel',type:'wechat',name:'fixture',autoConnect:false});
  const team=await import(${moduleUrl("packages/agent/acp-client/src/team-store.ts")});
  team.saveTeamSessions([{id:'same-team',workspace:homedir(),leaderAgentId:'opencode:default',members:[],createdAt:1}]);
  const {RunStore}=await import(${moduleUrl("packages/core/orchestrator/src/run-store.ts")});
  new RunStore().save({version:1,id:'same-run'});
  const {runArtifactDir}=await import(${moduleUrl("packages/core/orchestrator/src/artifacts.ts")});
  const artifactDir=runArtifactDir(join(homedir(),'workspace'),'same-run'); mkdirSync(artifactDir,{recursive:true});
  const kbPath=join(paths.appRoot,'knowledge','kb.db'); mkdirSync(dirname(kbPath),{recursive:true});
  const {KnowledgeStore}=await import(${moduleUrl("packages/knowledge/sidecar/src/store.ts")});
  const kb=new KnowledgeStore(kbPath); kb.close();
  console.log(JSON.stringify({before,homedir:homedir(),paths,artifactDir,shimUrl,staleRejected}));
`

describe("brand runtime real subprocesses", () => {
  it("isolates backend stores in one HOME, including standalone old-default paths", () => {
    const { root, home, env } = fixture()
    const defaultData = join(root, "data", "ultrawork", "acp-sessions")
    mkdirSync(defaultData, { recursive: true })
    const seed = JSON.stringify({ version: 1, sessionId: "old-default", acpSessionId: "legacy", agentId: "fixture", messages: [] })
    writeFileSync(join(defaultData, "old-default.json"), seed)
    const results = []
    for (const identity of [resolveIdentity({ brandId: "mywork", productName: "MyWork" }),
      resolveIdentity({ brandId: "secondwork", productName: "SecondWork" }), DEFAULT_BRAND]) {
      const context = contextFor(root, home, identity)
      const contextFile = join(root, `${identity.brandId}.json`)
      writeFileSync(contextFile, JSON.stringify(context))
      const result = spawnSync(process.execPath, ["--eval", storeProbe, "--", "--brand-context", contextFile], {
        env: { ...env, ULTRAWORK_SIDECAR_PASSWORD: "fixture-only" }, cwd: repo, encoding: "utf8", timeout: 15_000,
      })
      expect(result.status, result.stderr).toBe(0)
      const output = JSON.parse(result.stdout.trim().split("\n").at(-1)!)
      expect(output.homedir).toBe(home)
      expect(output.shimUrl).toBe("http://127.0.0.1:54321")
      expect(output.staleRejected).toBe(true)
      expect(output.before).toBe(identity.isDefault ? 1 : 0)
      expect(output.artifactDir).toBe(join(home, "workspace", `.${identity.namespace}`, "runs", "same-run"))
      expect(readFileSync(join(context.dataRoot, "acp-sessions", "same-session.json"), "utf8")).toContain("same-session")
      expect(readFileSync(join(context.appRoot, "channels.json"), "utf8")).toContain("same-channel")
      expect(readFileSync(join(context.dataRoot, "team-sessions.json"), "utf8")).toContain("same-team")
      expect(readFileSync(join(context.dataRoot, "orchestrator-runs", "same-run.json"), "utf8")).toContain("same-run")
      results.push(output.paths)
    }
    expect(new Set(results.map((x) => x.appRoot)).size).toBe(3)
    expect(readFileSync(join(defaultData, "old-default.json"), "utf8")).toBe(seed)
  })

  it("fails each managed entry before creating default data when its context is missing", () => {
    const { root, home, env } = fixture()
    for (const entry of ["packages/agent/acp-client/src/index.ts", "packages/channel/gateway/src/index.ts", "packages/knowledge/sidecar/src/index.ts"]) {
      const result = spawnSync(process.execPath, ["run", join(repo, entry), "--brand-context", join(root, "missing-context.json")], {
        env, cwd: repo, encoding: "utf8", timeout: 15_000,
      })
      expect(result.status, entry + result.stderr).not.toBe(0)
      expect(result.stderr).toContain("missing-context.json")
      expect(readdirSync(home)).toEqual([])
    }
  })

  it("uses managed Python skills and embedded Node roots and refuses broken context", () => {
    const { root, home, env } = fixture()
    const context = contextFor(root, home, resolveIdentity({ brandId: "mywork", productName: "MyWork" }))
    const file = join(root, "context.json")
    writeFileSync(file, JSON.stringify(context))
    const python = process.platform === "win32" ? "python" : "python3"
    const script = `import ast,json,os,pathlib,sys\n` +
      `source=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')\n` +
      `fn=next(x for x in ast.parse(source).body if isinstance(x,ast.FunctionDef) and x.name=='_codex_home')\n` +
      `ns={'os':os,'json':json}; exec(compile(ast.Module(body=[fn],type_ignores=[]),sys.argv[1],'exec'),ns)\n` +
      `sys.path.insert(0,sys.argv[2]); import find_node\n` +
      `print(json.dumps([ns['_codex_home'](),str(find_node._embedded_node())]))\n`
    const args = ["-c", script, join(repo, "skills/builtin/skill-installer/scripts/install-skill-from-github.py"),
      join(repo, "skills/builtin/deckcraft/scripts")]
    const managedEnv = { ...env, ULTRAWORK_BRAND_CONTEXT_FILE: file, ULTRAWORK_BRAND_MANAGED: "1" }
    const good = spawnSync(python, args, { env: managedEnv, encoding: "utf8", timeout: 10_000 })
    expect(good.status, good.stderr).toBe(0)
    expect(JSON.parse(good.stdout)[0]).toBe(context.configRoot)
    expect(JSON.parse(good.stdout)[1]).toBe(join(context.appRoot, "node", ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"])))
    const bad = spawnSync(python, args, { env: { ...managedEnv, ULTRAWORK_BRAND_CONTEXT_FILE: file + ".missing" }, encoding: "utf8", timeout: 10_000 })
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toContain("FileNotFoundError")
  })
})
