import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { createTaskFromEmail } from "@/components/layout/use-tasks"

/**
 * The "Create task" conversion dialog (task 5.7, tasks spec "Task from
 * email" — "confirms the prefilled title"): the one confirm step behind
 * BOTH conversion entries — the reading-pane toolbar button and the
 * thread context menu's Create task item. The title is prefilled from
 * the thread subject (editable — the spec's confirmation) and the notes
 * from the newest message's snippet, capped (buildTaskPrefill); the
 * caller computes the prefill so both entries stay identical.
 *
 * Confirming runs the shared createTaskFromEmail flow (use-tasks.ts):
 * a tasks-table row with origin "email" + the source back-links, the
 * "Task created" toast with the jump action, the section refresh — and
 * NOTHING else: the source thread's inbox state is never touched. The
 * dialog closes only on success, so a failed write keeps the input.
 * Mounted fresh per open (the BlockSenderDialog pattern), so the fields
 * always start at the caller's prefill.
 */
interface CreateTaskDialogProps {
  threadId: string
  /** The thread's OWNING account (provenance back-link). */
  accountId: string
  defaultTitle: string
  defaultNotes: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateTaskDialog({
  threadId,
  accountId,
  defaultTitle,
  defaultNotes,
  open,
  onOpenChange,
}: CreateTaskDialogProps) {
  const [title, setTitle] = useState(defaultTitle)
  const [notes, setNotes] = useState(defaultNotes ?? "")
  const [creating, setCreating] = useState(false)

  const create = (): void => {
    const trimmed = title.trim()
    if (trimmed === "" || creating) return
    setCreating(true)
    void createTaskFromEmail({
      threadId,
      accountId,
      title: trimmed,
      notes: notes.trim() === "" ? null : notes,
    })
      .then((task) => {
        if (task !== null) onOpenChange(false)
      })
      .finally(() => {
        setCreating(false)
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="create-task-dialog">
        <DialogHeader>
          <DialogTitle>Create task</DialogTitle>
          <DialogDescription>
            Creates a task linked to this message. The conversation stays in
            your inbox untouched.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="create-task-title">Title</Label>
            <Input
              id="create-task-title"
              data-testid="create-task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="create-task-notes">Notes (optional)</Label>
            <Textarea
              id="create-task-notes"
              data-testid="create-task-notes"
              value={notes}
              rows={3}
              placeholder="Add context from the message…"
              className="resize-y"
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="create-task-confirm"
            disabled={title.trim() === "" || creating}
            onClick={create}
          >
            Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
