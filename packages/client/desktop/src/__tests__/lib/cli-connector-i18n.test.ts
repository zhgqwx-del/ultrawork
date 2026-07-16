import { describe, it, expect } from "vitest"
import { translations } from "@/lib/i18n-context"

/**
 * Key-completeness guard for per-connector i18n families: t() leaks the raw
 * key when one is missing, and the connector card renders SIX per-id keys
 * (title/desc + two toasts + two hints — hints defensively even for states a
 * connector can't reach). A new connector added without its keys passes every
 * behavioral test (hooks mock t as identity) — this data test is the tripwire.
 * The id list mirrors Rust's CLI_CONNECTORS registry (anchored by the cargo
 * test cli_connector_registry_integrity) and Settings' OFFICE_CLI_CONNECTORS.
 */
const CONNECTOR_IDS = ["lark", "dingtalk", "wecom"] as const
const PER_ID_KEYS = ["title", "desc", "toastInstalled", "toastConnected", "configHint", "authHint"] as const

describe("cli connector i18n completeness", () => {
  for (const lang of ["en", "zh-Hans", "zh-Hant"] as const) {
    it(`${lang}: every connector has all six cliConnector.<id>.* keys`, () => {
      const missing = CONNECTOR_IDS.flatMap((id) =>
        PER_ID_KEYS.filter((k) => !translations[lang][`cliConnector.${id}.${k}`]).map(
          (k) => `cliConnector.${id}.${k}`,
        ),
      )
      expect(missing).toEqual([])
    })
  }
})
