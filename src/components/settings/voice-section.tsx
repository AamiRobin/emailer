import { useEffect, useState, useSyncExternalStore } from "react"
import { formatDistanceToNow, fromUnixTime } from "date-fns"
import { Loader2, RefreshCw, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getExecutor } from "@/services/db/executor"
import { isAiConfigured } from "@/services/ai/settings"
import {
  deleteVoiceProfile,
  getVoiceProfile,
  learnWritingVoiceProfile,
  MIN_SENT_SAMPLES,
  countSentMessages,
  type VoiceProfileEnvelope,
} from "@/services/ai/voice-profile"
import {
  cancelWhisperModelDownload,
  downloadWhisperModel,
  getWhisperDownloadSnapshot,
  getWhisperModelDir,
  subscribeWhisperDownload,
  whisperModelPresent,
  WHISPER_TOTAL_BYTES,
} from "@/services/voice/model"
import {
  DICTATION_LANGUAGES,
  getDictationLanguage,
  setDictationLanguage,
} from "@/services/voice/settings"

/**
 * Settings → AI "Voice" block (parity-round-3 tasks 7.2/7.3, spec
 * ai-assistance "Voice dictation in the composer" + "Writing voice
 * profile", design D3): a SELF-CONTAINED block — the same shape the
 * semantic-search section landed as — covering
 *
 * - Dictation: the whisper model's first-use download (size stated
 *   before, progress, cancel) and the explicit transcription-language
 *   picker (auto-detect default; the composer reads the value at
 *   transcribe time). Audio is processed locally and never uploaded.
 * - Writing voice: the ONE-call profile learner on the voiceProfile
 *   surface (Learn disabled without a configured provider or enough sent
 *   mail), the stored profile's review display, refresh and delete —
 *   every action an explicit user click (spec: learning MUST NOT run
 *   without one).
 *
 * Inserted ONCE in ai-section.tsx, beside the semantic-search section.
 */

/** Rough human size for the consent copy (decimal MB — the same "~148
 * MB" number the model catalog and design D3 state). */
function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

/** Human copy for a typed learn failure (the WritingStyleBlock voice). */
function learnFailureCopy(
  reason:
    | "not-configured"
    | "no-sent-mail"
    | "not-enough-mail"
    | "parse"
    | "provider"
): string {
  switch (reason) {
    case "not-configured":
      return "AI assistance is not configured."
    case "no-sent-mail":
      return "No sent messages were found to analyze."
    case "not-enough-mail":
      return `Not enough sent mail yet — at least ${MIN_SENT_SAMPLES} sent messages are needed.`
    case "parse":
      return "The writing voice could not be read from the model's reply. Try again."
    case "provider":
      return "The provider request failed."
  }
}

/** The picker's sentinel for auto-detect (Base UI Select values must be
 * non-empty; "" is the storage/whisper code and is mapped at the
 * persistence boundary). */
const AUTO_LANGUAGE = "auto"

