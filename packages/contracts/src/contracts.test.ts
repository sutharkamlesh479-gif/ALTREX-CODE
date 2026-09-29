import { describe, expect, it } from 'vitest'
import {
  COMMAND_NAMES,
  CONTRACT_VERSION,
  EVENT_TYPES,
  commandSchemas,
  isCommandName,
  parseAltrexEvent,
  parseCommandRequest,
  parseCommandResponse,
  type AltrexEvent,
  type CommandName,
  type CommandRequest,
  type CommandResponse,
  type EventPayload,
  type EventType,
} from './index'

const checkpointId = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const checkpoint = {
  checkpointId, projectPath: 'C:/work/app', taskId: 'task-123456', label: 'Before task',
  kind: 'snapshot' as const, createdAt: '2026-09-26T10:00:00.000Z', fileCount: 12, totalBytes: 3456,
  finalizedAt: '2026-09-26T10:05:00.000Z', changedByTask: 2,
}
const restoreResult = {
  checkpointId, scope: 'task' as const, restored: ['src/a.ts'], deleted: ['src/new.ts'],
  conflicts: [{ path: 'src/b.ts', reason: 'modified-after-task' as const }], safetyCheckpointId: null,
}

// Typed as a complete Record: adding an event type without a sample fails typecheck.
const samples: { [T in EventType]: EventPayload<T> } = {
  'task.created': { state: 'RECEIVED', mode: 'AGENT', intent: 'change', projectPath: 'C:/work/app', title: 'Fix login', modelSelection: 'AUTO' },
  'task.state_changed': { from: 'RECEIVED', to: 'IMPLEMENTING' },
  'task.activity': { message: 'Inspecting the project', source: 'legacy' },
  'task.completed': {},
  'task.completed_unverified': { reason: 'Verification engine not implemented yet.' },
  'task.failed': { message: 'Provider unavailable', code: null },
  'task.cancelled': {},
  'agent.message_delta': { text: 'Hello' },
  'model.selected': { provider: 'OpenRouter', model: 'fake/model', reasons: ['first ranked candidate'] },
  'command.exited': { command: 'pnpm test', exitCode: 0, output: 'ok' },
  'file.changed': { paths: ['src/a.ts'], cumulative: true },
  'checkpoint.created': checkpoint,
  'checkpoint.failed': { projectPath: 'C:/work/app', reason: 'Workspace exceeds safe copy limits.' },
  'checkpoint.restored': restoreResult,
  'provider.health_changed': { providerId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', state: 'AUTH_ERROR', previous: 'HEALTHY', errorCategory: 'INVALID_API_KEY' },
  'provider.selected': { providerId: 'groq', role: 'Coder', mode: 'AUTO', reason: 'AUTO: groq / m selected for Coder (standard task)' },
  'route.changed': { role: 'Coder', from: { providerId: 'groq', model: 'a' }, to: { providerId: 'nvidia', model: 'b' }, reason: 'Re-ranked with current health and measured results.' },
  'fallback.started': { role: 'Coder', from: { providerId: 'groq', model: 'a' }, to: { providerId: 'nvidia', model: 'b' }, reason: 'RATE_LIMITED' },
  'fallback.completed': { role: 'Coder', from: { providerId: 'groq', model: 'a' }, to: { providerId: 'nvidia', model: 'b' } },
  'fallback.failed': { role: 'Coder', from: { providerId: 'nvidia', model: 'b' }, reason: 'PROVIDER_SERVER_ERROR', attempted: 2 },
  'permission.required': { approvalId: 'a1', taskId: 'task-123456', tool: 'run_command', summary: 'npx create-vite app', risk: 'HIGH', capability: 'package.execute', reason: 'npx may download and execute create-vite', requestedAt: '2026-09-27T10:00:00.000Z' },
  'permission.resolved': { approvalId: 'a1', decision: 'denied', scope: 'once', by: 'policy', note: 'No approval UI is connected.' },
  'tool.denied': { tool: 'run_command', summary: 'git push origin main', risk: 'FORBIDDEN', reason: 'git push rewrites history, deletes work, or publishes; the user does this' },
  'command.started': { commandId: 'c1', command: 'pnpm test' },
  'command.output': { commandId: 'c1', stream: 'stdout', text: '✓ 3 tests passed' },
  'command.completed': { commandId: 'c1', command: 'pnpm test', exitCode: 0, timedOut: false, durationMs: 1234 },
  'agent.started': { agentId: 'ag1', role: 'CODER', label: 'Coding agent', providerId: 'nvidia', model: 'qwen-coder' },
  'agent.progress': { agentId: 'ag1', role: 'CODER', round: 2, message: 'Round 3: read_file, edit_file' },
  'agent.completed': { agentId: 'ag1', role: 'CODER', summary: 'Changed 2 files.' },
  'agent.failed': { agentId: 'ag1', role: 'CODER', message: 'Task cancelled.', code: 'CANCELLED' },
  'diff.available': { checkpointId: 'cp1', files: [{ path: 'src/a.ts', change: 'modified' }, { path: 'src/new.ts', change: 'added' }], truncated: false },
  'task.interrupted': { reason: 'ALTREX stopped while this task was running.' },
  'test.started': { testId: 'ev1', name: 'test', command: 'pnpm run test' },
  'test.completed': { testId: 'ev1', evidence: { evidenceId: 'ev1', name: 'test', argv: ['pnpm', 'run', 'test'], status: 'PASS', exitCode: 0, timedOut: false, durationMs: 5120, treeHash: 'abc123', parsed: { passed: 84, failed: 0 }, outputTail: 'Tests 84 passed', at: '2026-09-27T10:00:00.000Z' } },
  'review.completed': { decision: 'request_changes', independence: 'same-model', reviewer: { providerId: 'nvidia', model: 'm' }, blockers: 1, majors: 0, findings: [{ severity: 'blocker', category: 'bug', file: 'src/a.ts', line: 3, description: 'Null dereference' }] },
  'repair.started': { attempt: 1, limit: 6, reason: 'check_failed', signature: 'test:TypeError at a.ts', escalated: false },
  'verification.completed': { status: 'VERIFIED', treeHash: 'abc123', checks: [{ name: 'test', status: 'PASS', evidenceId: 'ev1', summary: '84 passed' }, { name: 'lint', status: 'NOT_AVAILABLE' }], review: { decision: 'approve', independence: 'different-provider', reviewer: { providerId: 'google', model: 'gemini' }, blockers: 0, majors: 0, findings: [] }, repairs: { attempts: 1, limitReached: false }, reasons: ['All discovered checks passed on the final tree.'] },
  'tournament.candidate': { candidate: 1, providerId: 'google', model: 'gemini', status: 'completed', changedFiles: 3, changedLines: 42, conflicts: 0, checks: [{ name: 'test', status: 'PASS' }] },
  'tournament.selected': { winner: 1, ranking: [{ candidate: 1, eligible: true, reasons: ['1/1 declared checks passed'] }, { candidate: 0, eligible: false, reasons: ['made no changes'] }], applied: ['src/a.ts'] },
  'memory.updated': { projectPath: 'C:/work/app', keys: ['check.test'] },
  'task.verified': { verdict: { status: 'VERIFIED', treeHash: 'abc123', checks: [{ name: 'test', status: 'PASS', evidenceId: 'ev1', summary: '84 passed' }, { name: 'lint', status: 'NOT_AVAILABLE' }], review: { decision: 'approve', independence: 'different-provider', reviewer: { providerId: 'google', model: 'gemini' }, blockers: 0, majors: 0, findings: [] }, repairs: { attempts: 1, limitReached: false }, reasons: ['All discovered checks passed on the final tree.'] } },
}

function envelope<T extends EventType>(type: T, seq = 1): AltrexEvent<T> {
  return { v: CONTRACT_VERSION, streamId: 'stream-1', seq, id: `event-${seq}`, ts: '2026-09-26T10:00:00.000Z', taskId: 'task-123456', type, payload: samples[type] } as AltrexEvent<T>
}

describe('event contract v1', () => {
  it.each(EVENT_TYPES)('round-trips %s through JSON unchanged', (type) => {
    const event = envelope(type)
    expect(parseAltrexEvent(JSON.parse(JSON.stringify(event)))).toEqual(event)
  })

  it('rejects an unknown contract version', () => {
    expect(() => parseAltrexEvent({ ...envelope('task.cancelled'), v: 2 })).toThrow()
  })

  it('rejects unknown event types rather than passing them through', () => {
    expect(() => parseAltrexEvent({ ...envelope('task.cancelled'), type: 'tool.started' })).toThrow()
  })

  it('rejects an invalid payload and reports the payload path', () => {
    const invalid = { ...envelope('task.state_changed'), payload: { from: 'RECEIVED', to: 'DONE' } }
    expect(() => parseAltrexEvent(invalid)).toThrow(/payload/)
  })

  it('requires positive sequence numbers and ISO timestamps', () => {
    expect(() => parseAltrexEvent({ ...envelope('task.cancelled'), seq: 0 })).toThrow()
    expect(() => parseAltrexEvent({ ...envelope('task.cancelled'), ts: 'yesterday' })).toThrow()
  })

  it('tolerates additive payload fields from newer producers (non-breaking evolution)', () => {
    const newer = { ...envelope('agent.message_delta'), payload: { text: 'hi', agentRole: 'coder' } }
    expect(parseAltrexEvent(newer).payload).toEqual({ text: 'hi' })
  })

  it('bounds command output carried in events', () => {
    expect(() => parseAltrexEvent({ ...envelope('command.exited'), payload: { command: 'x', exitCode: 1, output: 'y'.repeat(9000) } })).toThrow()
  })
})

const commandSamples: { [N in CommandName]: { request: CommandRequest<N>; response: CommandResponse<N> } } = {
  'events.replay': {
    request: { afterSeq: 0 },
    response: { streamId: 'stream-1', events: [envelope('task.cancelled', 1)], oldestSeq: 1, latestSeq: 1, gap: false },
  },
  'checkpoint.list': { request: { projectPath: 'C:/work/app' }, response: [checkpoint] },
  'checkpoint.preview': {
    request: { checkpointId, scope: 'all' },
    response: { checkpointId, scope: 'all', restore: ['src/a.ts'], delete: [], conflicts: [] },
  },
  'checkpoint.restore': { request: { checkpointId }, response: restoreResult },
  'provider.list': {
    request: {},
    response: [{ providerId: 'custom', displayName: 'OpenAI-compatible', baseUrl: 'https://abc123.ngrok-free.app/v1', protocol: 'openai-chat', privacy: 'cloud', health: 'UNKNOWN', lastErrorCategory: null, lastCheckedAt: null, model: 'llama', modelsDiscovered: 3, hasCredential: false, keyHint: null, statusMessage: null }],
  },
  'router.preview': {
    request: { mode: 'FREE_ONLY', tools: true },
    response: { mode: 'FREE_ONLY', primary: { providerId: 'openrouter', model: 'x:free' }, fallbacks: [], reasons: ['FREE_ONLY: openrouter / x:free selected for Coding Agent (standard task)'], rejected: [{ providerId: 'openrouter', model: 'y', reason: 'not_free', detail: 'paid model' }] },
  },
  'repo.profile': { request: { projectPath: 'C:/work/app' }, response: { languages: [{ language: 'typescript', files: 40 }], packageManager: 'pnpm', frameworks: ['React', 'Vitest'], testRunner: 'vitest', commands: [{ kind: 'test', argv: ['pnpm', 'run', 'test'], source: 'package.json scripts.test' }], manifests: ['package.json'], monorepo: false } },
  'repo.search': { request: { projectPath: 'C:/work/app', pattern: 'login', word: true }, response: { matches: [{ path: 'src/auth.ts', line: 3, text: 'export function login() {' }], truncated: false, engine: 'builtin' } },
  'repo.symbols': { request: { projectPath: 'C:/work/app', name: 'login' }, response: [{ path: 'src/auth.ts', name: 'login', kind: 'function', line: 3, exported: true }] },
  'repo.related': { request: { projectPath: 'C:/work/app', path: 'src/auth.ts' }, response: { imports: ['src/db.ts'], importers: ['src/app.ts'], tests: ['src/auth.test.ts'] } },
  'context.preview': { request: { projectPath: 'C:/work/app', task: 'Fix login' }, response: { seeds: ['login'], items: [{ kind: 'snippet', path: 'src/auth.ts', range: [1, 40], reason: 'defines login', chars: 900 }] } },
  'task.start': { request: { projectPath: 'C:/work/app', mode: 'AGENT', prompt: 'Add a settings page', candidates: 2 }, response: { taskId: 'task-1' } },
  'project.open': { request: {}, response: { name: 'app', path: 'C:/work/app', branch: 'main', markers: ['package.json'] } },
  'project.list': { request: {}, response: [{ name: 'app', path: 'C:/work/app', branch: null, markers: [] }] },
  'session.list': { request: { projectPath: 'C:/work/app' }, response: [{ sessionId: 'session-1', projectPath: 'C:/work/app', title: 'Add login', taskCount: 2, lastState: 'VERIFIED', createdAt: '2026-09-27T10:00:00.000Z', updatedAt: '2026-09-27T10:05:00.000Z' }] },
  'provider.connect': { request: { providerId: 'groq', apiKey: 'gsk_example', model: 'llama' }, response: [] },
  'provider.disconnect': { request: { providerId: 'groq' }, response: [] },
  'provider.test': { request: {}, response: [] },
  'provider.openLink': { request: { providerId: 'google', kind: 'apiKey' }, response: { opened: true } },
  'provider.refresh': { request: {}, response: [] },
  'tool.list': { request: {}, response: [{ name: 'read_file', description: 'Read a file', risk: 'LOW' }, { name: 'run_command', description: 'Run', risk: 'CLASSIFIED' }] },
  'git.status': { request: { projectPath: 'C:/work/app' }, response: { isRepository: true, branch: 'main', head: 'abc', entries: [{ path: 'a.ts', index: ' ', worktree: 'M', untracked: false }] } },
  'git.diff': { request: { projectPath: 'C:/work/app', path: 'a.ts' }, response: { diff: '--- a/a.ts', truncated: false } },
  'checks.discover': { request: { projectPath: 'C:/work/app' }, response: [{ name: 'test', argv: ['pnpm', 'run', 'test'], source: 'package.json scripts.test' }] },
  'checks.run': { request: { projectPath: 'C:/work/app', names: ['test'] }, response: [] },
  'terminal.run': { request: { projectPath: 'C:/work/app', command: 'pnpm', args: ['test'] }, response: { commandId: 'c1', exitCode: 0, timedOut: false, durationMs: 900, output: 'ok' } },
  'terminal.cancel': { request: { commandId: 'c1' }, response: { cancelled: false } },
  'consent.list': { request: {}, response: [{ providerId: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', displayName: 'Google Gemini', granted: false, grantedAt: null }] },
  'consent.grant': { request: { providerId: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }, response: { granted: true } },
  'consent.revoke': { request: { providerId: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }, response: { revoked: true } },
  'memory.list': { request: { projectPath: 'C:/work/app' }, response: [{ key: 'check.test', value: 'pnpm run test → PASS', source: 'evidence', evidenceId: 'ev1', confidence: 'confirmed', lastVerifiedAt: '2026-09-27T10:00:00.000Z' }] },
  'memory.remember': { request: { projectPath: 'C:/work/app', key: 'style', value: 'Use tabs' }, response: { key: 'user.style' } },
  'memory.forget': { request: { projectPath: 'C:/work/app', key: 'user.style' }, response: { removed: true } },
  'task.cancel': { request: { taskId: 'task-1' }, response: { cancelled: true } },
  'task.list': { request: { projectPath: 'C:/work/app' }, response: [] },
  'task.get': {
    request: { taskId: 'task-1' },
    response: { taskId: 'task-1', requestId: null, mode: 'AGENT', intent: 'change', projectPath: 'C:/work/app', title: 'Add a settings page', modelSelection: 'AUTO', routingMode: 'AUTO', engine: 'altrex', state: 'COMPLETED_UNVERIFIED', createdAt: '2026-09-27T10:00:00.000Z', updatedAt: '2026-09-27T10:05:00.000Z', finishedAt: '2026-09-27T10:05:00.000Z', checkpointIds: ['cp1'], changedFiles: ['src/a.ts'], agents: [{ agentId: 'ag1', role: 'CODER', label: 'Coding agent', status: 'completed', providerId: 'nvidia', model: 'qwen-coder', startedAt: '2026-09-27T10:00:01.000Z', finishedAt: '2026-09-27T10:05:00.000Z', summary: 'Done' }], outcome: { reason: 'No verification verdict yet.', code: null }, eventsTruncated: false, sessionId: 'session-1', verdict: { status: 'VERIFIED', treeHash: 'abc123', checks: [{ name: 'test', status: 'PASS', evidenceId: 'ev1', summary: '84 passed' }, { name: 'lint', status: 'NOT_AVAILABLE' }], review: { decision: 'approve', independence: 'different-provider', reviewer: { providerId: 'google', model: 'gemini' }, blockers: 0, majors: 0, findings: [] }, repairs: { attempts: 1, limitReached: false }, reasons: ['All discovered checks passed on the final tree.'] } },
  },
  'task.events': { request: { taskId: 'task-1' }, response: { taskId: 'task-1', events: [], truncated: false } },
  'checkpoint.diff': { request: { checkpointId: 'cp1', path: 'src/a.ts' }, response: { path: 'src/a.ts', before: 'a', current: 'b', binary: false, changedSinceTask: false } },
  'permission.respond': { request: { approvalId: 'a1', decision: 'approve', scope: 'task' }, response: { accepted: true } },
  'permission.pending': { request: {}, response: [] },
  'permission.configure': { request: { interactive: true }, response: { interactive: true } },
  'project.permissions': { request: { projectPath: 'C:/work/app', profile: 'autonomous' }, response: { projectPath: 'C:/work/app', profile: 'autonomous' } },
  'model.list': {
    request: { providerId: 'openrouter' },
    response: [{ providerId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'x/y:free', displayName: 'Y', available: true, health: 'HEALTHY', free: true, lastErrorCategory: null, capabilities: { chat: true, streaming: true, tools: null, streamingTools: null, vision: false, structuredOutput: null, reasoning: null, contextWindow: 131072, maxOutput: null } }],
  },
}

describe('provider contract', () => {
  it('never admits more than a 4-character key hint', () => {
    const view = { ...commandSamples['provider.list'].response[0]!, keyHint: 'sk-full-secret-key' }
    expect(() => parseCommandResponse('provider.list', [view])).toThrow()
  })
})

describe('repository contract', () => {
  it('requires exactly one of path or name for repo.symbols', () => {
    expect(() => parseCommandRequest('repo.symbols', { projectPath: 'C:/a' })).toThrow()
    expect(() => parseCommandRequest('repo.symbols', { projectPath: 'C:/a', path: 'x.ts', name: 'y' })).toThrow()
  })
})

describe('command contract v1', () => {
  it.each(COMMAND_NAMES)('round-trips %s request and response', (name) => {
    const sample = commandSamples[name]
    expect(isCommandName(name)).toBe(true)
    parseCommandRequest(name, JSON.parse(JSON.stringify(sample.request)))
    expect(parseCommandResponse(name, JSON.parse(JSON.stringify(sample.response)))).toEqual(sample.response)
  })

  it('applies the task restore scope by default', () => {
    expect(parseCommandRequest('checkpoint.restore', { checkpointId })).toEqual({ checkpointId, scope: 'task' })
  })

  it('rejects malformed checkpoint IDs (no path fragments reach the filesystem)', () => {
    expect(() => parseCommandRequest('checkpoint.restore', { checkpointId: '../../etc' })).toThrow()
  })

  it('rejects unknown command names', () => {
    expect(isCommandName('task.delete_everything')).toBe(false)
    expect(isCommandName('toString')).toBe(false)
    expect(Object.keys(commandSchemas)).toEqual(COMMAND_NAMES)
  })
})
