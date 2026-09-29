import { describe, expect, it, vi } from 'vitest'
import { parseAltrexEvent, type AltrexEvent } from '@altrex/contracts'
import { EventBus } from './event-bus'
import { uuidv7 } from '../util/uuid'

describe('EventBus', () => {
  it('assigns strictly increasing sequence numbers and contract-valid envelopes', () => {
    const bus = new EventBus()
    const first = bus.publish('task.activity', { message: 'one', source: 'core' }, 'task-1')
    const second = bus.publish('task.cancelled', {}, 'task-1')
    expect([first.seq, second.seq]).toEqual([1, 2])
    expect(first.streamId).toBe(bus.streamId)
    expect(parseAltrexEvent(JSON.parse(JSON.stringify(second)))).toEqual(second)
  })

  it('rejects an invalid payload before it consumes a sequence number or reaches listeners', () => {
    const bus = new EventBus(), listener = vi.fn()
    bus.subscribe(listener)
    expect(() => bus.publish('task.state_changed', { from: 'RECEIVED', to: 'DONE' } as never, 'task-1')).toThrow()
    expect(listener).not.toHaveBeenCalled()
    expect(bus.publish('task.cancelled', {}, null).seq).toBe(1)
  })

  it('replays events after a sequence number and reports eviction gaps', () => {
    const bus = new EventBus({ capacity: 3 })
    for (let index = 0; index < 5; index++) bus.publish('agent.message_delta', { text: String(index) }, 't')
    expect(bus.replay(3).events.map(event => event.seq)).toEqual([4, 5])
    expect(bus.replay(3).gap).toBe(false)
    const stale = bus.replay(0)
    expect(stale).toMatchObject({ oldestSeq: 3, latestSeq: 5, gap: true })
    expect(stale.events.map(event => event.seq)).toEqual([3, 4, 5])
  })

  it('isolates listener failures and supports unsubscribe', () => {
    const errors: unknown[] = [], received: AltrexEvent[] = []
    const bus = new EventBus({ onListenerError: error => errors.push(error) })
    bus.subscribe(() => { throw new Error('bad listener') })
    const unsubscribe = bus.subscribe(event => received.push(event))
    bus.publish('task.cancelled', {}, null)
    unsubscribe()
    bus.publish('task.cancelled', {}, null)
    expect(errors).toHaveLength(2) // the throwing listener stays subscribed and fails on both publishes
    expect(received).toHaveLength(1) // the healthy listener got the first event, then unsubscribed
  })
})

describe('uuidv7', () => {
  it('produces RFC 9562 version-7 identifiers ordered by time', () => {
    const early = uuidv7(1_700_000_000_000), late = uuidv7(1_700_000_000_001)
    expect(early).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(early.slice(0, 13) < late.slice(0, 13)).toBe(true)
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000)
  })
})
