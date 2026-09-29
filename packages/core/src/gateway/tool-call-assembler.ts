import type { ProviderToolCall } from '../tools/types'
import { ProviderFailure } from './request-executor'

export type ToolCallDelta = {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

type PartialCall = { id: string | undefined; name: string; args: string }

const malformed = (detail: string) =>
  new ProviderFailure('The model produced an invalid tool call.', 'invalid-request', false, 0, 0, undefined, 'TOOL_CALL_MALFORMED', detail)

/**
 * Reassembles tool calls from streamed deltas. Providers split a call across many chunks: the id and
 * name usually arrive first and the JSON arguments in fragments, sometimes several calls interleaved
 * by `index`. Nothing is released until the stream finishes; then every call is validated (known
 * name when tools were offered, arguments parse to a JSON object). A call is never partially executed.
 */
export class ToolCallAssembler {
  private readonly calls = new Map<number, PartialCall>()
  private lastIndex = -1

  add(delta: ToolCallDelta): void {
    let index = typeof delta.index === 'number' && Number.isInteger(delta.index) && delta.index >= 0 ? delta.index : undefined
    if (index === undefined) {
      // No index: a new id starts a new call; otherwise the fragment continues the latest call.
      const latest = this.calls.get(this.lastIndex)
      index = latest === undefined || (delta.id !== undefined && latest.id !== undefined && delta.id !== latest.id) ? this.calls.size : this.lastIndex
    }
    const call = this.calls.get(index) ?? { id: undefined, name: '', args: '' }
    if (delta.id && !call.id) call.id = delta.id
    const name = delta.function?.name
    // Names normally arrive once. Repeated full names are ignored; cumulative names replace; fragments append.
    if (name && name !== call.name) call.name = !call.name || name.startsWith(call.name) ? name : call.name + name
    if (typeof delta.function?.arguments === 'string') call.args += delta.function.arguments
    this.calls.set(index, call)
    this.lastIndex = index
  }

  get size(): number {
    return this.calls.size
  }

  /** Validate and return complete calls in index order. Throws TOOL_CALL_MALFORMED on any defect. */
  finish(offeredTools?: ReadonlySet<string>): ProviderToolCall[] {
    return [...this.calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => {
      if (!call.name) throw malformed(`Tool call ${index} has no function name.`)
      if (offeredTools && offeredTools.size && !offeredTools.has(call.name)) throw malformed(`Tool call ${index} names an unknown tool: ${call.name.slice(0, 80)}`)
      const text = call.args.trim() || '{}'
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { throw malformed(`Tool call ${index} (${call.name}) has incomplete or invalid JSON arguments (${text.length} characters).`) }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw malformed(`Tool call ${index} (${call.name}) arguments are not a JSON object.`)
      return { id: call.id ?? `call_${index}`, name: call.name, arguments: text }
    })
  }
}

/** Names of the function tools offered in an OpenAI-style `tools` array. */
export function offeredToolNames(tools: ReadonlyArray<unknown>): Set<string> {
  return new Set(tools.flatMap(tool => {
    const definition = typeof tool === 'object' && tool !== null ? (tool as { function?: { name?: unknown } }).function : undefined
    return typeof definition?.name === 'string' ? [definition.name] : []
  }))
}
