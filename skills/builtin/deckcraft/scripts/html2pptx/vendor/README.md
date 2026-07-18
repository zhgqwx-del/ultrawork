# vendored pptxgenjs bundle

`pptxgen.vendor.cjs` is a **self-contained CommonJS bundle** of
[pptxgenjs](https://github.com/gitbrent/PptxGenJS) (MIT) with its `jszip`
dependency inlined. The editable-pptx assembler (`../assemble.mjs`) `require()`s
it, so the skill needs **no `node_modules` and no `npm` at runtime** — only a
Node binary (the app's embedded Node; see `scripts/find_node.py`).

## Why a rebuilt bundle, not the shipped `dist/`

pptxgenjs ships `dist/pptxgen.bundle.js`, but that UMD file is built for the
browser: under Node `require()` it returns **JSZip**, not the PptxGenJS class.
`dist/pptxgen.cjs.js` is Node-correct but `require("jszip")` — reintroducing
`node_modules`. So we bundle the CJS entry + jszip into one file with esbuild.

## Regenerate (pinned versions)

Run on any machine with Node + npx (throwaway dir):

```bash
mkdir pptx-build && cd pptx-build
npm init -y
npm i pptxgenjs@3.12.0 esbuild
printf "module.exports = require('pptxgenjs')\n" > entry.cjs
node_modules/.bin/esbuild entry.cjs --bundle --platform=node --format=cjs \
  --legal-comments=none --outfile=pptxgen.vendor.cjs
# then copy pptxgen.vendor.cjs over the one in this dir
```

Pins: **pptxgenjs 3.12.0**, bundled with **esbuild** (`--platform=node`,
`--format=cjs`). Sanity-check the result: `require()` must yield a function
named `PptxGenJS…` and `new P().addSlide()` must work. When bumping the pin,
re-run `python3 scripts/deckcraft-selftest.py` (its editable-pptx cases exercise
the assembler) and repack `.builtin-version`.
