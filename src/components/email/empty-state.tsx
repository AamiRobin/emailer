import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Shared informative empty state (task 6.9, mailbox-ui spec "First-run
 * and empty states"): an icon, a title line and an optional hint, with an
 * optional action row (welcome buttons). Used by the thread list for
 * empty folders / empty search results and by the first-run welcome
 * panel, so every "nothing here" surface in the list area reads and
 * behaves the same.
 */
interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  hint?: string
  actions?: ReactNode
  className?: string
  testId?: string
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  actions,
  className,
  testId = "empty-state",
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex h-full flex-col items-center justify-center gap-1.5 p-8 text-center",
        className
      )}
    >
      {Icon && (
        <Icon
          aria-hidden="true"
          className="mb-1 size-10 text-muted-foreground/50"
        />
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
      {actions && <div className="mt-3 flex items-center gap-2">{actions}</div>}
    </div>
  )
}
