import { describe, expect, it } from 'vitest'
import { formatPlatform, getModeCapability } from './capabilities'

describe('capability disclosure', () => {
  it('reports the real agent runtime', () => {
    expect(getModeCapability('AGENT')).toEqual({
      available: true,
      label: 'Autonomous project editing and development commands are available.',
    })
  })

  it('distinguishes a browser preview from desktop platforms', () => {
    expect(formatPlatform(undefined)).toBe('WEB PREVIEW')
    expect(formatPlatform('win32')).toBe('WINDOWS')
  })
})
