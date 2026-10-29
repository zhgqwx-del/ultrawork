import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_BRAND, packageSlug, resolveIdentity } from "../packages/core/brand/src/index"
import { releaseBuildArguments, releaseMatrix, verifyReleaseArtifacts } from "./release-ci"

const temporary: string[] = []
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function directory() { const root = realpathSync(mkdtempSync(path.join(tmpdir(), "release-ci-fixture-"))); temporary.push(root); return root }
const tag = "refs/tags/v1.2.3"

test("tags always plan both editions across three platforms; dispatch may select one or both", () => {
  const matrix = releaseMatrix("push", "default")
  expect(matrix.include.length).toBe(6)
  expect(new Set(matrix.include.map((job) => `${job.brand}:${job.os}`)).size).toBe(6)
  expect(matrix.include.filter((job) => job.brand === "mywork").length).toBe(3)
  for (const brand of ["default", "mywork"]) {
    const selected = releaseMatrix("workflow_dispatch", brand)
    expect(selected.include.length).toBe(3)
    expect(selected.include.every((job) => job.brand === brand)).toBe(true)
  }
  expect(releaseMatrix("workflow_dispatch", "all").include.length).toBe(6)
  expect(() => releaseMatrix("workflow_dispatch", "arbitrary")).toThrow("presets")
})

test("tag builds allow both known brands and reject unsigned/notary or branding overrides", () => {
  const root = path.join(tmpdir(), "品牌 checkout")
  expect(releaseBuildArguments("default", ["--verbose"], tag, root)).toEqual(["--verbose"])
  expect(releaseBuildArguments("mywork", [], tag, root)).toEqual(["--brand", path.join(root, "branding/mywork/brand.json")])
  for (const flag of ["--unsigned", "--skip-notarize", "--native", "--allow-bad-dmg-layout"]) {
    expect(() => releaseBuildArguments("mywork", [flag], tag, root)).toThrow("signed/notarized")
  }
  expect(releaseBuildArguments("mywork", ["--unsigned"], "refs/heads/main", root).at(-1)).toBe("--unsigned")
  expect(releaseBuildArguments("mywork", ["--unsigned"], tag, root, "workflow_dispatch").at(-1)).toBe("--unsigned")
  expect(() => releaseBuildArguments("other", [], tag, root)).toThrow("presets")
  expect(() => releaseBuildArguments("default", ["--brand", "untrusted.json"], tag, root)).toThrow("controlled only")
})

function copyEntry(root: string) {
  mkdirSync(path.join(root, "scripts"), { recursive: true })
  mkdirSync(path.join(root, "packages/core/brand/src"), { recursive: true })
  copyFileSync(path.join(import.meta.dir, "release-ci.ts"), path.join(root, "scripts/release-ci.ts"))
  copyFileSync(path.resolve(import.meta.dir, "../packages/core/brand/src/index.ts"), path.join(root, "packages/core/brand/src/index.ts"))
}

function expectBuildWitness(marker: string, root: string, brand: string, extra: string[]) {
  const witness = JSON.parse(readFileSync(marker, "utf8"))
  // Windows may expand an 8.3 TEMP path in the child process. Check filesystem
  // identity rather than requiring the two names for that directory to match.
  const expected = statSync(root), actual = statSync(witness.cwd)
  expect({ dev: actual.dev, ino: actual.ino }).toEqual({ dev: expected.dev, ino: expected.ino })
  if (brand === "mywork") {
    expect(witness.args[0]).toBe("--brand")
    expect(path.relative(witness.cwd, witness.args[1])).toBe(path.join("branding", "mywork", "brand.json"))
    expect(witness.args.slice(2)).toEqual(extra)
  } else expect(witness.args).toEqual(extra)
}

