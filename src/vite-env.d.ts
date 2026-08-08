import type { LumenAPI } from '../electron/preload'

declare global {
  interface Window {
    lumen: LumenAPI
  }
}

export {}
