#!/usr/bin/env bun
import { parseBrandArgs, resolveBrandBuild, validateArguments } from "./brand-build"
const parsed = parseBrandArgs(process.argv.slice(2))
validateArguments(parsed.rest, [])
const brand = resolveBrandBuild(parsed.brand)
console.log(JSON.stringify({ ...brand.identity, packageSlug: brand.packageSlug, wixUpgradeCode: brand.upgradeCode, digest: brand.digest }, null, 2))
