import { ProviderFailure } from './request-executor'

export type SseEvent = { event: string | null; data: string }

const MAX_PENDING_CHARACTERS = 1_000_000

/**
 * Incremental Server-Sent Events parser (WHATWG event-stream rules): accepts arbitrary chunk
 * boundaries, LF / CRLF / CR line endings, comment lines (keep-alives), multi-line `data:` fields,
 * and the optional space after the colon. Emits one event per blank-line terminated block.
 */
export class SseParser {
  private pending = ''
  private data: string[] = []
  private event: string | null = null

  push(chunk: string): SseEvent[] {
    this.pending += chunk
    const events: SseEvent[] = []
    let start = 0
    for (let index = 0; index < this.pending.length; index++) {
      const character = this.pending[index]
      if (character !== '\n' && character !== '\r') continue
      // A CR at the very end may be the first half of CRLF; wait for the next chunk.
      if (character === '\r' && index === this.pending.length - 1) break
      this.line(this.pending.slice(start, index), events)
      if (character === '\r' && this.pending[index + 1] === '\n') index++
      start = index + 1
    }
    this.pending = this.pending.slice(start)
    if (this.pending.length > MAX_PENDING_CHARACTERS) {
      throw new ProviderFailure('The provider sent a response ALTREX could not read.', 'invalid-request', true, 0, 0, undefined, 'STREAM_MALFORMED', 'A stream line exceeded 1,000,000 characters without a line break.')
    }
    return events
  }

  /** Flush at end of stream: dispatches a final event that lacked its terminating blank line. */
  end(): SseEvent[] {
    const events: SseEvent[] = []
    if (this.pending) { this.line(this.pending, events); this.pending = '' }
    this.dispatch(events)
    return events
  }

  private line(line: string, events: SseEvent[]): void {
    if (line === '') { this.dispatch(events); return }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    else if (field === 'event') this.event = value
  }

  private dispatch(events: SseEvent[]): void {
    if (this.data.length) events.push({ event: this.event, data: this.data.join('\n') })
    this.data = []
    this.event = null
  }
}
