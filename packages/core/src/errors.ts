import type { CoreError, CoreErrorCode } from '@altrex/contracts'
import { ProviderFailure } from './gateway/request-executor'
import { CheckpointError } from './workspace/checkpoints'
import { IllegalTransitionError } from './orchestrator/transitions'

/** A command failure with a contract error code. Thrown by command handlers for expected conditions. */
export class CoreCommandError extends Error {
  constructor(readonly code: CoreErrorCode, message: string, readonly retryable = false, readonly detail?: string) {
    super(message)
    this.name = 'CoreCommandError'
  }
}

const CHECKPOINT_CODES: Record<CheckpointError['code'], CoreErrorCode> = { NOT_FOUND: 'NOT_FOUND', TOO_LARGE: 'CHECKPOINT_TOO_LARGE', NOT_FINALIZED: 'CHECKPOINT_NOT_FINALIZED', CORRUPT: 'CHECKPOINT_CORRUPT' }

/** Map any thrown value to the contract error model. Messages are user-facing; secrets never appear in them. */
export function toCoreError(error: unknown): CoreError {
  const bounded = (message: string) => message.slice(0, 4000)
  if (error instanceof CoreCommandError) return { code: error.code, message: bounded(error.message), retryable: error.retryable, ...(error.detail ? { detail: error.detail.slice(0, 2000) } : {}) }
  if (error instanceof CheckpointError) return { code: CHECKPOINT_CODES[error.code], message: bounded(error.message), retryable: false }
  if (error instanceof ProviderFailure) return { code: 'PROVIDER_ERROR', message: bounded(error.message), retryable: error.retryable, detail: error.category }
  if (error instanceof IllegalTransitionError) return { code: 'CONFLICT', message: bounded(error.message), retryable: false }
  if (isValidationError(error)) {
    const paths = error.issues.slice(0, 10).map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')
    return { code: 'INVALID_REQUEST', message: 'The request does not match the contract.', retryable: false, detail: paths.slice(0, 2000) }
  }
  if (error instanceof Error && (error.name === 'AbortError' || /aborted|cancelled/i.test(error.name))) return { code: 'CANCELLED', message: bounded(error.message || 'Cancelled.'), retryable: false }
  return { code: 'INTERNAL', message: bounded(error instanceof Error ? error.message : 'The command failed.'), retryable: false }
}

function isValidationError(error: unknown): error is { issues: Array<{ path: PropertyKey[]; message: string }> } {
  return typeof error === 'object' && error !== null && Array.isArray((error as { issues?: unknown }).issues) && /ZodError/.test((error as { name?: string }).name ?? (error as object).constructor?.name ?? '')
}
