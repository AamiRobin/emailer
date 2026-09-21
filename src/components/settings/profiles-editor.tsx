import { useCallback, useEffect, useState } from "react"
import { CirclePlus, Loader2, Pencil, Trash2 } from "lucide-react"

import { DEFAULT_PROFILE_COLOR, PROFILE_COLORS } from "@/lib/profile-colors"
import { useAccountStore } from "@/stores/account-store"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  assignAccountToProfile,
  createProfile,
  deleteProfile,
  listAccountColorSources,
  listProfiles,
  setAccountColorOverride,
  updateProfile,
  type AccountProfileAssignment,
  type AccountProfileRow,
} from "@/services/db/account-profiles"
import { getExecutor } from "@/services/db/executor"
import { cn } from "@/lib/utils"

/**
 * Profiles editor (parity-round-2 task 4.4, accounts spec "Account
 * profiles and colors"): a sub-section of the settings Accounts section
 * managing the named account groups — create/rename/re-color a profile,
 * assign or unassign accounts, set a per-account color override, delete.
 * Delete KEEPS the accounts (they fall back to their individual or
 * generated colors — the service nulls their profile_id references) and
 * every path is a local SQLite write: profiles map to no provider object,
 * so servers are untouched by construction.
 *
 * Markup and dialog flow follow the section's existing patterns (the
 * snippets editor's add/edit dialog remounted fresh per open, the account
 * removal destructive confirm). The color choice is a small preset
 * palette — swatch buttons with aria-pressed, the accent-picker pattern —
 * stored as the hex string convention label.color uses (user content
 * rendered as-is, the data-derived-color exception).
 *
 * After every mutation the parent store's effective colors are refreshed
 * (reloadProfileColors), so the thread-list markers recolor reactively —
 * profiles never change the account rows themselves.
 */

type DialogTarget =
  | { mode: "add" }
  | { mode: "edit"; profile: AccountProfileRow }

/**
 * One round swatch button (the accent-picker pattern): aria-pressed for
 * the current choice, ring highlight when selected, aria-label naming the
 * choice so the control is screen-reader operable.
 */
function ColorSwatch({
  label,
  color,
  pressed,
  onPick,
  children,
}: {
  label: string
  /** The stored value this swatch writes (aria-pressed compares it). */
  color: string
  pressed: boolean
  onPick: (color: string) => void
  /** The visible dot (palette colors render their hex; the "profile
   * color" reset renders a neutral token dot). */
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        "rounded-full p-0.5",
        pressed && "ring-2 ring-ring ring-offset-2 ring-offset-background"
      )}
      onClick={() => onPick(color)}
    >
      {children}
    </button>
  )
}

