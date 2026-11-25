// The card's own words, in the language magpie's interface is in.
//
// A usage window's name is data: magpie looks it up in its own word table
// ("Available", "Gift credits", "Credits", "5 hours") and shows anything else
// as it came, so a name a provider plugin invents stays in whatever language
// the plugin wrote it in. Rather than invent English rows, the card asks the
// interface's language first and writes its names in it: the plugin's own
// words beside magpie's, which is the only way a row magpie has no word for
// (a debt, money held) is said in the reader's language.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// magpie's own languages, and the words each uses for the wallet's rows.
export const ROW_NAMES = {
  en: { bonus: "Gift credit", debt: "Debt", frozen: "Frozen", recharge: "Paid", available: "Available" },
  zh: { bonus: "赠金", debt: "欠费", frozen: "冻结", recharge: "付费", available: "可用" },
  "zh-TW": { bonus: "贈金", debt: "欠費", frozen: "凍結", recharge: "付費", available: "可用" },
  ja: { bonus: "ギフト", debt: "未払い", frozen: "凍結", recharge: "支払い済み", available: "利用可能" },
  de: { bonus: "Geschenkguthaben", debt: "Schulden", frozen: "Eingefroren", recharge: "Bezahlt", available: "Verfügbar" },
}

export const FALLBACK_LANGUAGE = "en"

/** A language tag -> the card's language: magpie's five, English for the rest. */
export function cardLanguage(tag) {
  const t = String(tag ?? "").trim().toLowerCase()
  if (t.startsWith("zh")) return /hant|tw|hk|mo/.test(t) ? "zh-TW" : "zh"
  if (t.startsWith("ja")) return "ja"
  if (t.startsWith("de")) return "de"
  return FALLBACK_LANGUAGE
}

/** The word a row's name is in that language, English where it has none. */
export function rowName(lang, key) {
  const words = ROW_NAMES[cardLanguage(lang)] ?? ROW_NAMES[FALLBACK_LANGUAGE]
  return words?.[key] ?? ROW_NAMES[FALLBACK_LANGUAGE][key] ?? key
}

/** The machine's own language, as the interface follows it (lang: "system"). */
export function systemLanguage() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || ""
  } catch {
    return ""
  }
}

/** Where magpie keeps its settings: MAGPIE_CONFIG_DIR, else the usual place. */
export function configDirs({ env = process.env, home = homedir() } = {}) {
  const dirs = []
  const named = String(env.MAGPIE_CONFIG_DIR ?? "").trim()
  if (named) dirs.push(named)
  const xdg = String(env.XDG_CONFIG_HOME ?? "").trim()
  if (xdg) dirs.push(join(xdg, "magpie"))
  dirs.push(join(home, ".config", "magpie"), join(home, "AppData", "Roaming", "magpie"))
  return dirs
}

// The lang magpie's settings name, "system" and a missing file aside.
async function settingLanguage({ readFileImpl, dirs }) {
  for (const dir of dirs) {
    try {
      const raw = await readFileImpl(join(dir, "settings.json"), "utf8")
      const setting = JSON.parse(raw)
      const lang = setting && typeof setting === "object" ? setting.lang : undefined
      const said = typeof lang === "string" ? lang.trim() : ""
      if (said && said !== "system") return said
    } catch {
      // no settings there, or none this plugin may read: the system's language
    }
  }
  return ""
}

/** The language magpie's interface is in: its setting, else the machine's. */
export async function uiLanguage({ readFileImpl = readFile, env = process.env, home = homedir() } = {}) {
  const dirs = configDirs({ env, home })
  const named = await settingLanguage({ readFileImpl, dirs })
  return cardLanguage(named || systemLanguage())
}
