import { useEffect, useRef, useState } from "react"
import { Download, Loader2, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  exportFolderAsMbox,
  importFiles,
  pickImportFiles,
  type ImportSummary,
  type MboxExportResult,
} from "@/services/data-portability"
import { getExecutor } from "@/services/db/executor"
import { listLabelsByAccount } from "@/services/db/labels"
import type { LabelRow } from "@/services/db/labels"
import { useAccountStore } from "@/stores/account-store"

/**
 * Settings "Import & export" section (task 19.4, data-portability spec).
 * Entry points for both directions of task 19.1–19.3:
 *
 * - Export: pick a folder/label of the chosen account and stream it to a
 *   single .mbox file (exportFolderAsMbox — read-only, progress + cancel
 *   between messages). Per-thread EML export has its own entry point in
 *   the thread context menu and is only referenced here.
 * - Import: pick .eml/.mbox files, choose an existing folder or type a
 *   new folder name (created through the label CRUD), optionally upload
 *   to the server, and run — the summary reports imported / skipped
 *   duplicates / per-file failures without ever aborting the batch.
 *
 * The jobs run through the data-portability service (Rust parsing behind
 * it), so this section only wires state: account + folder pickers, one
 * job at a time (the other controls disable while one runs), progress via
 * the service's onProgress, and cancel through an AbortController. The
 * account default follows the store's active account, like the switcher.
 */

/** Select sentinel for the "type a new folder name" import destination. */
const NEW_FOLDER = "__new__"

interface Progress {
  done: number
  total: number
}

