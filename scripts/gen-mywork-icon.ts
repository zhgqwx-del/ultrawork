#!/usr/bin/env bun
/** Derive the MyWork application icon without redrawing or recoloring Meiyou.
 * Use the shipped default master as an alpha mask, so Tauri produces exactly
 * the same rounded silhouette at every native icon size. The official source
 * and the default icon remain unchanged.
 *
 * Regenerate: bun run --bun scripts/gen-mywork-icon.ts
 * Verify:     bun run --bun scripts/gen-mywork-icon.ts --check
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Resvg } from "@resvg/resvg-js"
import { validatePng } from "./png-image"

export const ICON_PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const MYWORK_ICON_SOURCE = path.join("branding", "mywork", "assets", "meiyou-app.png")
export const MYWORK_ICON_OUTPUT = path.join("branding", "mywork", "assets", "meiyou-app-rounded.png")
export const DEFAULT_ICON_MASTER = path.join("design", "logo", "icon-1024.png")

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const pngDataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`

export function renderMyworkIcon(source: Buffer, silhouette: Buffer): Buffer {
  const original = validatePng(source, "Meiyou official source")
  const mask = validatePng(silhouette, "Ultrawork silhouette master")
  if (original.width !== mask.width || original.height !== mask.height || mask.width !== mask.height) {
    throw new Error("MyWork source and silhouette must have matching square dimensions")
  }
  const { width, height } = mask
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><mask id="outline" mask-type="alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">
      <image width="${width}" height="${height}" href="${pngDataUrl(silhouette)}"/>
    </mask></defs>
    <image width="${width}" height="${height}" mask="url(#outline)" href="${pngDataUrl(source)}"/>
  </svg>`).render().asPng()
}

export function myworkIconArtifacts(root = ICON_PROJECT_ROOT) {
  const source = readFileSync(path.join(root, MYWORK_ICON_SOURCE))
  const silhouette = readFileSync(path.join(root, DEFAULT_ICON_MASTER))
  const image = renderMyworkIcon(source, silhouette)
  const provenanceFile = path.join(root, "branding", "mywork", "assets", "source.json")
  const provenance = JSON.parse(readFileSync(provenanceFile, "utf8"))
  if (provenance.sha256 !== sha256(source)) throw new Error("Meiyou official source does not match its recorded SHA-256")
  return {
    image,
    imageFile: path.join(root, MYWORK_ICON_OUTPUT),
    provenanceFile,
    provenance: {
      ...provenance,
      applicationIcon: {
        file: "meiyou-app-rounded.png",
        generator: "bun run --bun scripts/gen-mywork-icon.ts",
        sourceFile: "meiyou-app.png",
        sourceSha256: sha256(source),
        alphaMaskFile: "design/logo/icon-1024.png",
        alphaMaskSha256: sha256(silhouette),
        dimensions: validatePng(image),
        sha256: sha256(image),
        transformation: "Official image at its original size, clipped by the default Ultrawork master's alpha channel; no redraw, recolor, padding or rescaling. The default SVG radius is 112/512 (21.875%).",
      },
    },
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Usage: bun run --bun scripts/gen-mywork-icon.ts [--check]")
  const artifacts = myworkIconArtifacts()
  if (process.argv.includes("--check")) {
    const current = JSON.parse(readFileSync(artifacts.provenanceFile, "utf8"))
    if (!readFileSync(artifacts.imageFile).equals(artifacts.image) || JSON.stringify(current) !== JSON.stringify(artifacts.provenance)) {
      throw new Error("MyWork icon is stale; run bun run --bun scripts/gen-mywork-icon.ts")
    }
    console.log("MyWork icon and provenance are up to date")
  } else {
    writeFileSync(artifacts.imageFile, artifacts.image)
    writeFileSync(artifacts.provenanceFile, `${JSON.stringify(artifacts.provenance, null, 2)}\n`)
    console.log(`Generated ${MYWORK_ICON_OUTPUT}`)
  }
}
