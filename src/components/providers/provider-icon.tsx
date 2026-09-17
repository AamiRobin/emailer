import type { ComponentPropsWithoutRef } from "react"
import { Server } from "lucide-react"

import { cn } from "@/lib/utils"
import { BRAND_GLYPHS, PROVIDER_BRANDS } from "./provider-brands"
import type { ProviderBrandId } from "@/services/account-flows"

interface ProviderIconProps
  extends Omit<ComponentPropsWithoutRef<"svg">, "viewBox"> {
  /** Detected brand, or null for the generic server glyph. */
  provider: ProviderBrandId | null
}

/**
 * Provider brand glyph in the provider's color, sized via className
 * exactly like a lucide icon (`size-4`). The brand color is applied
 * inline, so it also survives parent color overrides (e.g. the palette's
 * muted item icons). Null renders lucide's neutral server mark. See
 * provider-brands.ts for the glyph provenance.
 */
export function ProviderIcon({
  provider,
  className,
  ...props
}: ProviderIconProps) {
  if (!provider) {
    return (
      <Server aria-hidden className={cn("text-muted-foreground", className)} />
    )
  }
  const brand = PROVIDER_BRANDS[provider]
  // Decorative by design: every placement pairs the glyph with the
  // provider's name in text, and role="img" + a label would bleed into
  // the accessible name of enclosing buttons (e.g. "Gmail Add Gmail").
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ color: brand.color }}
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d={BRAND_GLYPHS[provider]} />
    </svg>
  )
}
