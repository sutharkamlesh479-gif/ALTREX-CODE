import { describe, expect, it } from 'vitest'
import { LoopDetectedError, TaskBudget } from './task-budget'

describe('adaptive task budgets', () => {
  it('gives larger work more initial rounds and only extends after progress', () => {
    const simple = new TaskBudget('rename one file'), large = new TaskBudget('Build a complete website application with multiple features')
    expect(large.initialRounds).toBeGreaterThan(simple.initialRounds)
    expect(simple.extendForProgress()).toBe(false)
    simple.record({ id: '1', name: 'write_file', arguments: '{"path":"a"}' }, 'Changed a', true)
    expect(simple.extendForProgress()).toBe(true)
  })

  it('stops three identical no-progress tool actions', () => {
    const budget = new TaskBudget('fix task'), call = { id: '1', name: 'run_command', arguments: '{"command":"npm install"}' }
    budget.record(call, 'ERROR: failed', false)
    budget.record(call, 'ERROR: failed', false)
    expect(() => budget.record(call, 'ERROR: failed', false)).toThrow(LoopDetectedError)
  })
})