function ProfileDialog({
  target,
  assignments,
  onOpenChange,
  onSaved,
}: {
  target: DialogTarget
  /** Snapshot of every account's assignment/override state at open. */
  assignments: AccountProfileAssignment[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const accounts = useAccountStore((state) => state.accounts)
  const editing = target.mode === "edit" ? target.profile : null
  const [name, setName] = useState(editing?.name ?? "")
  const [color, setColor] = useState(editing?.color ?? DEFAULT_PROFILE_COLOR)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // Per-account dialog state: membership in THIS profile, and the marker
  // override (null = inherit the profile color) for member accounts.
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      accounts.map((account) => [
        account.id,
        assignments.some(
          (entry) =>
            entry.account_id === account.id &&
            entry.profile_id === (editing?.id ?? "__none__")
        ),
      ])
    )
  )
  const [overrides, setOverrides] = useState<Record<string, string | null>>(
    () =>
      Object.fromEntries(
        assignments
          .filter((entry) => entry.profile_id === (editing?.id ?? "__none__"))
          .map((entry) => [entry.account_id, entry.color_override])
      )
  )

  const assignmentByAccountId = new Map(
    assignments.map((entry) => [entry.account_id, entry])
  )
  const canSave = name.trim() !== "" && !saving

  async function handleSave(): Promise<void> {
    if (!canSave) return
    setSaving(true)
    setErrorMessage(null)
    try {
      const executor = getExecutor()
      let targetId: string
      if (editing) {
        await updateProfile(executor, editing.id, {
          name: name.trim(),
          color,
        })
        targetId = editing.id
      } else {
        targetId = (
          await createProfile(executor, { name: name.trim(), color })
        ).id
      }
      // Apply the dialog's account edits. Membership: checked accounts
      // join this profile (moving from another one if needed), accounts
      // that belonged to this profile and are now unchecked leave it;
      // everyone else is untouched. Overrides: only member accounts are
      // written, so unchecking keeps an account's individual color.
      for (const account of accounts) {
        const current = assignmentByAccountId.get(account.id)
        const currentProfileId = current?.profile_id ?? null
        const isMember = checked[account.id] ?? false
        const desiredProfileId = isMember
          ? targetId
          : currentProfileId === targetId
            ? null
            : currentProfileId
        if (desiredProfileId !== currentProfileId) {
          await assignAccountToProfile(executor, account.id, desiredProfileId)
        }
        if (isMember) {
          const desiredOverride = overrides[account.id] ?? null
          if ((current?.color_override ?? null) !== desiredOverride) {
            await setAccountColorOverride(
              executor,
              account.id,
              desiredOverride
            )
          }
        }
      }
      onSaved()
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not save the profile."
      )
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Profile" : "Add Profile"}</DialogTitle>
          <DialogDescription>
            Profiles group accounts locally — renaming or deleting never
            touches the mail servers.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSave()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Work"
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label>Profile color</Label>
            <div
              role="group"
              aria-label="Profile color"
              className="flex items-center gap-1.5"
            >
              {PROFILE_COLORS.map((entry) => (
                <ColorSwatch
                  key={entry.id}
                  label={`Profile color: ${entry.label}`}
                  color={entry.value}
                  pressed={color === entry.value}
                  onPick={setColor}
                >
                  <span
                    aria-hidden
                    className="block size-6 rounded-full ring-1 ring-border"
                    style={{ backgroundColor: entry.value }}
                  />
                </ColorSwatch>
              ))}
            </div>
          </div>
          {accounts.length > 0 && (
            <div className="grid gap-2">
              <Label>Accounts</Label>
              <div className="flex flex-col gap-2.5">
                {accounts.map((account) => {
                  const isMember = checked[account.id] ?? false
                  const override = overrides[account.id] ?? null
                  return (
                    <div key={account.id} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`profile-account-${account.id}`}
                          checked={isMember}
                          onCheckedChange={(next) => {
                            setChecked((previous) => ({
                              ...previous,
                              [account.id]: next === true,
                            }))
                          }}
                        />
                        <Label
                          htmlFor={`profile-account-${account.id}`}
                          className="min-w-0 flex-1 truncate text-sm font-normal"
                        >
                          {account.email}
                        </Label>
                        {isMember && override && (
                          <span
                            aria-hidden
                            data-testid={`profile-override-dot-${account.id}`}
                            className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
                            style={{ backgroundColor: override }}
                          />
                        )}
                      </div>
                      {isMember && (
                        <div
                          role="group"
                          aria-label={`Marker color for ${account.email}`}
                          className="ms-6 flex flex-wrap items-center gap-1"
                        >
                          <ColorSwatch
                            label={`${account.email} marker: profile color`}
                            color="__inherit__"
                            pressed={override === null}
                            onPick={() =>
                              setOverrides((previous) => ({
                                ...previous,
                                [account.id]: null,
                              }))
                            }
                          >
                            <span
                              aria-hidden
                              className="block size-4 rounded-full bg-muted-foreground/40"
                            />
                          </ColorSwatch>
                          {PROFILE_COLORS.map((entry) => (
                            <ColorSwatch
                              key={entry.id}
                              label={`${account.email} marker: ${entry.label}`}
                              color={entry.value}
                              pressed={override === entry.value}
                              onPick={(picked) =>
                                setOverrides((previous) => ({
                                  ...previous,
                                  [account.id]: picked,
                                }))
                              }
                            >
                              <span
                                aria-hidden
                                className="block size-4 rounded-full ring-1 ring-border"
                                style={{ backgroundColor: entry.value }}
                              />
                            </ColorSwatch>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving && (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              )}
              {editing ? "Save Changes" : "Create Profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteProfileDialog({
  profile,
  onOpenChange,
  onDeleted,
}: {
  profile: AccountProfileRow
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  async function handleConfirm(): Promise<void> {
    setDeleting(true)
    try {
      await deleteProfile(getExecutor(), profile.id)
      onDeleted()
      onOpenChange(false)
    } catch (error) {
      console.warn("[settings] failed to delete profile", error)
      setDeleting(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete profile</DialogTitle>
          <DialogDescription>
            Delete{" "}
            <span className="font-medium text-foreground">{profile.name}</span>
            ? Its accounts keep working with their individual colors — only
            the local grouping is removed. Nothing changes on the mail
            servers. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              void handleConfirm()
            }}
            disabled={deleting}
          >
            {deleting && (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            )}
            Delete profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ProfilesEditor() {
  const accounts = useAccountStore((state) => state.accounts)
  const [profiles, setProfiles] = useState<AccountProfileRow[]>([])
  const [assignments, setAssignments] = useState<AccountProfileAssignment[]>([])
  const [dialog, setDialog] = useState<DialogTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AccountProfileRow | null>(
    null
  )

  const reload = useCallback(() => {
    try {
      const executor = getExecutor()
      void Promise.all([
        listProfiles(executor),
        listAccountColorSources(executor),
      ])
        .then(async ([nextProfiles, nextAssignments]) => {
          setProfiles(nextProfiles)
          setAssignments(nextAssignments)
          // The account rows never change, but their effective colors
          // derive from profiles — refresh the store's map so the
          // thread-list markers recolor reactively (task 4.4's
          // effectiveColor seam).
          await useAccountStore.getState().refreshProfileColors()
        })
        .catch((error) => {
          console.warn("[settings] failed to load profiles", error)
        })
    } catch (error) {
      console.warn("[settings] failed to load profiles", error)
    }
  }, [])

  // The shell only mounts settings after bootstrap(), so the executor is
  // available (same assumption as the other sections).
  useEffect(reload, [reload])

  const accountEmailById = new Map(
    accounts.map((account) => [account.id, account.email])
  )

  return (
    <section aria-label="Account profiles" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Profiles</h3>
          <p className="text-xs text-muted-foreground">
            Group accounts (for example Work or Personal) and give each group
            a color for the cross-account list markers. Local only — the mail
            servers are never touched.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          data-testid="add-profile-button"
          onClick={() => setDialog({ mode: "add" })}
        >
          <CirclePlus />
          Add Profile
        </Button>
      </div>
      {profiles.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="profiles-empty">
          No profiles yet. Create one to color-code accounts across views.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {profiles.map((profile) => {
            const members = assignments.filter(
              (entry) => entry.profile_id === profile.id
            )
            const memberNames = members.map(
              (entry) => accountEmailById.get(entry.account_id) ?? "unknown"
            )
            return (
              <div
                key={profile.id}
                data-testid="settings-profile-row"
                data-profile-name={profile.name}
                className="flex items-center gap-3 py-2.5"
              >
                {/* Data-derived color exception (label.color convention):
                    user content from the DB rendered as-is. */}
                <span
                  aria-hidden
                  data-testid="settings-profile-swatch"
                  className="size-3 shrink-0 rounded-full ring-1 ring-border"
                  style={{ backgroundColor: profile.color }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {profile.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {memberNames.length > 0
                      ? memberNames.join(", ")
                      : "No accounts"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${profile.name}`}
                  onClick={() => setDialog({ mode: "edit", profile })}
                >
                  <Pencil />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${profile.name}`}
                  onClick={() => setDeleteTarget(profile)}
                >
                  <Trash2 />
                  Delete
                </Button>
              </div>
            )
          })}
        </div>
      )}
      {/* Remounted on every open so the form always starts fresh. */}
      {dialog && (
        <ProfileDialog
          key={dialog.mode === "edit" ? `edit-${dialog.profile.id}` : "add"}
          target={dialog}
          assignments={assignments}
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
          onSaved={reload}
        />
      )}
      {deleteTarget && (
        <DeleteProfileDialog
          key={`delete-${deleteTarget.id}`}
          profile={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null)
          }}
          onDeleted={reload}
        />
      )}
    </section>
  )
}