export function VoiceSection() {
  // ---- Dictation: model + language ----
  const [modelPresent, setModelPresent] = useState<boolean | null>(null)
  const [starting, setStarting] = useState(false)
  const [language, setLanguage] = useState<string | null>(null)
  const download = useSyncExternalStore(
    subscribeWhisperDownload,
    getWhisperDownloadSnapshot
  )

  // ---- Writing voice ----
  const [aiReady, setAiReady] = useState<boolean | null>(null)
  const [sentCount, setSentCount] = useState<number | null>(null)
  const [profile, setProfile] = useState<VoiceProfileEnvelope | null>(null)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [learning, setLearning] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null
  )

  const downloadSettled =
    download.state === "completed" || download.state === "cancelled"

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const executor = getExecutor()
        const [present, configured, count, stored, storedLanguage] =
          await Promise.all([
            whisperModelPresent(executor),
            isAiConfigured(executor),
            countSentMessages(executor),
            getVoiceProfile(executor),
            getDictationLanguage(executor),
          ])
        if (cancelled) return
        setModelPresent(present)
        setAiReady(configured)
        setSentCount(count)
        setProfile(stored)
        setProfileLoaded(true)
        setLanguage(storedLanguage)
      } catch (error) {
        console.warn("[settings] voice section state failed", error)
        if (!cancelled) {
          setModelPresent(false)
          setAiReady(false)
          setSentCount(0)
          setProfile(null)
          setProfileLoaded(true)
          setLanguage("")
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [downloadSettled])

  async function startDownload(): Promise<void> {
    setStarting(true)
    try {
      const modelDir = await getWhisperModelDir()
      await downloadWhisperModel(getExecutor(), modelDir)
      setModelPresent(await whisperModelPresent(getExecutor()))
    } catch (error) {
      // downloadWhisperModel already recorded the typed state; the
      // snapshot subscription renders it. Only unexpected errors land here.
      console.warn("[settings] whisper model download failed", error)
    } finally {
      setStarting(false)
    }
  }

  async function changeLanguage(value: string): Promise<void> {
    const previous = language ?? ""
    setLanguage(value)
    try {
      await setDictationLanguage(
        getExecutor(),
        value === AUTO_LANGUAGE ? "" : value
      )
    } catch (error) {
      setLanguage(previous)
      console.warn("[settings] failed to persist the dictation language", error)
    }
  }

  async function learn(): Promise<void> {
    if (learning) return
    setLearning(true)
    setNotice(null)
    try {
      const result = await learnWritingVoiceProfile(getExecutor())
      if (result.ok) {
        const stored = await getVoiceProfile(getExecutor())
        setProfile(stored)
        setNotice({
          ok: true,
          text: `Writing voice learned from ${result.messageCount} sent message${
            result.messageCount === 1 ? "" : "s"
          }.`,
        })
      } else {
        setNotice({
          ok: false,
          text:
            result.reason === "provider" && result.message
              ? `${learnFailureCopy(result.reason)} ${result.message}`
              : learnFailureCopy(result.reason),
        })
      }
    } catch (error) {
      console.warn("[settings] voice profile learn failed", error)
      setNotice({ ok: false, text: "Learning the writing voice failed." })
    } finally {
      setLearning(false)
    }
  }

  async function remove(): Promise<void> {
    try {
      await deleteVoiceProfile(getExecutor())
      setProfile(null)
      setNotice({ ok: true, text: "Writing-voice profile deleted." })
    } catch (error) {
      console.warn("[settings] voice profile delete failed", error)
    }
  }

  const loading = modelPresent === null || language === null
  const downloading = download.state === "downloading"
  const downloadPercent =
    downloading && download.total
      ? Math.min(100, Math.round((download.received / download.total) * 100))
      : null
  // The learn gate (spec: "with a configured AI provider and enough sent
  // mail"): both conditions visible as disabled-state copy.
  const learnDisabled =
    learning || aiReady !== true || (sentCount !== null && sentCount < MIN_SENT_SAMPLES)
  const learnDisabledCopy =
    aiReady === false
      ? "Connect and activate an AI provider first."
      : sentCount !== null && sentCount < MIN_SENT_SAMPLES
        ? `Needs at least ${MIN_SENT_SAMPLES} sent messages to learn from.`
        : null

  return (
    <div
      data-testid="voice-section"
      className="flex flex-col gap-2"
      aria-label="Voice"
    >
      {/* ---- Dictation ---- */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label>Dictation</Label>
          <p className="text-xs text-muted-foreground">
            The composer&apos;s mic turns speech into text entirely on this
            machine — a {formatBytes(WHISPER_TOTAL_BYTES)} speech model is
            downloaded once from Hugging Face and your voice is never
            uploaded.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Loading…
        </p>
      ) : modelPresent ? (
        <p
          data-testid="dictation-model-ready"
          className="text-xs text-muted-foreground"
        >
          Speech model downloaded ({formatBytes(WHISPER_TOTAL_BYTES)}).
        </p>
      ) : downloading ? (
        <div className="flex flex-col gap-1">
          <p
            data-testid="dictation-download-progress"
            role="status"
            className="text-xs text-muted-foreground"
          >
            Downloading model… {formatBytes(download.received)}
            {download.total !== null
              ? ` of ${formatBytes(download.total)}`
              : ""}
            {downloadPercent !== null ? ` (${downloadPercent}%)` : ""}
          </p>
          {downloadPercent !== null && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${downloadPercent}%` }}
              />
            </div>
          )}
          <div>
            <Button
              size="sm"
              variant="outline"
              data-testid="dictation-download-cancel"
              onClick={() => {
                void cancelWhisperModelDownload()
              }}
            >
              Cancel download
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {download.state === "failed" && (
            <p
              data-testid="dictation-download-error"
              role="alert"
              className="text-xs text-destructive"
            >
              The model download failed ({download.error ?? "unknown"}). You
              can retry.
            </p>
          )}
          {download.state === "cancelled" && (
            <p className="text-xs text-muted-foreground">
              Download cancelled — dictation stays unavailable until the
              model is downloaded.
            </p>
          )}
          <div>
            <Button
              size="sm"
              variant="outline"
              data-testid="dictation-download-start"
              disabled={starting}
              onClick={() => {
                void startDownload()
              }}
            >
              {starting ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Download speech model ({formatBytes(WHISPER_TOTAL_BYTES)})
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="dictation-language">Dictation language</Label>
        <Select
          value={(language ?? "") === "" ? AUTO_LANGUAGE : (language ?? "")}
          items={Object.fromEntries(
            DICTATION_LANGUAGES.map((option) => [
              option.code === "" ? AUTO_LANGUAGE : option.code,
              option.label,
            ])
          )}
          onValueChange={(value) => {
            void changeLanguage(String(value))
          }}
        >
          <SelectTrigger
            id="dictation-language"
            data-testid="dictation-language"
            className="w-56"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DICTATION_LANGUAGES.map((option) => (
              <SelectItem
                key={option.code || AUTO_LANGUAGE}
                value={option.code === "" ? AUTO_LANGUAGE : option.code}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Auto-detect lets the model recognize the spoken language; a fixed
          language pins transcription to it.
        </p>
      </div>

      {/* ---- Writing voice ---- */}
      <div className="flex items-start justify-between gap-4 pt-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            Writing voice
          </h3>
          <p className="text-xs text-muted-foreground">
            Learn how you typically write from your recent sent messages (up
            to 30) with one AI call — voiced drafts, proofreads and smart
            replies then follow your voice. Learning runs only when you
            click, and nothing about the messages is stored — only the
            distilled style.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            data-testid="voice-profile-learn"
            disabled={learnDisabled}
            title={learnDisabledCopy ?? undefined}
            onClick={() => {
              void learn()
            }}
          >
            {learning ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw aria-hidden />
            )}
            {profile ? "Refresh" : "Learn my writing voice"}
          </Button>
          {profile ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="voice-profile-delete"
              disabled={learning}
              aria-label="Delete writing-voice profile"
              onClick={() => {
                void remove()
              }}
            >
              <Trash2 aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>

      {!profileLoaded ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : profile ? (
        <>
          <p
            data-testid="voice-profile-status"
            className="text-sm text-foreground"
          >
            Learned {formatDistanceToNow(fromUnixTime(profile.learnedAt), {
              addSuffix: true,
            })}{" "}
            · {profile.messageCount} message
            {profile.messageCount === 1 ? "" : "s"}
          </p>
          <div
            data-testid="voice-profile-display"
            className="flex flex-col gap-1 rounded-md border p-3"
          >
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">{profile.profile.tone}</Badge>
              <Badge variant="outline">{profile.profile.formality}</Badge>
              <Badge variant="outline">{profile.profile.length}</Badge>
            </div>
            {profile.profile.vocabulary !== "" && (
              <p className="text-xs text-muted-foreground">
                Vocabulary: {profile.profile.vocabulary}
              </p>
            )}
            {profile.profile.greetingStyle !== "" && (
              <p className="text-xs text-muted-foreground">
                Opens: {profile.profile.greetingStyle}
              </p>
            )}
            {profile.profile.signoffStyle !== "" && (
              <p className="text-xs text-muted-foreground">
                Closes: {profile.profile.signoffStyle}
              </p>
            )}
            {profile.profile.quirks.length > 0 && (
              <ul className="list-disc ps-5 text-xs text-muted-foreground">
                {profile.profile.quirks.map((quirk) => (
                  <li key={quirk}>{quirk}</li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <p data-testid="voice-profile-status" className="text-sm text-foreground">
          {sentCount !== null && sentCount > 0
            ? `No writing voice learned yet — ${sentCount} sent message${
                sentCount === 1 ? "" : "s"
              } available.`
            : "No writing voice learned yet."}
        </p>
      )}

      {notice !== null && (
        <p
          data-testid="voice-profile-notice"
          role={notice.ok ? "status" : "alert"}
          className={
            notice.ok
              ? "text-xs text-muted-foreground"
              : "text-xs text-destructive"
          }
        >
          {notice.text}
        </p>
      )}
    </div>
  )
}
