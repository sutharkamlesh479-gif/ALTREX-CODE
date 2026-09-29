import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async (_url: string): Promise<void> => undefined) }))
vi.mock('electron', () => ({ shell: { openExternal } }))

import { providerDefinitions } from '../shared/provider-registry'
import { openOfficialProviderLink } from './provider-link-service'

describe('controlled provider links', () => {
  beforeEach(() => openExternal.mockClear())

  it('opens every provider acquisition destination through Electron shell', async () => {
    for (const provider of providerDefinitions) {
      const kind = provider.apiKeyUrl ? 'apiKey' : provider.installUrl ? 'install' : null
      if (kind) await openOfficialProviderLink(provider.id, kind)
    }
    expect(openExternal).toHaveBeenCalledTimes(providerDefinitions.filter(provider => provider.apiKeyUrl || provider.installUrl).length)
    for (const [url] of openExternal.mock.calls) expect(new URL(url).protocol).toBe('https:')
  })

  it('cannot open a renderer-supplied arbitrary destination', async () => {
    await expect(openOfficialProviderLink('unknown' as never, 'apiKey')).rejects.toThrow('Could not open official provider page')
    expect(openExternal).not.toHaveBeenCalled()
  })
})
