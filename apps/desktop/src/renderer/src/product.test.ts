import { describe, expect, it } from 'vitest'
import { defaultMode } from './product'

describe('ALTREX product defaults', () => {
  it('starts new tasks in the real Codex workspace agent', () => {
    expect(defaultMode).toBe('AGENT')
  })
})
