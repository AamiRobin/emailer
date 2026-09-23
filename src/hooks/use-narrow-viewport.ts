import * as React from "react"

// Breakpoint-parameterized sibling of the shadcn use-mobile hook (the
// reference pattern for responsive layout decisions — see ui/sidebar.tsx):
// matchMedia's edge-triggered "change" notification drives React through
// useSyncExternalStore, so consumers re-render only when the viewport
// actually crosses the threshold, instead of running a per-pixel resize
// listener that re-reads window.innerWidth on every tick.

// One shared subscription per breakpoint keeps the subscribe function
// referentially stable, so useSyncExternalStore never churns listeners.
const subscribeByBreakpoint = new Map<
  number,
  (onChange: () => void) => () => void
>()

function getSubscribe(breakpoint: number) {
  let subscribe = subscribeByBreakpoint.get(breakpoint)
  if (!subscribe) {
    subscribe = (onChange: () => void) => {
      const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    }
    subscribeByBreakpoint.set(breakpoint, subscribe)
  }
  return subscribe
}

/** True while the viewport is narrower than `breakpoint` pixels. */
export function useNarrowViewport(breakpoint: number): boolean {
  return React.useSyncExternalStore(
    getSubscribe(breakpoint),
    () => window.innerWidth < breakpoint,
    () => false
  )
}
