# UI Guide

Conventions for all UI work in this repo. Stack: React 19 + Vite + Tailwind 4 +
shadcn registry style `base-nova` (Base UI primitives, not Radix). Config lives
in `components.json` at the repo root; theme tokens live in `src/index.css`.

## 1. Adding components the official way

Always install primitives through the shadcn CLI:

```sh
bunx shadcn add <component>
```

The CLI reads `components.json` (style `base-nova`, base color `neutral`, CSS
`src/index.css`, lucide icons) and writes the primitive to
`src/components/ui/<component>.tsx`. It installs any missing npm dependencies
itself — never add them by hand unless the CLI says so.

If unsure a component exists, check with `bunx shadcn list @shadcn` (lists all
registry items) before reaching for third-party code.

Never hand-copy components from demos, tweakcn, shadcn docs examples, or other
repos. Vendored copies drift from the registry and skip the dependency wiring
the CLI performs. Verified workflow (Task 1.4): `bunx shadcn add scroll-area`
created exactly `src/components/ui/scroll-area.tsx` and touched nothing else.

## 2. Primitives vs composites

- `src/components/ui/` holds **unmodified registry primitives only**. Never
  customize, restyle, or extend them in place. If a primitive needs different
  behavior, wrap it — do not edit it. Re-running `bunx shadcn add` must always
  be safe.
- Feature-specific composites (thread row, account switcher, mail display,
  composer toolbar, …) live in their feature directory:
  `src/components/{layout,email,composer,search,settings,accounts,labels}`.
- Composites compose primitives and prefer thin wrappers (pass-through props +
  a `cn(...)` class override) over overriding or forking primitive internals.

## 3. Token-only styling

All color and visual styling references theme tokens through Tailwind
utilities: `bg-primary`, `text-muted-foreground`, `border-border`,
`bg-accent`, `ring-ring/50`, etc. Tokens are declared as CSS variables in
`src/index.css` and mapped to utilities via the `@theme inline` block there.

Banned everywhere **except** token definitions inside `src/index.css`:

- Hardcoded palette classes: `bg-zinc-500`, `text-gray-400`, …
- Arbitrary color values: `text-[#123456]`, `bg-[rgb(...)]`, inline
  `style={{ color: ... }}` with literal colors.

Custom CSS is allowed only in three places:

1. Token variable sets in `src/index.css` (`:root`, `.dark`, accent blocks).
2. Small structural rules in `src/index.css` where no utility exists (e.g. the
   desktop scroll shell, `color-scheme` sync).
3. Styles inside the sandboxed email iframe — email HTML is third-party and
   style-isolated by design, so ordinary CSS is fine there.

## 4. Accent variants and base theme swaps

The theme is pure CSS variables in `src/index.css`: a Light set under `:root`
and a Dark set under `.dark`, currently a tweakcn-style neutral preset in
`oklch()`.

- **Add an accent variant**: append a `[data-accent="name"]` variable set that
  overrides `--primary`, `--primary-foreground`, and `--ring` (plus
  `--chart-1`…`--chart-5` if the accent tints charts) for both light and dark
  (e.g. a second `[data-accent="name"].dark` block or per-mode overrides).
  Apply `data-accent="name"` on `<html>`; components never change.
- **Swap the base theme**: replace the neutral token *values* in `src/index.css`
  only (`:root` and `.dark` sets, optionally the `@theme` radius scale). No
  component, primitive, or composite may be edited for a theme swap — everything
  reads the same token names.
