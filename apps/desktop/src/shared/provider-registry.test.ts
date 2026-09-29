import { describe, expect, it } from 'vitest'
import { officialProviderUrl, providerDefinitions, type ProviderId, type ProviderLinkKind } from './provider-registry'

describe('provider metadata registry', () => {
  it('keeps every external destination on an approved official HTTPS host', () => {
    for (const provider of providerDefinitions) {
      for (const kind of ['apiKey', 'accountId', 'install', 'docs'] as ProviderLinkKind[]) {
        const configured = kind === 'apiKey' ? provider.apiKeyUrl : kind === 'accountId' ? provider.accountIdUrl : kind === 'install' ? provider.installUrl : provider.docsUrl
        if (!configured) continue
        const opened = new URL(officialProviderUrl(provider.id, kind))
        expect(opened.protocol).toBe('https:')
        expect(provider.approvedHosts).toContain(opened.hostname)
      }
    }
  })

  it('has the required connection fields and refuses unknown renderer input', () => {
    expect(providerDefinitions.find(provider => provider.id === 'cloudflare')?.requiredFields.map(field => field.id)).toEqual(['accountId', 'apiKey'])
    expect(providerDefinitions.find(provider => provider.id === 'ollama')).toMatchObject({ requiresApiKey: false, apiKeyUrl: null })
    expect(() => officialProviderUrl('attacker' as ProviderId, 'apiKey')).toThrow('Could not open official provider page')
    expect(() => officialProviderUrl('google', 'install')).toThrow('does not offer')
  })
})
