import { ConsentStore } from '@altrex/core/security/consent'

/**
 * Test support only: models a user who granted cloud-code consent for every endpoint, for tests of other
 * features (checkpoints, task engine, verification, tournaments) that use cloud providers with a project.
 * Consent enforcement itself is covered by provider-service.consent.test.ts.
 */
export function consentGranted(): ConsentStore {
  const store = new ConsentStore(null)
  store.has = () => true
  return store
}
