import { z } from 'zod'
import { ProviderViewSchema, ModelViewSchema } from './provider'
import { CheckNameSchema, EvidenceSchema } from './verification'
import { RiskSchema } from './permissions'

// Phase 10 (contract freeze): the remaining UI-facing capabilities — projects, sessions, provider
// management, Git, checks, a user terminal, tool listing — and the structured error model.

/** Every command failure carries one of these codes (see `CoreError`). */
export const CoreErrorCodeSchema = z.enum([
  'INVALID_REQUEST', 'UNKNOWN_COMMAND', 'PROJECT_NOT_OPEN', 'PROJECT_BUSY', 'NOT_FOUND', 'POLICY_DENIED', 'CONFLICT',
  'CHECKPOINT_TOO_LARGE', 'CHECKPOINT_NOT_FINALIZED', 'CHECKPOINT_CORRUPT', 'PROVIDER_ERROR', 'UNAVAILABLE', 'CANCELLED', 'INTERNAL',
])
export type CoreErrorCode = z.infer<typeof CoreErrorCodeSchema>
export const CoreErrorSchema = z.object({
  code: CoreErrorCodeSchema,
  message: z.string().max(4000),
  /** True when repeating the same command later may succeed (busy project, transient provider error). */
  retryable: z.boolean(),
  /** Provider error category, checkpoint code, validation paths … (never secrets). */
  detail: z.string().max(2000).optional(),
})
export type CoreError = z.infer<typeof CoreErrorSchema>

export const ProjectSummarySchema = z.object({
  name: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  /** Manifests found at the root (package.json, Cargo.toml, ALTREX.md, …). */
  markers: z.array(z.string()),
})
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  projectPath: z.string().nullable(),
  /** Title of the first task in the session. */
  title: z.string().max(200),
  taskCount: z.int().nonnegative(),
  lastState: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type SessionSummary = z.infer<typeof SessionSummarySchema>

export const GitStatusSchema = z.object({
  isRepository: z.boolean(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  entries: z.array(z.object({ path: z.string(), index: z.string(), worktree: z.string(), untracked: z.boolean() })).max(5000),
})

export const ToolInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** `CLASSIFIED`: risk depends on the arguments (run_command is classified per command). */
  risk: z.union([RiskSchema, z.literal('CLASSIFIED')]),
})

const ProjectPath = z.string().min(1).max(4096)

/** A cloud endpoint that could receive project code, and whether the user allowed it. Local endpoints never need consent. */
export const CloudConsentSchema = z.object({
  providerId: z.string(),
  baseUrl: z.string(),
  displayName: z.string(),
  granted: z.boolean(),
  grantedAt: z.iso.datetime().nullable(),
})
export type CloudConsent = z.infer<typeof CloudConsentSchema>
const ConsentEndpointSchema = z.object({ providerId: z.string().min(1).max(64), baseUrl: z.string().min(1).max(2048) })

export const platformCommandSchemas = {
  /** Show the native folder picker; the chosen project becomes open (trusted) for this session. */
  'project.open': { request: z.object({}), response: ProjectSummarySchema.nullable() },
  /** Projects opened in this session (plus the most recent one). */
  'project.list': { request: z.object({}), response: z.array(ProjectSummarySchema) },
  'session.list': { request: z.object({ projectPath: ProjectPath.optional(), limit: z.int().min(1).max(500).default(50) }), response: z.array(SessionSummarySchema) },
  /**
   * Save a provider profile. The API key is sent once and stored encrypted in the main process; it is never
   * returned by any command or event.
   */
  'provider.connect': {
    request: z.object({
      providerId: z.string().min(1).max(64),
      apiKey: z.string().max(4096).default(''),
      baseUrl: z.string().max(2048).default(''),
      model: z.string().max(300).default(''),
      additionalFields: z.record(z.string().max(64), z.string().max(2048)).optional(),
    }),
    response: z.array(ProviderViewSchema),
  },
  'provider.disconnect': { request: z.object({ providerId: z.string().min(1).max(64) }), response: z.array(ProviderViewSchema) },
  /** Re-test every configured provider (measured health; uses one small request per provider). */
  'provider.test': { request: z.object({}), response: z.array(ProviderViewSchema) },
  /**
   * Open a provider's official page (API key page, account page, installer or docs) in the system browser.
   * The URL comes from the host's provider registry (HTTPS, approved hosts only), never from the caller.
   * `opened: false` when the provider has no such page.
   */
  'provider.openLink': {
    request: z.object({ providerId: z.string().min(1).max(64), kind: z.enum(['apiKey', 'accountId', 'install', 'docs']) }),
    response: z.object({ opened: z.boolean() }),
  },
  /** Re-discover models of configured providers. */
  'provider.refresh': { request: z.object({}), response: z.array(ModelViewSchema) },
  'tool.list': { request: z.object({}), response: z.array(ToolInfoSchema) },
  'git.status': { request: z.object({ projectPath: ProjectPath }), response: GitStatusSchema },
  'git.diff': {
    request: z.object({ projectPath: ProjectPath, path: z.string().max(4096).optional(), maxBytes: z.int().min(1000).max(2_000_000).default(200_000) }),
    response: z.object({ diff: z.string(), truncated: z.boolean() }),
  },
  'checks.discover': { request: z.object({ projectPath: ProjectPath }), response: z.array(z.object({ name: CheckNameSchema, argv: z.array(z.string()), source: z.string() })) },
  /** Run the project's declared checks now (user-initiated). Emits test.* events with taskId null. */
  'checks.run': { request: z.object({ projectPath: ProjectPath, names: z.array(CheckNameSchema).optional() }), response: z.array(EvidenceSchema) },
  /**
   * Run one command for the user (argv only, no shell) under the project's permission profile; FORBIDDEN is
   * always refused. Output streams as command.* events (taskId null); the response comes when it exits.
   */
  'terminal.run': {
    request: z.object({ projectPath: ProjectPath, command: z.string().min(1).max(200), args: z.array(z.string().max(8000)).max(80).default([]), timeoutMs: z.int().min(1000).max(1_800_000).default(600_000) }),
    response: z.object({ commandId: z.string(), exitCode: z.int().nullable(), timedOut: z.boolean(), durationMs: z.int().nonnegative(), output: z.string().max(200_000) }),
  },
  'terminal.cancel': { request: z.object({ commandId: z.string().min(1) }), response: z.object({ cancelled: z.boolean() }) },
  /**
   * Cloud-code consent. The backend refuses to send project code to a cloud endpoint without it (tasks fail
   * with code CONSENT_REQUIRED before any model request); the UI collects the decision.
   */
  'consent.list': { request: z.object({}), response: z.array(CloudConsentSchema) },
  /** `granted: false` when the endpoint is not a configured cloud endpoint (or the Codex engine). */
  'consent.grant': { request: ConsentEndpointSchema, response: z.object({ granted: z.boolean() }) },
  'consent.revoke': { request: ConsentEndpointSchema, response: z.object({ revoked: z.boolean() }) },
} as const
