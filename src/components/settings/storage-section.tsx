import { useCallback, useEffect, useState } from "react"
import { Loader2, RefreshCw, Trash2 } from "lucide-react"
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
import { Separator } from "@/components/ui/separator"
import {
  deleteAllLocalData,
  formatStorageSize,
  getStorageUsage,
  KIND_DESCRIPTIONS,
  KIND_LABELS,
  type StorageUsage,
} from "@/services/settings/storage"

/**
 * Settings "Storage" section (tasks 1.6/1.7, settings spec "Local
 * storage usage and reset", design D11): the per-kind usage breakdown
 * computed Rust-side by walking the app data/config dirs (no SQL
 * counting), a refresh action, the total, and the destructive
 * "Delete all local data" reset.
 *
 * The reset is a TWO-STEP dialog: the first step names exactly what is
 * removed and states that the mail servers are untouched; the second
 * step demands an explicit final confirmation. Only that second confirm
 * triggers the wipe (services/settings/storage.ts), which restarts the
 * app into first-run on success — the component just observes the
 * failure case (the process is gone before any success comes back).
 *
 * The `unreadableEntries` signal from the walk is surfaced as an
 * "approximate" note rather than hidden: a total that could not stat
 * some files must not present itself as exact.
 */

const REMOVED_ITEMS = [
  "every account's local mail — message bodies and their read states",
  "downloaded attachments",
  "the AI cache",
  "calendar and task data",
  "contacts",
  "preferences and settings",
  "sealed credential slots — you will be signed out of every account",
]

function DeleteAllDataDialog({
  deleting,
  onOpenChange,
  onConfirm,
}: {
  deleting: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  // Step 1 states the scope; step 2 is the explicit final confirm. The
  // dialog is mounted fresh for every open (keyed remount — the same
  // pattern as the rules' AddRuleDialog), so the step always starts at 1.
  const [confirmedOnce, setConfirmedOnce] = useState(false)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-testid="delete-all-data-dialog">
        {confirmedOnce ? (
          <>
            <DialogHeader>
              <DialogTitle>Are you absolutely sure?</DialogTitle>
              <DialogDescription>
                This cannot be undone. Everything listed will be removed
                from this device and Emailer will restart as if freshly
                installed. Your mail servers keep every message.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirmedOnce(false)}
                disabled={deleting}
              >
                Back
              </Button>
              <Button
                variant="destructive"
                data-testid="delete-all-data-confirm"
                disabled={deleting}
                onClick={onConfirm}
              >
                {deleting && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                )}
                Delete everything
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Delete all local data?</DialogTitle>
              <DialogDescription>
                This removes from THIS device, for every account:
              </DialogDescription>
            </DialogHeader>
            <ul
              data-testid="delete-all-data-scope"
              className="list-disc space-y-1 pl-5 text-sm text-foreground"
            >
              {REMOVED_ITEMS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              Your mail servers are not touched — every message stays on the
              server. After the reset Emailer restarts in its first-run
              state, and your mail syncs back down once you add your
              accounts again.
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                data-testid="delete-all-data-continue"
                onClick={() => setConfirmedOnce(true)}
              >
                Continue
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function StorageSection() {
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // All state updates land in promise callbacks — the initial load runs
  // from an effect, and no state may be set synchronously within it.
  const load = useCallback((): void => {
    getStorageUsage()
      .then((next) => {
        setUsage(next)
        setError(null)
      })
      .catch((cause) => {
        console.warn("[settings] failed to load storage usage", cause)
        setError(
          "Could not measure local storage. Check that the app was started from its desktop build and try again."
        )
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  // Refresh re-runs the walk with the in-flight state visible.
  const refresh = useCallback((): void => {
    setLoading(true)
    load()
  }, [load])

  // The shell only mounts settings after bootstrap(), so mounting is a
  // complete state; the refresh button re-runs the walk on demand.
  useEffect(() => {
    load()
  }, [load])

  async function handleDeleteAll(): Promise<void> {
    setDeleting(true)
    try {
      // On success the app relaunches — this never resolves.
      await deleteAllLocalData()
    } catch (cause) {
      console.warn("[settings] delete all local data failed", cause)
      setDeleting(false)
      setDeleteOpen(false)
      toast.error("Could not finish deleting local data", {
        description:
          "Some local data may already be gone. Your mail servers are untouched — restart Emailer and try again.",
      })
    }
  }

  return (
    <section aria-label="Storage" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">Storage</h2>
          <p className="text-sm text-muted-foreground">
            What Emailer keeps on this device.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          data-testid="storage-refresh"
          disabled={loading}
          onClick={() => {
            refresh()
          }}
        >
          {loading ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <RefreshCw />
          )}
          Refresh
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : loading && !usage ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Calculating…
        </p>
      ) : usage ? (
        <>
          <div className="divide-y divide-border" data-testid="storage-usage">
            {usage.kinds.map((kind) => (
              <div
                key={kind.kind}
                data-testid={`storage-kind-${kind.kind}`}
                className="flex items-center justify-between gap-6 py-3"
              >
                <div className="grid gap-0.5">
                  <p className="text-sm font-medium text-foreground">
                    {KIND_LABELS[kind.kind] ?? kind.kind}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {KIND_DESCRIPTIONS[kind.kind] ?? ""}
                  </p>
                </div>
                <p className="shrink-0 whitespace-nowrap pl-4 text-right text-sm tabular-nums text-foreground">
                  {formatStorageSize(kind.bytes)}
                </p>
              </div>
            ))}
            <div className="flex items-center justify-between gap-6 py-3">
              <p className="text-sm font-semibold text-foreground">Total</p>
              <p
                className="text-sm font-semibold tabular-nums text-foreground"
                data-testid="storage-total"
              >
                {formatStorageSize(usage.total)}
              </p>
            </div>
          </div>
          {usage.unreadableEntries > 0 && (
            <p className="text-xs text-muted-foreground">
              Some files could not be read, so these sizes are a lower bound.
            </p>
          )}
        </>
      ) : null}

      <Separator />

      <div className="flex items-center justify-between gap-6">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-medium text-foreground">
            Delete all local data
          </h3>
          <p className="text-xs text-muted-foreground">
            Remove everything Emailer keeps on this device and start over.
            Your mail servers are not touched.
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          data-testid="storage-delete-all"
          disabled={deleting}
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 />
          Delete all…
        </Button>
      </div>

      {/* Remounted on every open so the two-step flow always starts at
          the scope step (same pattern as the rules' AddRuleDialog). */}
      {deleteOpen && (
        <DeleteAllDataDialog
          key="delete-all-data"
          deleting={deleting}
          onOpenChange={(next) => {
            if (!deleting) setDeleteOpen(next)
          }}
          onConfirm={() => {
            void handleDeleteAll()
          }}
        />
      )}
    </section>
  )
}
