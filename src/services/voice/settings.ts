import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"

/**
 * Dictation settings (parity-round-3 task 7.2, design D3): the explicit
 * transcription language, one settings-table row under
 * `voice.dictationLanguage` (the same single-row pattern as
 * `ai.outputLanguage` etc.). The picker lives in the settings voice
 * section; the dictation flow reads the value at TRANSCRIBE time (each
 * stop, not once per mount), so a change applies to the very next
 * utterance.
 *
 * `""` (the default) is auto-detect: whisper resolves the spoken
 * language itself and the result carries the detected code. Any other
 * value is an ISO-639-1 code from the curated list below (whisper's
 * multilingual ggml-base model supports these and dozens more — the
 * list is the UI's offering, not a model limit).
 */

export const DICTATION_LANGUAGE_KEY = "voice.dictationLanguage"

/** One language option: the code sent to whisper ("" = auto). */
export interface DictationLanguageOption {
  code: string
  label: string
}

/** The curated picker list (design D3: auto/en/es/de/fr/tr/zh…). */
export const DICTATION_LANGUAGES: readonly DictationLanguageOption[] = [
  { code: "", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "tr", label: "Turkish" },
  { code: "zh", label: "Chinese" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
]

/**
 * The stored dictation language, or "" (auto-detect) when unset — every
 * malformed/unknown stored value fails toward auto, so dictation always
 * works even with a hand-edited row.
 */
export async function getDictationLanguage(
  executor: SqlExecutor
): Promise<string> {
  const stored = await getSetting<unknown>(executor, DICTATION_LANGUAGE_KEY, "")
  if (typeof stored !== "string") return ""
  const trimmed = stored.trim().toLowerCase()
  return DICTATION_LANGUAGES.some((option) => option.code === trimmed)
    ? trimmed
    : ""
}

/** Persist the dictation language ("" = auto-detect). Unknown codes are
 * ignored — the picker only ever offers known ones. */
export async function setDictationLanguage(
  executor: SqlExecutor,
  language: string
): Promise<void> {
  const trimmed = language.trim().toLowerCase()
  if (!DICTATION_LANGUAGES.some((option) => option.code === trimmed)) return
  await setSetting(executor, DICTATION_LANGUAGE_KEY, trimmed)
}
