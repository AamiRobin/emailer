import { useRef, useState } from "react"
import {
  ArchiveRestore,
  HardDriveDownload,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  BackupError,
  exportBackup,
  inspectBackupArchive,
  pickBackupArchive,
  restoreBackup,
  UnsupportedManifestVersionError,
  type BackupManifestInfo,
  type MergeSummary,
  type RestoreMode,
  type RestoreResult,
} from "@/services/settings/backup"
import { RestoreCancelledError } from "@/services/settings/backup-merge"
import { formatStorageSize } from "@/services/settings/storage"

/**
 * Settings "Backup & restore" section (parity-round-3 task 5.5, design
 * D4). Two rows, structured like the neighboring Storage section:
 *
 * - Export: one button runs the whole pipeline (destination save dialog →
 *   secret-free VACUUM INTO snapshot → Rust tar+gz) via exportBackup()
 *   and reports where the archive landed. A failure is a typed error and
 *   never leaves a partial archive (Rust stages as `.part`).
 * - Restore: the file picker hands the archive to inspectBackupArchive
 *   FIRST — checksums verify and the manifest version gates here, so an
 *   unknown-format or corrupt file refuses before anything else happens.
 *   The dialog then offers the two spec'd behaviors: replace (with the
 *   explicit everything-on-this-device warning) and merge (whose copy
 *   says message bodies are NOT restored). A merge restore stays
 *   cancellable while it runs; the transaction rolls back.
 */

interface RestoreFailure {
  title: string
  detail?: string
}

/** Map the typed errors onto settings-UI copy (kinds are stable). */
function backupFailure(cause: unknown): RestoreFailure {
  if (cause instanceof UnsupportedManifestVersionError) {
    return { title: cause.message }
  }
  if (cause instanceof RestoreCancelledError) {
    return {
      title: "Restore cancelled",
      detail: cause.message,
    }
  }
  if (cause instanceof BackupError) {
    switch (cause.kind) {
      case "checksum_mismatch":
      case "corrupt_archive":
      case "missing_entry":
      case "bad_manifest":
        return {
          title: "This file is not a readable Emailer backup.",
          detail:
            "It may be damaged, incomplete or tampered with. Your existing data was not touched.",
        }
      case "io":
        return {
          title: "Emailer could not access that file.",
          detail: cause.message,
        }
    }
  }
  return {
    title: "The backup failed.",
    detail: cause instanceof Error ? cause.message : String(cause),
  }
}

function mergeSummaryLines(summary: MergeSummary): string[] {
  return [
    summary.accountsAdded === 1
      ? "1 account added"
      : `${summary.accountsAdded} accounts added`,
    ...(summary.accountsKept > 0
      ? [
          `${summary.accountsKept} existing account${
            summary.accountsKept === 1 ? "" : "s"
          } left as-is`,
        ]
      : []),
    ...(summary.profilesAdded > 0
      ? [`${summary.profilesAdded} profile(s)`]
      : []),
    ...(summary.rulesAdded > 0 ? [`${summary.rulesAdded} rule(s)`] : []),
    ...(summary.snippetsAdded > 0
      ? [`${summary.snippetsAdded} snippet(s)`]
      : []),
    ...(summary.savedSearchesAdded > 0
      ? [`${summary.savedSearchesAdded} saved search(es)`]
      : []),
    ...(summary.senderCategoriesAdded > 0
      ? [`${summary.senderCategoriesAdded} category override(s)`]
      : []),
    ...(summary.settingsAdded > 0
      ? [`${summary.settingsAdded} setting(s)`]
      : []),
  ]
}

/** The confirm dialog. Remounted per archive (keyed by the section), so
 * the mode choice and step always start fresh. */
