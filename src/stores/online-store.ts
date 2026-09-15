import { create } from "zustand"

/**
 * Connectivity state shared between the service layer (queue processor,
 * sync scheduler) and the UI (offline banner, task 6.8). Plain vanilla
 * zustand store: services read/set it imperatively via getState(), React
 * components subscribe with the useOnlineStore hook. `online` mirrors
 * navigator.onLine (default true when the API is unavailable, e.g. SSR or
 * tests without a window).
 */
interface OnlineState {
  online: boolean
  setOnline: (online: boolean) => void
}

export const useOnlineStore = create<OnlineState>((set) => ({
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  setOnline: (online) => set({ online }),
}))
