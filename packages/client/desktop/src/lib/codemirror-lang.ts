import type { Extension } from "@codemirror/state"
import { javascript } from "@codemirror/lang-javascript"
import { python } from "@codemirror/lang-python"
import { go } from "@codemirror/lang-go"
import { rust } from "@codemirror/lang-rust"
import { json } from "@codemirror/lang-json"
import { html } from "@codemirror/lang-html"
import { css } from "@codemirror/lang-css"
import { markdown } from "@codemirror/lang-markdown"
import { yaml } from "@codemirror/lang-yaml"
import { sql } from "@codemirror/lang-sql"
import { java } from "@codemirror/lang-java"
import { cpp } from "@codemirror/lang-cpp"
import { xml } from "@codemirror/lang-xml"
import { php } from "@codemirror/lang-php"

const extMap: Record<string, () => Extension> = {
  ts: () => javascript({ typescript: true, jsx: false }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  js: () => javascript({ jsx: false }),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  cjs: () => javascript(),
  py: python,
  go: go,
  rs: rust,
  json: json,
  jsonc: json,
  html,
  htm: html,
  vue: html,
  svelte: html,
  css,
  scss: css,
  less: css,
  md: markdown,
  mdx: markdown,
  yaml,
  yml: yaml,
  sql,
  java,
  kt: java,
  c: cpp,
  cpp: () => cpp(),
  h: cpp,
  hpp: () => cpp(),
  cc: () => cpp(),
  cxx: () => cpp(),
  xml,
  svg: xml,
  xsl: xml,
  php,
  sh: () => [] as unknown as Extension,
  bash: () => [] as unknown as Extension,
  zsh: () => [] as unknown as Extension,
  toml: () => [] as unknown as Extension,
  rb: () => [] as unknown as Extension,
}

export function extractExtension(path: string): string {
  return path.split(".").pop()?.toLowerCase() || ""
}

export function getLanguageExtension(ext: string): Extension | null {
  const factory = extMap[ext]
  if (!factory) return null
  const result = factory()
  // Empty array means no language support available
  if (Array.isArray(result) && result.length === 0) return null
  return result
}