function RestoreDialog({
  path,
  manifest,
  restoring,
  onOpenChange,
  onStart,
  onCancelRestore,
}: {
  path: string
  manifest: BackupManifestInfo
  restoring: boolean
  onOpenChange: (open: boolean) => void
  onStart: (mode: RestoreMode) => void
  onCancelRestore: () => void
}) {
  const [mode, setMode] = useState<RestoreMode>("replace")

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-testid="backup-restore-dialog">
        <DialogHeader>
          <DialogTitle>Restore from backup</DialogTitle>
          <DialogDescription>
            Verified archive — every checksum matched.
          </DialogDescription>
        </DialogHeader>

        <dl
          data-testid="backup-manifest-facts"
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
        >
          <dt className="text-muted-foreground">Format</dt>
          <dd className="text-foreground">v{manifest.version}</dd>
          {manifest.createdAt && (
            <>
              <dt className="text-muted-foreground">Exported</dt>
              <dd className="text-foreground">
                {new Date(manifest.createdAt).toLocaleString()}
              </dd>
            </>
          )}
          {manifest.appVersion && (
            <>
              <dt className="text-muted-foreground">Made with</dt>
              <dd className="text-foreground">
                Emailer {manifest.appVersion}
              </dd>
            </>
          )}
        </dl>

        <div className="grid gap-1.5">
          <Label htmlFor="backup-restore-mode">What should happen?</Label>
          <Select
            value={mode}
            onValueChange={(value) => setMode(value as RestoreMode)}
            disabled={restoring}
          >
            <SelectTrigger id="backup-restore-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="replace">
                Replace everything on this device
              </SelectItem>
              <SelectItem value="merge">
                Merge into my current data
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === "replace" ? (
          <p
            data-testid="backup-mode-warning"
            className="text-sm text-destructive"
          >
            Replacing deletes everything Emailer keeps on this device first —
            every account, message body, setting, profile and rule — and
            restores the backup in its place. Accounts from the backup carry
            no passwords or tokens: you will sign in to each one again before
            it syncs or sends. Your mail servers are not touched.
          </p>
        ) : (
          <p
            data-testid="backup-mode-warning"
            className="text-sm text-muted-foreground"
          >
            Merging adds what your current setup is missing — accounts are
            matched by email address, and existing entries stay as they are.
            Message bodies are NOT restored by a merge: they sync fresh from
            the server on each account's first sync. Restored accounts sign
            in again before syncing.
          </p>
        )}

        <DialogFooter>
          {restoring ? (
            <>
              <span
                className="mr-auto inline-flex items-center gap-2 text-sm text-muted-foreground"
                aria-live="polite"
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Restoring…
              </span>
              {mode === "merge" && (
                <Button
                  variant="outline"
                  data-testid="backup-cancel-restore"
                  onClick={onCancelRestore}
                >
                  Cancel restore
                </Button>
              )}
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="backup-cancel"
              >
                Cancel
              </Button>
              <Button
                variant={mode === "replace" ? "destructive" : "default"}
                data-testid="backup-start"
                onClick={() => onStart(mode)}
              >
                <ArchiveRestore />
                Restore {path.split("/").pop()?.split("\\").pop()}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type RestoreStep =
  | { kind: "idle" }
  | { kind: "inspecting" }
  | { kind: "confirming"; path: string; manifest: BackupManifestInfo }
  | {
      kind: "restoring"
      path: string
      manifest: BackupManifestInfo
      mode: RestoreMode
    }
  | { kind: "done"; result: RestoreResult }
  | { kind: "failed"; failure: RestoreFailure }

export function BackupSection() {
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<{
    path: string
    bytes: number
  } | null>(null)
  const [restore, setRestore] = useState<RestoreStep>({ kind: "idle" })
  // Merge restores run row-by-row inside one transaction; flipping this
  // flag makes the next check throw and the whole merge roll back.
  const cancelSignal = useRef({ aborted: false })

  async function handleExport(): Promise<void> {
    setExporting(true)
    setExported(null)
    try {
      const result = await exportBackup()
      if (result) {
        setExported({ path: result.path, bytes: result.bytes })
      }
    } catch (cause) {
      console.warn("[settings] backup export failed", cause)
      toast.error("Could not write the backup", {
        description: backupFailure(cause).title,
      })
    } finally {
      setExporting(false)
    }
  }

  async function handleRestorePick(): Promise<void> {
    const path = await pickBackupArchive()
    if (!path) return
    setExported(null)
    setRestore({ kind: "inspecting" })
    try {
      // The typed gate: checksums verify and the manifest version is
      // refused HERE, before the restore dialog even opens.
      const manifest = await inspectBackupArchive(path)
      setRestore({ kind: "confirming", path, manifest })
    } catch (cause) {
      console.warn("[settings] backup inspect failed", cause)
      setRestore({ kind: "failed", failure: backupFailure(cause) })
    }
  }

  async function handleStartRestore(mode: RestoreMode): Promise<void> {
    if (restore.kind !== "confirming") return
    const { path, manifest } = restore
    cancelSignal.current = { aborted: false }
    setRestore({ kind: "restoring", path, manifest, mode })
    try {
      const result = await restoreBackup(path, mode, {
        signal: cancelSignal.current,
      })
      setRestore({ kind: "done", result })
    } catch (cause) {
      console.warn("[settings] backup restore failed", cause)
      setRestore({ kind: "failed", failure: backupFailure(cause) })
    }
  }

  return (
    <section aria-label="Backup & restore" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Backup &amp; restore
        </h2>
        <p className="text-sm text-muted-foreground">
          Move your Emailer setup between machines with a single,
          checksummed archive file.
        </p>
      </div>

      <div className="flex items-center justify-between gap-6">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-medium text-foreground">Export</h3>
          <p className="text-xs text-muted-foreground">
            Writes your accounts' settings, profiles, rules, snippets, quick
            steps, signatures, saved searches, categories and a verified
            database snapshot — with synced mail — into one file. No
            passwords or tokens are ever included; each restored account
            signs in again.
          </p>
          {exported && (
            <p
              data-testid="backup-export-status"
              className="text-xs text-foreground"
              aria-live="polite"
            >
              Backed up to {exported.path} ({formatStorageSize(exported.bytes)}
              ).
            </p>
          )}
        </div>
        <Button
          size="sm"
          data-testid="backup-export"
          disabled={exporting}
          onClick={() => {
            void handleExport()
          }}
        >
          {exporting ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <HardDriveDownload />
          )}
          Export backup…
        </Button>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-6">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-medium text-foreground">Restore</h3>
          <p className="text-xs text-muted-foreground">
            Restore a backup file. Every checksum is verified before
            anything changes, and a failed or cancelled restore leaves your
            current data intact.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          data-testid="backup-restore"
          disabled={restore.kind === "inspecting"}
          onClick={() => {
            void handleRestorePick()
          }}
        >
          {restore.kind === "inspecting" ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <ArchiveRestore />
          )}
          Restore backup…
        </Button>
      </div>

      {restore.kind === "failed" && (
        <div role="alert" className="grid gap-0.5" data-testid="backup-error">
          <p className="text-sm text-destructive">{restore.failure.title}</p>
          {restore.failure.detail && (
            <p className="text-xs text-muted-foreground">
              {restore.failure.detail}
            </p>
          )}
        </div>
      )}

      {restore.kind === "done" && (
        <div
          data-testid="backup-result"
          className="grid gap-1"
          aria-live="polite"
        >
          {restore.result.mode === "replace" ? (
            <p className="text-sm text-foreground">
              {restore.result.accountsRequiringReauth === 1
                ? "1 account was restored."
                : `${restore.result.accountsRequiringReauth} accounts were restored.`}{" "}
              Sign in to each one to start syncing again — your restored mail
              is readable right now.
            </p>
          ) : (
            <>
              <p className="text-sm text-foreground">
                Restored: {mergeSummaryLines(restore.result.summary).join(", ")}.
              </p>
              <p className="text-xs text-muted-foreground">
                Message bodies are not part of a merge — each account
                downloads its mail again on first sync.
              </p>
            </>
          )}
        </div>
      )}

      {/* Mounted from the confirm step THROUGH the restore: one dialog
          instance keeps the mode choice and the manifest facts while the
          footer flips to the in-flight state. */}
      {(restore.kind === "confirming" || restore.kind === "restoring") && (
        <RestoreDialog
          key={restore.path}
          path={restore.path}
          manifest={restore.manifest}
          restoring={restore.kind === "restoring"}
          onOpenChange={(open) => {
            if (!open && restore.kind === "confirming") {
              setRestore({ kind: "idle" })
            }
          }}
          onStart={(mode) => {
            void handleStartRestore(mode)
          }}
          onCancelRestore={() => {
            cancelSignal.current.aborted = true
          }}
        />
      )}
    </section>
  )
}
