import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // doc-parser lazily imports unpdf / mammoth / xlsx / jszip (heavy, ESM,
    // pdfjs internals). Externalize them so vite-node hands the import to native
    // Node instead of transforming — the transform path hits a
    // "File URL path must be an absolute path" bug in vite-node on Windows.
    server: {
      deps: {
        external: ["unpdf", "mammoth", "xlsx", "jszip"],
      },
    },
  },
})
