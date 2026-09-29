import { describe, expect, it, vi } from 'vitest'
import { decide } from './policy'
import { ApprovalBroker } from './approvals'

describe('permission policy', () => {
  it.each([
    ['read_only', 'LOW', 'allow'], ['read_only', 'MEDIUM', 'deny'], ['read_only', 'HIGH', 'deny'],
    ['standard', 'LOW', 'allow'], ['standard', 'MEDIUM', 'allow'], ['standard', 'HIGH', 'ask'],
    ['autonomous', 'MEDIUM', 'allow'], ['autonomous', 'HIGH', 'allow'],
    ['autonomous', 'FORBIDDEN', 'deny'], ['standard', 'FORBIDDEN', 'deny'],
  ] as const)('%s + %s → %s', (profile, risk, action) => {
    expect(decide(profile, risk, 'process.execute', 'x').action).toBe(action)
  })
})

describe('ApprovalBroker', () => {
  const input = { taskId: 't1', tool: 'run_command', summary: 'npx create-vite app', risk: 'HIGH' as const, capability: 'package.execute' as const, reason: 'downloads and executes a package' }

  it('denies immediately (never silently approves) when no approval UI is connected', async () => {
    const onRequired = vi.fn(), onResolved = vi.fn()
    const outcome = await new ApprovalBroker({ onRequired, onResolved }).request(input)
    expect(outcome).toMatchObject({ decision: 'denied', by: 'policy' })
    expect(outcome.note).toContain('no approval UI is connected')
    expect(onRequired).not.toHaveBeenCalled()
    expect(onResolved).toHaveBeenCalledOnce()
  })

  it('waits for the user when interactive, and answers each request only once', async () => {
    const required: string[] = []
    const broker = new ApprovalBroker({ onRequired: request => required.push(request.approvalId) })
    broker.setInteractive(true)
    const pending = broker.request(input)
    expect(broker.list()).toHaveLength(1)
    expect(broker.respond(required[0]!, 'approve')).toBe(true)
    expect(broker.respond(required[0]!, 'deny')).toBe(false)
    expect(await pending).toMatchObject({ decision: 'approved', by: 'user', scope: 'once' })
  })

  it('reuses a task-scoped grant for the same action within the task only', async () => {
    const ids: string[] = []
    const broker = new ApprovalBroker({ onRequired: request => ids.push(request.approvalId) })
    broker.setInteractive(true)
    const first = broker.request(input)
    broker.respond(ids[0]!, 'approve', 'task')
    await first
    expect(await broker.request(input)).toMatchObject({ decision: 'approved', by: 'task-grant' })
    broker.endTask('t1')
    const again = broker.request(input)
    expect(ids).toHaveLength(2)
    broker.respond(ids[1]!, 'deny')
    expect(await again).toMatchObject({ decision: 'denied', by: 'user' })
  })

  it('denies a pending request when the task is cancelled', async () => {
    const broker = new ApprovalBroker()
    broker.setInteractive(true)
    const controller = new AbortController()
    const pending = broker.request(input, controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ decision: 'denied', note: 'The task was cancelled.' })
    expect(broker.list()).toEqual([])
  })
})
