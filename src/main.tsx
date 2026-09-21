import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { initAccent } from "@/lib/accent"
import { isComposerPopoutWindow, isPopoutWindow } from "@/services/desktop/popout"

// Restore the persisted accent before mounting so the first paint is already
// tinted (accent switching lives in src/lib/accent.ts).
initAccent()

// Pop-out windows (task 1.9 + batch C2): every window loads this bundle;
// the Tauri label is the route. `popout-composer-<draftKey>` renders the
// composer pop-out surface; `popout-<threadId>` the single-thread surface;
// anything else is the mail shell. No hash router needed.
if (isPopoutWindow()) {
  if (isComposerPopoutWindow()) {
    void import("./components/composer/composer-popout").then(
      ({ ComposerPopoutApp }) => {
        createRoot(document.getElementById("root")!).render(
          <StrictMode>
            <ComposerPopoutApp />
          </StrictMode>
        )
      }
    )
  } else {
    void import("./components/popout/popout-app").then(({ PopoutApp }) => {
      createRoot(document.getElementById("root")!).render(
        <StrictMode>
          <PopoutApp />
        </StrictMode>
      )
    })
  }
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>
  )
}
