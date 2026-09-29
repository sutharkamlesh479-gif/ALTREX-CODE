import type { ContractVersion } from './version'
import type { AltrexEvent } from './events'
import type { CommandName, CommandRequest, CommandResponse } from './commands'
import type { CoreError } from './platform'

/** Result form of a command: never throws for command failures. */
export type CoreInvokeResult<N extends CommandName> = { ok: true; value: CommandResponse<N> } | { ok: false; error: CoreError }

/**
 * The API exposed to the renderer as `window.altrexCore` (separate from the legacy `window.altrex`).
 * The renderer must import only types from this package plus `channels`; never core.
 */
export type AltrexCoreBridge = {
  readonly contractVersion: ContractVersion
  /** Subscribe to live events. Returns an unsubscribe function. */
  onEvent(listener: (event: AltrexEvent) => void): () => void
  /**
   * Generic command invocation; validated in the main process. Rejects with an Error whose message is
   * `CODE: message` (see `CoreErrorCode`) — use `invokeResult` to receive the structured error instead.
   */
  invoke<N extends CommandName>(name: N, request: CommandRequest<N>): Promise<CommandResponse<N>>
  /** Like `invoke`, but resolves with `{ ok: false, error }` (code, message, retryable) instead of rejecting. */
  invokeResult<N extends CommandName>(name: N, request: CommandRequest<N>): Promise<CoreInvokeResult<N>>
}
