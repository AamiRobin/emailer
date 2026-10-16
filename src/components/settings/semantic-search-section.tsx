import { useEffect, useState, useSyncExternalStore } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  getSemanticIndexProgress,
  runSemanticIndexSlice,
  subscribeSemanticIndexProgress,
} from "@/services/embeddings/indexer"
import {
  attachBgeDownloadEvents,
  BGE_TOTAL_BYTES,
  cancelBgeModelDownload,
  downloadBgeModel,
  getBgeDownloadSnapshot,
  getBgeModelDir,
  modelFilesPresent,
  subscribeBgeDownload,
} from "@/services/embeddings/model"
import {
  getSemanticSearchSettings,
  setSemanticSearchEnabled,
} from "@/services/embeddings/settings"
import { getAccountIndexStatus } from "@/services/embeddings/loader"
import { useAccountStore } from "@/stores/account-store"
import { getExecutor } from "@/services/db/executor"

/**
 * Settings → AI "Semantic search" block (parity-round-3 task 6.5, spec
 * ai-assistance "Semantic thread index", design D1/D2): a SELF-CONTAINED
 * block — enable toggle → model size/consent copy → download progress +
 * cancel → index build progress — wired to the embeddings services (the
 * Rust `download_model` events land through the model module's snapshot;
 * the persisted `model_downloads` rows are written by that same module).
 *
 * Consent ordering (spec "Enablement and download"): the copy states the
 * model size (~127 MB) BEFORE any download starts, and the model is only
 * fetched while the feature is enabled — cancelling the download (or
 * turning the feature off) leaves current behavior intact: the assistant
 * simply keeps its keyword tools, no error anywhere.
 *
 * The index build progress reads the indexer's observable snapshot
 * (threads indexed / total); enabling kicks one immediate slice so the
 * numbers move without waiting for the next scheduler tick (the tick
 * keeps them going). The 50k-cap spill notice (task 6.3) surfaces here
 * for the active account.
 */

/** Rough human size for the consent copy (the exact byte counts live in
 * the model catalog). */
function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / (1024 * 1024)
  return `${Math.round(mb)} MB`
}

