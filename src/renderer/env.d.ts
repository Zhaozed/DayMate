// Augment the renderer's `window` with the typed `daymate` API that the preload
// exposes via contextBridge. The renderer only ever talks to this surface.
import type { DaymateApi } from '@shared/types'

declare global {
  interface Window {
    daymate: DaymateApi
  }
}

export {}
