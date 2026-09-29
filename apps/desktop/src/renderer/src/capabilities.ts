import type { Mode } from './product'

export type CapabilityStatus = {
  available: boolean
  label: string
}

export function getModeCapability(mode: Mode): CapabilityStatus {
  if (mode === 'ASK') return { available: true, label: 'Read-only provider chat is available.' }
  if (mode === 'PLAN') return { available: false, label: 'Plan execution is scheduled for Milestone 4.' }
  if (mode === 'AGENT') return { available: true, label: 'Autonomous project editing and development commands are available.' }
  if (mode === 'LOCAL') return { available: true, label: 'Private local coding with Ollama and project tools is available.' }
  return { available: false, label: 'Real multi-agent execution is scheduled for Milestone 9.' }
}

export function formatPlatform(platform: NodeJS.Platform | undefined): string {
  if (platform === 'win32') return 'WINDOWS'
  if (platform === 'darwin') return 'MACOS'
  if (platform === 'linux') return 'LINUX'
  return 'WEB PREVIEW'
}
