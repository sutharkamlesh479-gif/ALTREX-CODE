// IPC channel names for the core bridge. Deliberately free of runtime dependencies so the
// sandboxed preload can import it without bundling schema code.
export const coreChannels = {
  /** main → renderer push: one validated AltrexEvent per message */
  event: 'core:event',
  /** renderer → main invoke: (name: CommandName, request: unknown) → response */
  command: 'core:command',
} as const

/** Name of the global the preload exposes: `window.altrexCore`. */
export const CORE_BRIDGE_GLOBAL = 'altrexCore' as const
