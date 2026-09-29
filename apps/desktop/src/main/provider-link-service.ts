import { shell } from 'electron'
import { officialProviderUrl, type ProviderId, type ProviderLinkKind } from '../shared/provider-registry'

export async function openOfficialProviderLink(providerId: ProviderId, kind: ProviderLinkKind): Promise<void> {
  await shell.openExternal(officialProviderUrl(providerId, kind))
}
