import { CONTRACT_VERSION, eventPayloadSchemas, type AltrexEvent, type EventPayload, type EventReplay, type EventType } from '@altrex/contracts'
import { uuidv7 } from '../util/uuid'

export type EventListener = (event: AltrexEvent) => void

export type EventBusOptions = {
  /** Events retained for replay. Older events are dropped and reported as a gap. */
  capacity?: number
  now?: () => Date
  onListenerError?: (error: unknown) => void
}

/**
 * In-process event stream with strictly increasing sequence numbers and a bounded replay buffer.
 * Every payload is validated against the contract before it is assigned a sequence number, so an
 * invalid event is a programming error that never reaches a consumer.
 * The replay buffer is per process (a new streamId after restart). Durable per-task history is kept by
 * TaskManager/TaskStore (`task.events`).
 */
export class EventBus {
  readonly streamId = uuidv7()
  private seq = 0
  private readonly buffer: AltrexEvent[] = []
  private readonly listeners = new Set<EventListener>()
  private readonly capacity: number

  constructor(private readonly options: EventBusOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 5000)
  }

  publish<T extends EventType>(type: T, payload: EventPayload<T>, taskId: string | null): AltrexEvent<T> {
    const parsed = eventPayloadSchemas[type].parse(payload) as EventPayload<T>
    const event = {
      v: CONTRACT_VERSION,
      streamId: this.streamId,
      seq: ++this.seq,
      id: uuidv7(),
      ts: (this.options.now?.() ?? new Date()).toISOString(),
      taskId,
      type,
      payload: parsed,
    } as AltrexEvent<T>
    this.buffer.push(event as AltrexEvent)
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity)
    for (const listener of this.listeners) {
      try { listener(event as AltrexEvent) } catch (error) { this.options.onListenerError?.(error) }
    }
    return event
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Events with `seq > afterSeq`. `gap` is true when some requested events were already evicted. */
  replay(afterSeq: number): EventReplay {
    const oldestSeq = this.buffer[0]?.seq ?? null
    return {
      streamId: this.streamId,
      events: this.buffer.filter(event => event.seq > afterSeq),
      oldestSeq,
      latestSeq: this.seq,
      gap: oldestSeq !== null && afterSeq + 1 < oldestSeq,
    }
  }
}
