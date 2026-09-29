import { uuidv7 } from '../util/uuid'
import type { Risk } from './command-classifier'
import type { ToolCapability } from './policy'

export type ApprovalScope = 'once' | 'task'
export type ApprovalRequest = {
  approvalId: string
  taskId: string | null
  tool: string
  /** What will happen, e.g. `npx create-vite app` or `delete src/old`. */
  summary: string
  risk: Risk
  capability: ToolCapability
  /** Classifier reason (never text written by the model). */
  reason: string
  /** Reason the agent gave, clearly labelled as agent-provided in any UI. */
  agentReason?: string
  requestedAt: string
}
export type ApprovalOutcome = { decision: 'approved' | 'denied'; scope: ApprovalScope; by: 'user' | 'policy' | 'task-grant'; note: string }

export type ApprovalHooks = {
  onRequired?: (request: ApprovalRequest) => void
  onResolved?: (request: ApprovalRequest, outcome: ApprovalOutcome) => void
}

/**
 * Human approval for HIGH-risk actions. A request waits for `respond()` from the UI. If no UI has declared
 * that it handles approvals (`setInteractive(true)`), requests are denied immediately with an explanation
 * rather than waiting forever or being approved silently. `task`-scoped grants cover the same capability
 * and summary for the rest of that task only.
 */
export class ApprovalBroker {
  private interactive = false
  private readonly pending = new Map<string, { request: ApprovalRequest; resolve: (outcome: ApprovalOutcome) => void }>()
  private readonly grants = new Set<string>()

  constructor(private readonly hooks: ApprovalHooks = {}) {}

  setInteractive(enabled: boolean): void {
    this.interactive = enabled
    if (!enabled) for (const id of [...this.pending.keys()]) this.settle(id, { decision: 'denied', scope: 'once', by: 'policy', note: 'Approvals were turned off before this request was answered.' })
  }
  isInteractive(): boolean { return this.interactive }

  list(): ApprovalRequest[] { return [...this.pending.values()].map(entry => entry.request) }

  async request(input: Omit<ApprovalRequest, 'approvalId' | 'requestedAt'>, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const grantKey = `${input.taskId}|${input.capability}|${input.summary}`
    const request: ApprovalRequest = { ...input, approvalId: uuidv7(), requestedAt: new Date().toISOString() }
    if (input.taskId && this.grants.has(grantKey)) {
      const outcome: ApprovalOutcome = { decision: 'approved', scope: 'task', by: 'task-grant', note: 'Approved earlier in this task.' }
      this.hooks.onResolved?.(request, outcome)
      return outcome
    }
    if (!this.interactive) {
      const outcome: ApprovalOutcome = { decision: 'denied', scope: 'once', by: 'policy', note: 'This action needs your approval, but no approval UI is connected. Allow it by switching the project to the Autonomous permission profile, or approve it from an ALTREX UI that supports approvals.' }
      this.hooks.onResolved?.(request, outcome)
      return outcome
    }
    return new Promise<ApprovalOutcome>(resolve => {
      this.pending.set(request.approvalId, { request, resolve: outcome => { if (outcome.decision === 'approved' && outcome.scope === 'task' && input.taskId) this.grants.add(grantKey); resolve(outcome) } })
      signal?.addEventListener('abort', () => this.settle(request.approvalId, { decision: 'denied', scope: 'once', by: 'policy', note: 'The task was cancelled.' }), { once: true })
      this.hooks.onRequired?.(request)
    })
  }

  /** Answer a pending request. Returns false if it is unknown or already answered (replay-safe). */
  respond(approvalId: string, decision: 'approve' | 'deny', scope: ApprovalScope = 'once'): boolean {
    return this.settle(approvalId, { decision: decision === 'approve' ? 'approved' : 'denied', scope, by: 'user', note: decision === 'approve' ? 'Approved by the user.' : 'Denied by the user.' })
  }

  /** Forget task-scoped grants when a task ends. */
  endTask(taskId: string): void {
    for (const key of [...this.grants]) if (key.startsWith(`${taskId}|`)) this.grants.delete(key)
    for (const [id, entry] of this.pending) if (entry.request.taskId === taskId) this.settle(id, { decision: 'denied', scope: 'once', by: 'policy', note: 'The task ended.' })
  }

  private settle(approvalId: string, outcome: ApprovalOutcome): boolean {
    const entry = this.pending.get(approvalId)
    if (!entry) return false
    this.pending.delete(approvalId)
    entry.resolve(outcome)
    this.hooks.onResolved?.(entry.request, outcome)
    return true
  }
}
