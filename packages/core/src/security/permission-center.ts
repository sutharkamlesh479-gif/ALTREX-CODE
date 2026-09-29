import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { EventBus } from '../events/event-bus'
import type { ProjectToolOptions, ToolEvent } from '../tools/project-tools'
import { ApprovalBroker, type ApprovalRequest } from './approvals'
import { PERMISSION_PROFILES, type PermissionProfile } from './policy'

const MAX_CHUNK = 8192

function projectKey(path: string): string {
  let value: string
  try { value = realpathSync.native(path) } catch { value = resolve(path) }
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * Per-process permission state: project profiles (persisted, chosen by the user only), the approval broker,
 * and the mapping of tool activity to contract events (permission.*, tool.denied, command.*).
 */
export class PermissionCenter {
  readonly approvals: ApprovalBroker
  private profiles: Record<string, PermissionProfile> = {}

  constructor(private readonly storePath: string | null, private readonly events?: EventBus) {
    this.approvals = new ApprovalBroker({
      onRequired: request => this.events?.publish('permission.required', this.view(request), request.taskId),
      onResolved: (request, outcome) => this.events?.publish('permission.resolved', { approvalId: request.approvalId, decision: outcome.decision, scope: outcome.scope, by: outcome.by, note: outcome.note }, request.taskId),
    })
    if (storePath) {
      try {
        const saved = JSON.parse(readFileSync(storePath, 'utf8')) as { profiles?: Record<string, unknown> }
        for (const [key, value] of Object.entries(saved.profiles ?? {})) if (PERMISSION_PROFILES.includes(value as PermissionProfile)) this.profiles[key] = value as PermissionProfile
      } catch { /* no saved profiles: every project is `standard` */ }
    }
  }

  profileFor(projectPath: string): PermissionProfile {
    return this.profiles[projectKey(projectPath)] ?? 'standard'
  }

  setProfile(projectPath: string, profile: PermissionProfile): PermissionProfile {
    const key = projectKey(projectPath)
    if (profile === 'standard') delete this.profiles[key]
    else this.profiles[key] = profile
    if (this.storePath) {
      mkdirSync(dirname(this.storePath), { recursive: true })
      writeFileSync(this.storePath, JSON.stringify({ version: 1, profiles: this.profiles }, null, 2), { mode: 0o600 })
    }
    return profile
  }

  /** Tool options for one task in one project: profile, approvals and event mapping. */
  toolOptions(taskId: string, projectPath: string, extra: Pick<ProjectToolOptions, 'repo'> = {}): ProjectToolOptions {
    return { ...extra, profile: this.profileFor(projectPath), approvals: this.approvals, taskId, onEvent: event => this.publishToolEvent(event, taskId) }
  }

  endTask(taskId: string): void { this.approvals.endTask(taskId) }

  pending() { return this.approvals.list().map(request => this.view(request)) }

  private view(request: ApprovalRequest) {
    return { ...request, summary: request.summary.slice(0, 2000), ...(request.agentReason === undefined ? {} : { agentReason: request.agentReason.slice(0, 2000) }) }
  }

  private publishToolEvent(event: ToolEvent, taskId: string): void {
    const bus = this.events
    if (!bus) return
    switch (event.type) {
      case 'command.output':
        for (let offset = 0; offset < event.text.length; offset += MAX_CHUNK) bus.publish('command.output', { commandId: event.commandId, stream: event.stream, text: event.text.slice(offset, offset + MAX_CHUNK) }, taskId)
        return
      case 'command.started': bus.publish('command.started', { commandId: event.commandId, command: event.command }, taskId); return
      case 'command.completed': bus.publish('command.completed', { commandId: event.commandId, command: event.command, exitCode: event.exitCode, timedOut: event.timedOut, durationMs: Math.max(0, Math.round(event.durationMs)) }, taskId); return
      case 'tool.denied': bus.publish('tool.denied', { tool: event.tool, summary: event.summary.slice(0, 2000), risk: event.risk, reason: event.reason }, taskId)
    }
  }
}
