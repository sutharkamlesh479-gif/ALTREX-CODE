import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './v4/App'

const root = document.getElementById('root')
if (root === null) throw new Error('ALTREX renderer root is missing')

async function mount() {
  // Explicit development-only opt-in. The fake is eliminated from production bundles.
  const demo = import.meta.env.DEV && new URLSearchParams(location.search).get('demo') === '1' && !window.altrexCore
  const core = demo ? new (await import('@altrex/contracts/fake-core')).FakeCore({ delayMs: 220 }) : window.altrexCore
  createRoot(root!).render(<StrictMode><App core={core} demo={demo} /></StrictMode>)
}
void mount()

