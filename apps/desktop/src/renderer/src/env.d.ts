/// <reference types="vite/client" />

import type { DesktopApi } from '../../shared/desktop-api'
import type { AltrexCoreBridge } from '@altrex/contracts'

declare global {
  interface Window {
    altrex?: DesktopApi
    /** Contract-v1 core bridge (events + commands). See packages/contracts/README.md. */
    altrexCore?: AltrexCoreBridge
  }
}

export {}

