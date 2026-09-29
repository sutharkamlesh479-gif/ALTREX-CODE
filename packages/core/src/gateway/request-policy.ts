export type RequestPolicy = {
  inputTokens: number
  outputTokens: number
  connectionMs: number
  firstTokenMs: number
  idleMs: number
  overallMs: number
  maxAttempts: number
  concurrency: number
}
// Conservative application budgets, not claims about a model's advertised capacity.
export const defaultRequestPolicy: RequestPolicy = {
  inputTokens: 6000, outputTokens: 4096, connectionMs: 20000,
  firstTokenMs: 180000, idleMs: 90000, overallMs: 600000, maxAttempts: 2, concurrency: 2,
}
export function requestPolicy(provider: string, overrides?: Partial<RequestPolicy>): RequestPolicy {
  const defaults = {
    ...defaultRequestPolicy,
    // Groq free tiers have low per-minute token limits; 4096 fits a typical file edit.
    ...(provider === 'groq' ? { inputTokens: 3500, outputTokens: 4096, concurrency: 1 } : {}),
    ...(provider === 'ollama' ? { inputTokens: 4096, outputTokens: 1024, firstTokenMs: 300000, overallMs: 900000, concurrency: 1, maxAttempts: 1 } : {}),
  }
  const policy = { ...defaults, ...overrides }
  for (const key of Object.keys(defaultRequestPolicy) as Array<keyof RequestPolicy>) {
    if (!Number.isFinite(policy[key]) || policy[key] <= 0) throw new Error(`Invalid request setting: ${key}`)
  }
  policy.inputTokens = Math.max(1024, Math.min(128000, Math.floor(policy.inputTokens)))
  policy.outputTokens = Math.max(64, Math.min(16384, Math.floor(policy.outputTokens)))
  policy.maxAttempts = Math.max(1, Math.min(6, Math.floor(policy.maxAttempts)))
  policy.concurrency = Math.max(1, Math.min(4, Math.floor(policy.concurrency)))
  for (const key of ['connectionMs', 'firstTokenMs', 'idleMs', 'overallMs'] as const) policy[key] = Math.min(1800000, policy[key])
  return policy
}
