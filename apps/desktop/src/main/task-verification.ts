import type { Evidence, ReviewSummary, Verdict } from '@altrex/contracts'
import type { EventBus } from '@altrex/core/events/event-bus'
import type { TaskManager } from '@altrex/core/orchestrator/task-manager'
import type { PermissionProfile } from '@altrex/core/security/policy'
import { unifiedDiff } from '@altrex/core/util/text-diff'
import { DEFAULT_REPAIR_LIMITS, verifyAndRepair, type RepairLimits, type RepairRequest } from '@altrex/core/verification/engine'
import { parseReviewOutput, reviewIndependence, reviewNotRun, reviewSystemPrompt, reviewUserPrompt, summarizeReview, ReviewFormatError } from '@altrex/core/verification/review'
import { discoverChecks, runChecks } from '@altrex/core/verification/tester'
import { treeHash } from '@altrex/core/verification/tree-hash'
import type { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import type { ProjectMemory } from '@altrex/core/memory/project-memory'
import { codingToolDefinitions, ProjectToolBroker } from './project-tool-broker'
import type { ProviderMessage } from './providers/model-provider'
import type { RoleRouter } from './providers/model-registry'
import { repositoryIntelligence } from './repository-context'

const REVIEW_TOOLS = new Set(['read_file', 'list_files', 'search_files', 'find_symbol'])
const reviewerTools = codingToolDefinitions.filter(tool => REVIEW_TOOLS.has(tool.function.name))

export type TaskVerificationInput = {
  taskId: string
  projectPath: string
  /** The user's request (latest user message plus attachment names). */
  requestText: string
  tasks: TaskManager
  events: EventBus | undefined
  checkpoints: CheckpointStore
  checkpointId: string | null
  /** Files the engine reported changing (used when there is no checkpoint). */
  reportedFiles: string[]
  profile: PermissionProfile
  /** Router for the reviewer; null when no provider is configured (the review then does not run). */
  reviewRouter: RoleRouter | null
  /** Endpoint that wrote the code (reviewer independence); `key` is its routing key. */
  coder: { providerId: string; model: string; key: string } | null
  /** Runs one Debugger/Coder round with the given instructions; null disables repair. */
  repair: ((instructions: string, escalate: boolean, agentId: string | null) => Promise<void>) | null
  limits?: RepairLimits
  /** Project memory: evidence-backed facts are recorded after the verdict. */
  memory?: ProjectMemory
  signal: AbortSignal
  /** Human-readable progress for the legacy chat stream. */
  activity: (message: string) => void
}

/** Evidence-based verification with bounded repair for one change task (AGENT_SPEC.md §6–7). */
export async function verifyTask(input: TaskVerificationInput): Promise<Verdict> {
  const intelligence = repositoryIntelligence(input.projectPath)
  intelligence.refresh() // the agent may have added scripts or files
  const checks = discoverChecks(intelligence.profile())
  const publish = input.events
  input.activity(checks.length ? `Verifying with the project's own checks: ${checks.map(check => check.argv.join(' ')).join(', ')}.` : 'The project declares no build, test, typecheck or lint checks; verification is limited to an independent review.')

  const argvByEvidence = new Map<string, string[]>(), memoryKeys: string[] = []
  const verdict = await verifyAndRepair({
    discovered: checks.map(check => check.name),
    signal: input.signal,
    treeHash: () => treeHash(input.projectPath),
    transition: state => { if (input.tasks.state(input.taskId) !== state) input.tasks.transition(input.taskId, state) },
    runChecks: async () => {
      const tester = checks.length ? input.tasks.agentStarted(input.taskId, 'TESTER', 'Project checks') : null
      try {
        const result = await runChecks({
          root: input.projectPath, checks, signal: input.signal, profile: input.profile,
          onEvent: event => {
            if (event.type === 'test.started') { publish?.publish('test.started', { testId: event.testId, name: event.name, command: event.command.slice(0, 1000) }, input.taskId); input.activity(`Running ${event.command}`) }
            else { argvByEvidence.set(event.evidence.evidenceId, event.evidence.argv); publish?.publish('test.completed', { testId: event.testId, evidence: event.evidence }, input.taskId); input.activity(`${event.evidence.argv.join(' ')}: ${event.evidence.status}${event.evidence.exitCode !== null ? ` (exit ${event.evidence.exitCode})` : ''}`) }
          },
        })
        if (tester) input.tasks.agentFinished(tester, 'completed', summarizeEvidence(result.evidence))
        return result
      } catch (error) {
        if (tester) input.tasks.agentFinished(tester, input.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : 'Checks failed to run.')
        throw error
      }
    },
    review: async ({ evidence, round }) => review(input, evidence, round),
    repair: async (request: RepairRequest) => {
      if (!input.repair) throw new Error('Repair is not available for this engine.')
      const role = request.reason === 'check_failed' ? 'DEBUGGER' : 'CODER'
      const agentId = input.tasks.agentStarted(input.taskId, role, request.reason === 'check_failed' ? `Debugger (repair ${request.attempt})` : `Coder (review changes ${request.attempt})`)
      try {
        await input.repair(repairInstructions(request), request.escalate, agentId)
        input.tasks.agentFinished(agentId, 'completed', 'Repair round finished; re-running checks.')
      } catch (error) {
        input.tasks.agentFinished(agentId, input.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : 'Repair failed.')
        throw error
      }
    },
    onRepairStarted: info => { publish?.publish('repair.started', info, input.taskId); input.activity(`Repair ${info.attempt}/${info.limit}: ${info.reason === 'check_failed' ? 'fixing failing checks' : 'addressing reviewer findings'}${info.escalated ? ' with a stronger model' : ''}.`) },
    onFixed: info => { if (input.memory) memoryKeys.push(input.memory.recordFix(input.projectPath, info.signature, `Fixed by repair ${info.attempt} in task ${input.taskId}; the same checks then passed.`, info.evidence[0]?.evidenceId)) },
    onReview: summary => { publish?.publish('review.completed', summary, input.taskId); input.activity(summary.decision === 'not_run' ? `Review did not run: ${summary.note ?? ''}` : `Review: ${summary.decision} (${summary.blockers} blocker, ${summary.majors} major; ${summary.independence}).`) },
  }, input.repair ? input.limits ?? DEFAULT_REPAIR_LIMITS : { perSignature: 0, total: 0, reviewCycles: 0 })
  if (input.memory) {
    try {
      memoryKeys.push(...input.memory.recordVerdict(input.projectPath, verdict, argvByEvidence), ...input.memory.recordProfile(input.projectPath, intelligence.profile()))
      if (memoryKeys.length) publish?.publish('memory.updated', { projectPath: input.projectPath, keys: [...new Set(memoryKeys)].slice(0, 100) }, input.taskId)
    } catch { /* memory is best effort; the verdict stands */ }
  }
  return verdict
}

function summarizeEvidence(evidence: Evidence[]): string {
  return evidence.map(item => `${item.name}: ${item.status}`).join(', ') || 'No checks ran.'
}

function repairInstructions(request: RepairRequest): string {
  if (request.reason === 'review_changes') {
    const findings = request.review?.findings.map(finding => `- [${finding.severity}/${finding.category}] ${finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}: ` : ''}${finding.description}`).join('\n') ?? ''
    return `An independent reviewer requested changes to your implementation. Address every blocker and major finding with real code changes (or, if a finding is wrong, leave the code and explain precisely why in your final message):\n${findings}\nALTREX will re-run the project checks and the review afterwards; do not claim anything passed.`
  }
  const failures = request.failures.map(failure => `### ${failure.evidence.argv.join(' ')} → ${failure.evidence.status}${failure.evidence.exitCode !== null ? ` (exit ${failure.evidence.exitCode})` : ''}\n${compact(failure.output)}`).join('\n\n')
  return [
    `DEBUGGER: these project checks fail on the current tree (real output from ALTREX):`,
    failures,
    'Find the root cause and fix it in the source. Do not weaken, skip or delete tests or checks, and do not change check scripts to make them pass.',
    request.escalate ? 'The previous repair attempt did not change anything and the same failure came back. Take a different approach.' : '',
    'ALTREX re-runs the checks after you finish; report what you changed, not whether it passes.',
  ].filter(Boolean).join('\n\n')
}

function compact(output: string): string {
  if (output.length <= 6000) return output
  const lines = output.split(/\r?\n/), picked = new Set<number>()
  lines.forEach((line, index) => { if (/error|fail|exception|expected|assert|traceback|cannot|undefined/i.test(line)) for (let near = Math.max(0, index - 2); near <= Math.min(lines.length - 1, index + 4); near++) picked.add(near) })
  const body = [...picked].sort((a, b) => a - b).slice(0, 120).map(index => lines[index]).join('\n')
  return `${body.slice(0, 4500)}\n…\n${output.slice(-1400)}`
}

async function taskDiff(input: TaskVerificationInput): Promise<{ files: string[]; diff: string }> {
  if (!input.checkpointId) return { files: input.reportedFiles, diff: '' }
  try {
    const plan = await input.checkpoints.plan(input.checkpointId, 'all')
    const files = [...new Set([...plan.restore, ...plan.delete])].sort()
    let diff = ''
    for (const path of files.slice(0, 60)) {
      if (diff.length > 60_000) break
      const versions = await input.checkpoints.fileVersions(input.checkpointId, path).catch(() => null)
      if (!versions) continue
      diff += versions.binary ? `--- a/${path}\n+++ b/${path}\n(binary or large file changed)\n` : unifiedDiff(path, versions.before, versions.current)
    }
    return { files, diff }
  } catch { return { files: input.reportedFiles, diff: '' } }
}

async function review(input: TaskVerificationInput, evidence: Evidence[], round: number): Promise<ReviewSummary> {
  const router = input.reviewRouter
  if (!router || !router.hasCandidates()) return reviewNotRun('No model provider is available for an independent review.')
  const { files, diff } = await taskDiff(input)
  const messages: ProviderMessage[] = [{ role: 'system', content: reviewSystemPrompt() }, { role: 'user', content: reviewUserPrompt({ request: input.requestText, diff, evidence, changedFiles: files, round }) }]
  const broker = new ProjectToolBroker(input.projectPath, input.signal, undefined, { profile: 'read_only', taskId: input.taskId })
  const agentId = input.tasks.agentStarted(input.taskId, 'REVIEWER', 'Independent reviewer')
  let corrections = 0
  try {
    for (let turn = 0; turn < 10; turn++) {
      const { completion, connection } = await router.complete('Reviewer', messages, reviewerTools, input.signal, () => undefined, undefined, input.coder ? { differentFrom: input.coder.key } : {})
      input.tasks.agentEndpoint(agentId, connection.providerId, connection.model)
      if (completion.toolCalls.length) {
        messages.push({ role: 'assistant', content: completion.content || null, tool_calls: completion.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) })
        for (const call of completion.toolCalls) {
          const result = REVIEW_TOOLS.has(call.name) ? await broker.execute(call) : { content: 'ERROR: The reviewer cannot edit files or run commands.' }
          messages.push({ role: 'tool', tool_call_id: call.id, content: result.content })
        }
        input.tasks.agentProgress(agentId, `Round ${turn + 1}: ${completion.toolCalls.map(call => call.name).join(', ')}`, turn)
        continue
      }
      try {
        const reviewer = { providerId: connection.providerId, model: connection.model }
        const summary = summarizeReview(parseReviewOutput(completion.content), reviewer, reviewIndependence(input.coder && { providerId: input.coder.providerId, model: input.coder.model }, reviewer))
        input.tasks.agentFinished(agentId, 'completed', `${summary.decision}: ${summary.blockers} blocker, ${summary.majors} major, ${summary.findings.length} finding(s).`)
        return summary
      } catch (error) {
        if (!(error instanceof ReviewFormatError) || corrections >= 2) throw error
        corrections += 1
        messages.push({ role: 'assistant', content: completion.content }, { role: 'user', content: 'Reply with ONLY the JSON object described in the instructions.' })
      }
    }
    throw new Error('The reviewer did not finish within 10 rounds.')
  } catch (error) {
    if (input.signal.aborted) { input.tasks.agentFinished(agentId, 'cancelled', 'Cancelled.'); throw error }
    const message = error instanceof Error ? error.message : 'The review failed.'
    input.tasks.agentFinished(agentId, 'failed', message)
    return reviewNotRun(`The review could not complete: ${message}`)
  }
}