test("real CI entry forwards tag preset arguments and child exit status without running a build", () => {
  const root = directory(); copyEntry(root)
  const marker = path.join(root, "build-witness.json")
  writeFileSync(path.join(root, "scripts/build-release.ts"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));process.exit(29)`)
  for (const brand of ["default", "mywork"]) {
    const child = spawnSync(process.execPath, [path.join(root, "scripts/release-ci.ts"), "--verbose"], { cwd: root, env: { ...process.env, ULTRAWORK_RELEASE_BRAND: brand, GITHUB_REF: tag, GITHUB_EVENT_NAME: "push" }, encoding: "utf8", timeout: 10_000 })
    expect(child.status, child.stderr).toBe(29)
    expectBuildWitness(marker, root, brand, ["--verbose"])
    rmSync(marker)
  }
  const rejected = spawnSync(process.execPath, [path.join(root, "scripts/release-ci.ts"), "--unsigned"], { cwd: root, env: { ...process.env, ULTRAWORK_RELEASE_BRAND: "mywork", GITHUB_REF: tag, GITHUB_EVENT_NAME: "push" }, encoding: "utf8", timeout: 10_000 })
  expect(rejected.status).not.toBe(0)
  expect(existsSync(marker)).toBe(false)
  const manual = spawnSync(process.execPath, [path.join(root, "scripts/release-ci.ts"), "--unsigned"], { cwd: root, env: { ...process.env, ULTRAWORK_RELEASE_BRAND: "mywork", GITHUB_REF: tag, GITHUB_EVENT_NAME: "workflow_dispatch" }, encoding: "utf8", timeout: 10_000 })
  expect(manual.status, manual.stderr).toBe(29)
  expectBuildWitness(marker, root, "mywork", ["--unsigned"])
  rmSync(marker)
  const matrix = spawnSync(process.execPath, [path.join(root, "scripts/release-ci.ts"), "--matrix"], { cwd: root, env: { ...process.env, GITHUB_EVENT_NAME: "push", ULTRAWORK_RELEASE_BRAND_INPUT: "all" }, encoding: "utf8", timeout: 10_000 })
  expect(matrix.status, matrix.stderr).toBe(0)
  expect(JSON.parse(matrix.stdout).include.length).toBe(6)
  expect(existsSync(marker)).toBe(false)
})

function artifactSet() {
  const root = directory(), manifests = new Map<string, string>()
  for (const identity of [DEFAULT_BRAND, resolveIdentity({ brandId: "mywork", productName: "MyWork" })]) {
    for (const platform of ["darwin-arm64", "win32-x64", "linux-x64"]) {
      const folder = path.join(root, identity.brandId, platform)
      mkdirSync(folder, { recursive: true })
      const product = identity.productName, slug = packageSlug(product)
      const names = platform.startsWith("darwin") ? [`${product}_1.2.3_universal.dmg`] : platform.startsWith("win32") ? [`${product}_1.2.3_x64_en-US.msi`, `${product}_1.2.3_x64-setup.exe`, `${product}_1.2.3_x64-offline-setup.exe`] : [`${slug}_1.2.3_amd64.deb`, `${slug}-1.2.3-1.x86_64.rpm`]
      const artifacts = names.map((file) => {
        const bytes = Buffer.from(`${identity.brandId}:${platform}:${file}`)
        writeFileSync(path.join(folder, file), bytes)
        return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
      })
      const file = path.join(folder, `manifest-${platform}.json`)
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, identity, platform, build: { mode: "release", productName: product, identifier: identity.identifier, signing: platform.startsWith("darwin") ? "developer-id" : "not-configured", target: platform.startsWith("darwin") ? "universal-apple-darwin" : "native" }, artifacts }))
      manifests.set(`${identity.brandId}:${platform}`, file)
    }
  }
  return { root, manifests }
}
function mutate(file: string, update: (data: any) => void) { const data = JSON.parse(readFileSync(file, "utf8")); update(data); writeFileSync(file, JSON.stringify(data)) }

test("publish verification preserves both manifest namespaces and returns twelve distinct installers", () => {
  const f = artifactSet(), assets = verifyReleaseArtifacts(f.root)
  expect(assets.length).toBe(12)
  expect(new Set(assets.map((file) => path.basename(file))).size).toBe(12)
  expect(assets.some((file) => file.endsWith(".json"))).toBe(false)
})

test("publish rejects hash drift, missing platforms, unsigned Mac and incomplete Windows/Linux sets", () => {
  {
    const f = artifactSet(), file = f.manifests.get("mywork:darwin-arm64")!
    const data = JSON.parse(readFileSync(file, "utf8"))
    writeFileSync(path.join(path.dirname(file), data.artifacts[0].file), "changed")
    expect(() => verifyReleaseArtifacts(f.root)).toThrow("hash/size")
  }
  {
    const f = artifactSet(); rmSync(f.manifests.get("mywork:linux-x64")!)
    expect(() => verifyReleaseArtifacts(f.root)).toThrow("six edition/platform")
  }
  for (const update of [
    (data: any) => { data.build.mode = "unsigned-dev" },
    (data: any) => { data.build.signing = "ad-hoc" },
    (data: any) => { data.build.target = "aarch64-apple-darwin" },
    (data: any) => { data.build.identifier += ".dev" },
  ]) {
    const f = artifactSet(); mutate(f.manifests.get("mywork:darwin-arm64")!, update)
    expect(() => verifyReleaseArtifacts(f.root)).toThrow()
  }
  for (const [key, suffix] of [["mywork:win32-x64", "-offline-setup.exe"], ["mywork:linux-x64", ".rpm"]]) {
    const f = artifactSet(); mutate(f.manifests.get(key!)!, (data) => { data.artifacts = data.artifacts.filter((item: any) => !item.file.endsWith(suffix)) })
    expect(() => verifyReleaseArtifacts(f.root)).toThrow("Missing")
  }
})

test("publish rejects flat asset collisions, unlisted files and unsafe manifest paths", () => {
  {
    const f = artifactSet(), source = f.manifests.get("ultrawork:darwin-arm64")!, target = f.manifests.get("ultrawork:linux-x64")!
    const duplicate = JSON.parse(readFileSync(source, "utf8")).artifacts[0]
    copyFileSync(path.join(path.dirname(source), duplicate.file), path.join(path.dirname(target), duplicate.file))
    mutate(target, (data) => data.artifacts.push(duplicate))
    expect(() => verifyReleaseArtifacts(f.root)).toThrow("filename collision")
  }
  {
    const f = artifactSet(); writeFileSync(path.join(f.root, "extra.dmg"), "not in manifest")
    expect(() => verifyReleaseArtifacts(f.root)).toThrow("Unlisted")
  }
  {
    const f = artifactSet(); mutate(f.manifests.get("mywork:darwin-arm64")!, (data) => { data.artifacts[0].file = "../outside.dmg" })
    expect(() => verifyReleaseArtifacts(f.root)).toThrow("Invalid release asset")
  }
})

const unixTest = process.platform === "win32" ? test.skip : test
unixTest("publish never follows a symbolic link outside its downloaded artifacts", () => {
  const f = artifactSet(); symlinkSync(f.manifests.get("mywork:darwin-arm64")!, path.join(f.root, "untrusted-link"))
  expect(() => verifyReleaseArtifacts(f.root)).toThrow("symbolic links")
})

unixTest("publish shell restores separate downloaded artifacts and emits only verified installer paths", () => {
  const f = artifactSet(), root = directory()
  copyEntry(root)
  for (const edition of ["ultrawork", "mywork"]) {
    for (const [platform, job] of [["darwin-arm64", "macos"], ["win32-x64", "windows-x64"], ["linux-x64", "linux-x64"]]) {
      const archive = path.join(root, "dist", `${edition}-${job}`)
      mkdirSync(archive, { recursive: true })
      cpSync(path.join(f.root, edition, platform!), path.join(archive, platform!), { recursive: true })
    }
  }
  const workflow = Bun.YAML.parse(readFileSync(path.resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8")) as any
  const script = workflow.jobs.publish.steps.find((step: any) => step.id === "assets").run
  const output = path.join(root, "github-output.txt")
  const child = spawnSync("bash", ["-c", script], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: "utf8", timeout: 10_000 })
  expect(child.status, child.stderr).toBe(0)
  const assets = verifyReleaseArtifacts(path.join(root, "collected"))
  expect(assets.length).toBe(12)
  expect(readFileSync(output, "utf8")).toBe(`files<<RELEASE_FILES\n${assets.join("\n")}\nRELEASE_FILES\n`)
})

test("workflow routes the planned matrix, strict tag signing and verified file list into publication", () => {
  const workflow = Bun.YAML.parse(readFileSync(path.resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8")) as any
  expect(workflow.on.push.tags).toEqual(["v*"])
  expect(workflow.on.workflow_dispatch.inputs.brand.options).toEqual(["all", "default", "mywork"])
  expect(workflow.jobs.guard.outputs.matrix).toBe("${{ steps.matrix.outputs.matrix }}")
  expect(workflow.jobs.build.strategy.matrix).toBe("${{ fromJSON(needs.guard.outputs.matrix) }}")
  expect(workflow.jobs.build.env.ULTRAWORK_RELEASE_BRAND).toBe("${{ matrix.brand }}")
  const mac = workflow.jobs.build.steps.find((step: any) => step.id === "macos_build")
  expect(mac.run).toContain('elif [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ] && [ "${ALLOW_UNSIGNED_RELEASE:-}" = "true" ]')
  const upload = workflow.jobs.build.steps.find((step: any) => step.uses?.startsWith("actions/upload-artifact"))
  expect(upload.with.name).toContain("matrix.brand")
  expect(upload.with.path).toContain("matrix.brand")
  const publish = workflow.jobs.publish
  expect(publish.needs).toBe("build")
  expect(publish.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
  const action = publish.steps.find((step: any) => step.uses?.startsWith("softprops/action-gh-release"))
  expect(action.with.files).toBe("${{ steps.assets.outputs.files }}")
  expect(publish.steps.find((step: any) => step.id === "assets").run).toContain("--verify-artifacts collected")
})
