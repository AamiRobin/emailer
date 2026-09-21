import { ShieldCheck, ShieldQuestionMark, ShieldX } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  parseStoredAuthResults,
  type AuthVerdict,
} from "@/services/email/auth-results"

/**
 * AuthBadge (task 2.2, design D10): the compact SPF/DKIM/DMARC verdict
 * badge in the message header. Reads the messages.auth_results column
 * THROUGH parseStoredAuthResults (one module owns the storage format) and
 * renders one micro-chip per mechanism the stored string carries, in
 * fixed order — pass tinted success-green, fail destructive, none neutral
 * (the token palette already used by the signature/attachment banners).
 * Null/absent data renders NOTHING at all — the spec's explicit "no
 * headers → no badge" contract, never a failure.
 */

/** The fixed display order and label of the three mechanisms. */
const MECHANISM_LABELS = {
  spf: "SPF",
  dkim: "DKIM",
  dmarc: "DMARC",
} as const

/** Chip icon/tint per verdict — muted variants so the badge informs
 * without interrupting reading (the phishing banner is the loud path). */
const VERDICT_CHIP: Record<
  AuthVerdict,
  { Icon: typeof ShieldCheck; className: string }
> = {
  pass: {
    Icon: ShieldCheck,
    className:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-500",
  },
  fail: {
    Icon: ShieldX,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  none: {
    Icon: ShieldQuestionMark,
    className: "border-border bg-muted/50 text-muted-foreground",
  },
}

export function AuthBadge({ authResults }: { authResults: string | null }) {
  const parsed = parseStoredAuthResults(authResults)
  if (!parsed) return null

  const mechanisms = (["spf", "dkim", "dmarc"] as const).filter(
    (mechanism) => parsed[mechanism] !== undefined
  )

  return (
    <div
      data-testid="auth-badge"
      className="flex items-center gap-1"
      aria-label="Email authentication results"
    >
      {mechanisms.map((mechanism) => {
        const verdict = parsed[mechanism]!
        const { Icon, className } = VERDICT_CHIP[verdict]
        const label = `${MECHANISM_LABELS[mechanism]}: ${verdict}`
        return (
          <Badge
            key={mechanism}
            variant="outline"
            className={cn("shrink-0 gap-1", className)}
            data-testid={`auth-${mechanism}`}
            data-result={verdict}
            aria-label={label}
            title={label}
          >
            <Icon className="size-3" />
            {MECHANISM_LABELS[mechanism]}
          </Badge>
        )
      })}
    </div>
  )
}