export function SemanticSearchSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null) // null = loading
  const [modelPresent, setModelPresent] = useState<boolean | null>(null)
  // The loaded spill count, keyed by the account it was loaded FOR (the
  // WritingStyleBlock pattern: the render derives stale keys as loading,
  // so the effect never needs a synchronous setState reset).
  const [spillFor, setSpillFor] = useState<{
    accountId: string
    spilled: number
  } | null>(null)
  const [starting, setStarting] = useState(false)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const download = useSyncExternalStore(
    subscribeBgeDownload,
    getBgeDownloadSnapshot
  )
  const progress = useSyncExternalStore(
    subscribeSemanticIndexProgress,
    getSemanticIndexProgress
  )

  // Whether the feature is on, as a plain value (the load effect's
  // dependency — complex expressions in dep arrays trip react-hooks).
  const enabledValue = enabled === true
  const downloadSettled =
    download.state === "completed" || download.state === "cancelled"

  // Load the persisted feature flag + model presence; re-read whenever
  // a download settles (files present flips) or the toggle flips.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const executor = getExecutor()
        const [settings, present] = await Promise.all([
          getSemanticSearchSettings(executor),
          modelFilesPresent(executor),
        ])
        if (cancelled) return
        setEnabled(settings.enabled)
        setModelPresent(present)
      } catch (error) {
        console.warn("[settings] semantic search state failed", error)
        if (!cancelled) {
          setEnabled(false)
          setModelPresent(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabledValue, downloadSettled])

  // The spill notice for the active account (task 6.3: oldest vectors
  // beyond the 50k cap are not loaded; the user deserves the line).
  useEffect(() => {
    if (!enabled || activeAccountId === null) return
    let cancelled = false
    void (async () => {
      try {
        const status = await getAccountIndexStatus(
          getExecutor(),
          activeAccountId
        )
        if (!cancelled) {
          setSpillFor({ accountId: activeAccountId, spilled: status?.spilled ?? 0 })
        }
      } catch {
        if (!cancelled) setSpillFor({ accountId: activeAccountId, spilled: 0 })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, activeAccountId, progress.indexed, progress.total])
  const spilled =
    enabled && spillFor?.accountId === activeAccountId ? spillFor.spilled : null

  async function changeEnabled(next: boolean): Promise<void> {
    const previous = enabled
    setEnabled(next) // optimistic, the row write below rarely fails
    try {
      await setSemanticSearchEnabled(getExecutor(), next)
      if (next) {
        // Kick one slice now; the scheduler's due job continues from
        // there every tick. Fire-and-forget — the progress subscription
        // below renders whatever it reports.
        setStarting(true)
        void runSemanticIndexSlice(getExecutor())
          .catch((error) => {
            console.warn("[settings] semantic index slice failed", error)
          })
          .finally(() => setStarting(false))
      }
    } catch (error) {
      setEnabled(previous)
      console.warn(
        "[settings] failed to persist the semantic search flag",
        error
      )
    }
  }

  async function startDownload(): Promise<void> {
    setStarting(true)
    try {
      const modelDir = await getBgeModelDir()
      const unlisten = await attachBgeDownloadEvents()
      try {
        await downloadBgeModel(getExecutor(), modelDir)
        setModelPresent(await modelFilesPresent(getExecutor()))
      } finally {
        unlisten()
      }
    } catch (error) {
      // downloadBgeModel already recorded the typed state; the snapshot
      // subscription renders it. Only unexpected errors land here.
      console.warn("[settings] semantic model download failed", error)
    } finally {
      setStarting(false)
    }
  }

  const loading = enabled === null || modelPresent === null
  const downloading = download.state === "downloading"
  const downloadPercent =
    downloading && download.total
      ? Math.min(100, Math.round((download.received / download.total) * 100))
      : null

  return (
    <div
      data-testid="semantic-search-section"
      className="flex flex-col gap-2"
      aria-label="Semantic search"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="semantic-search-enabled">Semantic search</Label>
          <p className="text-xs text-muted-foreground">
            Let the assistant also find threads by MEANING, not just exact
            words. Runs entirely on this machine: a{" "}
            {formatBytes(BGE_TOTAL_BYTES)} language model is downloaded
            once from Hugging Face and your mail is never sent anywhere by
            it.
          </p>
        </div>
        <Switch
          id="semantic-search-enabled"
          checked={enabled === true}
          disabled={loading || starting}
          onCheckedChange={(checked) => {
            void changeEnabled(checked)
          }}
        />
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Loading…
        </p>
      ) : enabled ? (
        <>
          {modelPresent ? (
            <p
              data-testid="semantic-model-ready"
              className="text-xs text-muted-foreground"
            >
              Model downloaded ({formatBytes(BGE_TOTAL_BYTES)}).
            </p>
          ) : downloading ? (
            <div className="flex flex-col gap-1">
              <p
                data-testid="semantic-download-progress"
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
                  data-testid="semantic-download-cancel"
                  onClick={() => {
                    void cancelBgeModelDownload()
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
                  data-testid="semantic-download-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  The model download failed ({download.error ?? "unknown"}).
                  You can retry.
                </p>
              )}
              {download.state === "cancelled" && (
                <p className="text-xs text-muted-foreground">
                  Download cancelled — semantic search stays off until the
                  model is downloaded.
                </p>
              )}
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="semantic-download-start"
                  disabled={starting}
                  onClick={() => {
                    void startDownload()
                  }}
                >
                  {starting ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : null}
                  Download model ({formatBytes(BGE_TOTAL_BYTES)})
                </Button>
              </div>
            </div>
          )}

          {/* Index build progress (threads indexed / total). */}
          <p
            data-testid="semantic-index-progress"
            className="text-xs text-muted-foreground"
          >
            {progress.running
              ? `Indexing your mail… ${progress.indexed} of ${progress.total} threads`
              : progress.total > 0
                ? `Indexed ${progress.indexed} of ${progress.total} threads` +
                  (progress.done ? " (up to date)" : "")
                : "No mail indexed yet."}
          </p>

          {spilled !== null && spilled > 0 && (
            <p
              data-testid="semantic-index-spill"
              className="text-xs text-amber-600 dark:text-amber-400"
            >
              This mailbox holds more than the in-memory limit — the{" "}
              {spilled.toLocaleString()} oldest threads are not part of
              semantic results.
            </p>
          )}
        </>
      ) : null}
    </div>
  )
}