export function DataPortabilitySection() {
  const accounts = useAccountStore((state) => state.accounts)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const [accountId, setAccountId] = useState(
    () => activeAccountId ?? accounts[0]?.id ?? ""
  )
  const [labels, setLabels] = useState<LabelRow[]>([])

  const [exportLabelId, setExportLabelId] = useState("")
  const [exportResult, setExportResult] = useState<MboxExportResult | null>(
    null
  )
  const [exportError, setExportError] = useState<string | null>(null)

  const [importPaths, setImportPaths] = useState<string[]>([])
  const [destination, setDestination] = useState(NEW_FOLDER)
  const [newFolderName, setNewFolderName] = useState("")
  const [uploadToServer, setUploadToServer] = useState(false)
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const [busy, setBusy] = useState<null | "export" | "import">(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Value→label maps for the closed triggers: Base UI can only resolve a
  // selected label from rendered items, and the popups render lazily, so
  // without these the closed selects show raw ids ("acc-mock-gmail").
  const accountItems = Object.fromEntries(
    accounts.map((candidate) => [candidate.id, candidate.email])
  )
  const folderItems = Object.fromEntries(
    labels.map((label) => [label.id, label.name])
  )

  // Labels of the selected account (the export folder set and the import
  // destination list — one row per folder, both providers).
  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    try {
      void listLabelsByAccount(getExecutor(), accountId)
        .then((rows) => {
          if (cancelled) return
          setLabels(rows)
          setExportLabelId((current) =>
            rows.some((row) => row.id === current)
              ? current
              : (rows[0]?.id ?? "")
          )
          setDestination((current) =>
            current === NEW_FOLDER || rows.some((row) => row.id === current)
              ? current
              : (rows[0]?.id ?? NEW_FOLDER)
          )
        })
        .catch((error) => {
          console.warn("[settings] failed to load the account's folders", error)
        })
    } catch (error) {
      console.warn("[settings] failed to load the account's folders", error)
    }
    return () => {
      cancelled = true
    }
  }, [accountId])

  function startJob(kind: "export" | "import"): AbortController {
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(kind)
    setProgress({ done: 0, total: 0 })
    setExportResult(null)
    setExportError(null)
    setImportSummary(null)
    setImportError(null)
    return controller
  }

  function finishJob(): void {
    setBusy(null)
    setProgress(null)
    abortRef.current = null
  }

  async function runExport(): Promise<void> {
    if (!exportLabelId) return
    const controller = startJob("export")
    try {
      const result = await exportFolderAsMbox(
        getExecutor(),
        accountId,
        { kind: "labelId", labelId: exportLabelId },
        {
          signal: controller.signal,
          onProgress: (done, total) => setProgress({ done, total }),
        }
      )
      setExportResult(result)
    } catch (error) {
      setExportResult(null)
      setExportError(error instanceof Error ? error.message : String(error))
    } finally {
      finishJob()
    }
  }

  async function runImport(): Promise<void> {
    if (importPaths.length === 0) return
    const resolvedDestination =
      destination === NEW_FOLDER
        ? { kind: "folderName" as const, name: newFolderName }
        : { kind: "folderId" as const, folderId: destination }
    const controller = startJob("import")
    try {
      const summary = await importFiles(getExecutor(), {
        accountId,
        destination: resolvedDestination,
        filePaths: importPaths,
        uploadToServer,
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setImportSummary(summary)
    } catch (error) {
      setImportSummary(null)
      setImportError(error instanceof Error ? error.message : String(error))
    } finally {
      finishJob()
    }
  }

  const account = accounts.find((candidate) => candidate.id === accountId)
  const newFolderInvalid =
    busy === null && destination === NEW_FOLDER && newFolderName.trim() === ""

  return (
    <section aria-label="Import and export" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Import &amp; export
        </h2>
        <p className="text-sm text-muted-foreground">
          Take mailbox data out in standard formats, or bring archives back in.
          Exports never modify anything; imports never change existing messages.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="data-portability-account">Account</Label>
        <Select
          value={accountId}
          items={accountItems}
          onValueChange={(value) => setAccountId(String(value))}
        >
          <SelectTrigger id="data-portability-account" className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Download className="size-4 text-muted-foreground" aria-hidden />
          <h3 className="text-sm font-semibold text-foreground">
            Export folder as mbox
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={exportLabelId}
            items={folderItems}
            onValueChange={(value) => setExportLabelId(String(value))}
          >
            <SelectTrigger
              aria-label="Folder to export"
              disabled={busy !== null}
              className="w-56"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {labels.map((label) => (
                <SelectItem key={label.id} value={label.id}>
                  {label.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => {
              void runExport()
            }}
            disabled={busy !== null || !exportLabelId}
          >
            {busy === "export" ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Download aria-hidden />
            )}
            Export…
          </Button>
          {busy === "export" && (
            <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
              Cancel
            </Button>
          )}
        </div>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {progress !== null && busy === "export"
            ? `Exporting… ${progress.done} / ${progress.total}`
            : null}
          {exportResult?.status === "complete"
            ? `Exported ${exportResult.messages} messages to ${exportResult.path}.`
            : null}
          {exportResult?.status === "cancelled"
            ? `Export cancelled — the partial file was removed (${exportResult.messages} messages were written).`
            : null}
          {exportError ? `Export failed: ${exportError}` : null}
        </p>
        <p className="text-xs text-muted-foreground">
          One RFC 4155 mbox per folder, importable by other mail clients.
          Exports are read-only. To export a single conversation, use
          &ldquo;Export as EML&rdquo; in the thread&apos;s context menu.
        </p>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Upload className="size-4 text-muted-foreground" aria-hidden />
          <h3 className="text-sm font-semibold text-foreground">
            Import EML / mbox
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              void pickImportFiles()
                .then((paths) => {
                  if (paths && paths.length > 0) setImportPaths(paths)
                })
                .catch((error) => {
                  console.warn("[settings] file picker failed", error)
                })
            }}
          >
            Choose files…
          </Button>
          {importPaths.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {importPaths.length} file{importPaths.length === 1 ? "" : "s"}:{" "}
              {importPaths.map(basename).join(", ")}
            </span>
          )}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="import-destination">Destination folder</Label>
          <Select
            value={destination}
            items={{ [NEW_FOLDER]: "New folder…", ...folderItems }}
            onValueChange={(value) => setDestination(String(value))}
          >
            <SelectTrigger
              id="import-destination"
              disabled={busy !== null}
              className="w-72"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_FOLDER}>New folder…</SelectItem>
              {labels.map((label) => (
                <SelectItem key={label.id} value={label.id}>
                  {label.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {destination === NEW_FOLDER && (
            <Input
              aria-label="New folder name"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              placeholder="Folder name"
              disabled={busy !== null}
              className="w-72"
            />
          )}
        </div>
        <div className="flex items-center justify-between gap-6">
          <div className="grid gap-0.5">
            <Label htmlFor="import-upload">Also upload to the server</Label>
            <p className="text-xs text-muted-foreground">
              Appends each imported message to the account (IMAP folder or Gmail
              label). Offline, the import still completes locally and the
              skipped uploads are reported.
            </p>
          </div>
          <Switch
            id="import-upload"
            checked={uploadToServer}
            disabled={busy !== null}
            onCheckedChange={(checked) => setUploadToServer(checked)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              void runImport()
            }}
            disabled={
              busy !== null ||
              importPaths.length === 0 ||
              newFolderInvalid ||
              !account
            }
          >
            {busy === "import" ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Upload aria-hidden />
            )}
            Import
          </Button>
          {busy === "import" && (
            <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
              Cancel
            </Button>
          )}
        </div>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {progress !== null && busy === "import"
            ? `Importing… ${progress.done} / ${progress.total}`
            : null}
          {importSummary ? <ImportSummaryView summary={importSummary} /> : null}
          {importError ? `Import failed: ${importError}` : null}
        </p>
        <p className="text-xs text-muted-foreground">
          Messages already present in the destination folder (same Message-ID)
          are skipped. Imported mail is marked read and never overwrites
          existing messages.
        </p>
      </div>
    </section>
  )
}

/** The batch outcome: totals plus one line per file with its failures. */
function ImportSummaryView({ summary }: { summary: ImportSummary }) {
  return (
    <span className="flex flex-col gap-1" data-testid="import-summary">
      <span>
        {summary.status === "cancelled" ? "Import cancelled. " : ""}
        Imported {summary.imported}, skipped {summary.skippedDuplicates}{" "}
        duplicate{summary.skippedDuplicates === 1 ? "" : "s"}, failed{" "}
        {summary.failed}
        {summary.uploadFailures > 0
          ? `, ${summary.uploadFailures} upload${summary.uploadFailures === 1 ? "" : "s"} failed (kept locally)`
          : ""}
        {summary.uploaded > 0 ? `, ${summary.uploaded} uploaded` : ""}.
      </span>
      {summary.files.flatMap((file) => [
        ...file.failed.map((failure) => (
          <span
            key={`${file.file}-f-${failure.index}`}
            className="text-destructive"
          >
            {basename(file.file)}: {failure.error}
          </span>
        )),
        ...file.uploadFailures.map((failure) => (
          <span
            key={`${file.file}-u-${failure.index}`}
            className="text-destructive"
          >
            {basename(file.file)}: upload failed — {failure.error}
          </span>
        )),
      ])}
    </span>
  )
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
