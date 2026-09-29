import type { CommandCapability, Risk } from './command-classifier'

/**
 * Permission profiles (SECURITY_MODEL.md §4). Chosen per project by the user; agents cannot change them.
 *  - read_only:  LOW only (inspect, search, read).
 *  - standard:   LOW + MEDIUM (edit project files, run declared scripts/tests, install dependencies); HIGH asks.
 *  - autonomous: LOW + MEDIUM + HIGH.
 * FORBIDDEN is denied in every profile; the user performs those actions.
 */
export type PermissionProfile = 'read_only' | 'standard' | 'autonomous'
export const PERMISSION_PROFILES: readonly PermissionProfile[] = ['read_only', 'standard', 'autonomous']
export type ToolCapability = CommandCapability | 'fs.read' | 'fs.write' | 'fs.delete'
export type PolicyDecision = { action: 'allow' | 'ask' | 'deny'; risk: Risk; capability: ToolCapability; reason: string }

export function decide(profile: PermissionProfile, risk: Risk, capability: ToolCapability, reason: string): PolicyDecision {
  if (risk === 'FORBIDDEN') return { action: 'deny', risk, capability, reason }
  if (risk === 'LOW') return { action: 'allow', risk, capability, reason }
  if (profile === 'read_only') return { action: 'deny', risk, capability, reason: `${reason} (the project is read-only)` }
  if (risk === 'MEDIUM' || profile === 'autonomous') return { action: 'allow', risk, capability, reason }
  return { action: 'ask', risk, capability, reason }
}
