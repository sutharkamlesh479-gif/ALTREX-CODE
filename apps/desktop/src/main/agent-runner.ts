import type { ChatRequest, ChatStreamEvent } from '../shared/desktop-api'
import { codingToolDefinitions, ProjectToolBroker, type ProjectToolOptions } from './project-tool-broker'
import type { ModelProvider, ProviderContentPart, ProviderMessage, ProviderRuntimeConnection } from './providers/model-provider'
import type { ResolvedAttachment } from './attachment-service'
import { RoleRouter } from './providers/model-registry'
import { ProviderFailure } from './providers/request-manager'
import { LoopDetectedError, TaskBudget } from './task-budget'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function requestsWorkspaceAction(prompt: string): boolean {
  return /\b(build|create|make|implement|add|change|update|edit|write|generate|scaffold|install|set up|setup|configure|fix|debug|repair|refactor|remove|delete|rename|migrate|test|run|deploy|convert|integrate|upgrade)\b/i.test(prompt)
}

export async function runCodingAgent({
  provider,
  connection,
  request,
  repositoryContext,
  attachments = [],
  fallbackModels = [],
  router,
  signal,
  emit,
  toolOptions,
  onRound,
  skipSelfVerification = false,
}: {
  provider: ModelProvider
  connection: ProviderRuntimeConnection
  request: ChatRequest
  repositoryContext: string
  attachments?: ResolvedAttachment[]
  fallbackModels?: string[]
  router?: RoleRouter
  signal: AbortSignal
  emit: (event: ChatStreamEvent) => void
  /** Permission profile, approvals and tool event mapping (V4 Phase 6). */
  toolOptions?: ProjectToolOptions
  /** Called after each model round with the tools it requested and the endpoint that answered. */
  onRound?: (round: number, tools: string[], endpoint: { providerId: string; model: string }) => void
  /** ALTREX's Tester verifies afterwards; do not spend model rounds asking the agent to run checks itself. */
  skipSelfVerification?: boolean
}): Promise<void> {
  if (request.projectPath === null) throw new Error('Open a project before running Agent mode.')
  const broker = new ProjectToolBroker(request.projectPath, signal, undefined, toolOptions)
  const changedFiles = new Set<string>()
  let verificationRequested = false
  let verificationPassed = false
  let commandsRun = 0
  const verifyPreservedWork = async (): Promise<boolean> => {
    const packagePath = join(request.projectPath!, 'package.json')
    if (!existsSync(packagePath)) return false
    try {
      const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, string> }
      const script = ['test', 'build', 'typecheck', 'lint'].find(name => typeof manifest.scripts?.[name] === 'string' && !/no test specified/i.test(manifest.scripts[name]!))
      if (!script) return false
      const manager = existsSync(join(request.projectPath!, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
      emit({ requestId: request.requestId, type: 'activity', message: `Provider unavailable after file changes. Running ${manager} ${script} before preserving the result.` })
      const result = await broker.execute({ id: `altrex-recovery-${Date.now()}`, name: 'run_command', arguments: JSON.stringify({ command: manager, args: [script] }) })
      if (!result.commandResult) return false
      commandsRun += 1
      emit({ requestId: request.requestId, type: 'command-result', command: result.commandResult.command, exitCode: result.commandResult.exitCode, output: result.commandResult.output.slice(0, 4_000) })
      return result.commandResult.exitCode === 0
    } catch { return false }
  }
  const latestPrompt = request.messages.filter((message) => message.role === 'user').at(-1)?.content ?? ''
  const workspaceActionRequested = requestsWorkspaceAction(latestPrompt)
  const modelChain = [...new Set([connection.model, ...fallbackModels])]
  let modelIndex = 0
  let activeConnection = connection
  const complete = async (messages: ProviderMessage[]) => {
    // Local Vision replaces image payloads with text while retaining attachment metadata.
    const needsVision = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
    if (router) return router.complete('Coding Agent', messages, codingToolDefinitions, signal, message => emit({ requestId: request.requestId, type: 'activity', message }), router.registry.key(activeConnection), { vision: needsVision })
    let failure: unknown = new Error('No fallback model is available.')
    while (modelIndex < modelChain.length) {
      activeConnection = { ...connection, model: modelChain[modelIndex]! }
      try { return { completion: await provider.complete({ connection: activeConnection, messages, tools: codingToolDefinitions, signal, onStatus: message => emit({ requestId: request.requestId, type: 'activity', message }) }), connection: activeConnection } }
      catch (error) { failure = error; modelIndex++; if (modelIndex < modelChain.length) emit({ requestId: request.requestId, type: 'activity', model: modelChain[modelIndex]!, message: `${activeConnection.providerId} / ${activeConnection.model} failed. Switching automatically to ${connection.providerId} / ${modelChain[modelIndex]}.` }) }
    }
    throw failure
  }
  const history: ProviderMessage[] = [
    {
      role: 'system',
      content: [
        'You are ALTREX running in autonomous coding AGENT mode with real project and command tools.',
        'Carry out the complete user request inside the selected project. Use strong practical defaults instead of asking follow-up questions when the task is clear.',
        'Inspect the project, create or edit the actual files, install required dependencies, and run the relevant build or tests. If a command fails, read its output, fix the problem, and retry.',
        'Never merely print sample code or describe files the user asked you to create. Use write_file and run_command to do the work.',
        'Do not claim a file was created unless write_file or a command reported it. Do not claim a command or test passed unless run_command returned exit code 0.',
        'For an empty project, choose a suitable maintainable stack and initialize it yourself. Create complete, polished work rather than placeholders.',
        'All paths are relative to the selected project. Use only the provided tools and never attempt to escape the project.',
        `Repository context:\n${repositoryContext || '(empty project)'}`,
      ].join('\n\n'),
    },
    ...request.messages.map((message): ProviderMessage => ({ role: message.role, content: message.content })),
  ]
  if (attachments.length > 0) {
    let latestUserIndex = -1
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.role === 'user') {
        latestUserIndex = index
        break
      }
    }
    if (latestUserIndex >= 0) {
      const latest = history[latestUserIndex]!
      const fileContext = attachments.map((attachment) => {
        const location = attachment.projectRelativePath === undefined ? '' : ` path="${attachment.projectRelativePath}"`
        const content = attachment.textContent === undefined ? '' : `\n<file_content>\n${attachment.textContent.slice(0, 750_000)}\n</file_content>`
        return `<attachment name="${attachment.name}" type="${attachment.mimeType}"${location}>${content}</attachment>`
      }).join('\n\n')
      const parts: ProviderContentPart[] = [{
        type: 'text',
        text: `${typeof latest.content === 'string' ? latest.content : latestPrompt}\n\n${fileContext}`,
      }]
      for (const attachment of attachments) {
        if (attachment.imageDataUrl !== undefined) parts.push({ type: 'image_url', image_url: { url: attachment.imageDataUrl, detail: 'auto' } })
      }
      history[latestUserIndex] = { ...latest, content: parts }
    }
  }

  const budget = new TaskBudget(latestPrompt)
  let warned = false
  let loopRecoveries = 0
  while (true) {
    if (!budget.canStartRound()) {
      if (budget.extendForProgress()) { warned = false; emit({ requestId: request.requestId, type: 'activity', message: `Task budget extended because implementation is still progressing. ${budget.summary()}` }) }
      else throw new Error(`Agent paused after using its task budget. Existing file changes were preserved. ${budget.summary()}`)
    }
    budget.startRound()
    const round = budget.roundsUsed - 1
    if (budget.approachingLimit() && !warned) { warned = true; history.push({ role: 'system', content: `TASK BUDGET: ${budget.summary()} Summarize completed work, avoid repeated actions, verify only what remains, and finish if acceptance is met.` }) }
    emit({ requestId: request.requestId, type: 'activity', message: round === 0 ? 'Inspecting the project and planning changes' : 'Continuing implementation' })
    const slowNotice = setTimeout(() => {
      emit({ requestId: request.requestId, type: 'activity', model: activeConnection.model, message: `${activeConnection.model} is still reasoning…` })
    }, 12_000)
    let completion
    try {
      signal.throwIfAborted()
      const response = await complete(history); completion = response.completion
      if (activeConnection.model !== response.connection.model || activeConnection.providerId !== response.connection.providerId) emit({ requestId: request.requestId, type: 'activity', model: response.connection.model, message: `Continuing with ${response.connection.providerId} / ${response.connection.model}.` })
      activeConnection = response.connection
    } catch (error) {
      if (error instanceof ProviderFailure && workspaceActionRequested && changedFiles.size > 0 && !verificationPassed && commandsRun === 0) verificationPassed = await verifyPreservedWork()
      if (error instanceof ProviderFailure && workspaceActionRequested && changedFiles.size > 0 && verificationPassed) {
        emit({ requestId: request.requestId, type: 'activity', message: `${error.message} The completed file changes and successful verification are preserved.` })
        emit({ requestId: request.requestId, type: 'delta', delta: `Implementation completed and its project check passed. ${error.message} ALTREX preserved the verified files before the final model summary.` })
        emit({ requestId: request.requestId, type: 'files-changed', files: [...changedFiles] })
        return
      }
      throw error
    } finally {
      clearTimeout(slowNotice)
    }
    try { onRound?.(round, completion.toolCalls.map(call => call.name), { providerId: activeConnection.providerId, model: activeConnection.model }) } catch { /* observers never break the agent */ }
    if (completion.toolCalls.length === 0) {
      if (workspaceActionRequested && changedFiles.size === 0 && round > 1 && router) { router.registry.observeCapabilities(activeConnection, { supportsTools: false }); history.push({ role: 'system', content: `${activeConnection.providerId}/${activeConnection.model} repeatedly declined required tools. Continue on another verified tool-capable model.` }); continue }
      if (changedFiles.size === 0 && round === 0 && workspaceActionRequested) {
        history.push({ role: 'assistant', content: completion.content })
        history.push({ role: 'user', content: 'Use the available project tools now and implement the request. Do not only explain what should be created.' })
        continue
      }
      if (!skipSelfVerification && changedFiles.size > 0 && commandsRun === 0 && !verificationRequested) {
        verificationRequested = true
        history.push({ role: 'assistant', content: completion.content })
        history.push({ role: 'user', content: 'Verify the implementation before finishing. Run the appropriate build or tests when the project has them, fix any failures, and then report only what actually succeeded. For a dependency-free static project, inspect the completed files and explain that no build command was required.' })
        continue
      }
      if (completion.content.trim().length > 0) emit({ requestId: request.requestId, type: 'delta', delta: completion.content })
      if (changedFiles.size > 0) emit({ requestId: request.requestId, type: 'files-changed', files: [...changedFiles] })
      return
    }

    history.push({
      role: 'assistant',
      content: completion.content || null,
      tool_calls: completion.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
    })
    for (const call of completion.toolCalls) {
      emit({
        requestId: request.requestId,
        type: 'activity',
        message: call.name === 'write_file'
          ? 'Writing project files'
          : call.name === 'run_command'
            ? 'Running a project command'
            : 'Reading project context',
      })
      const result = await broker.execute(call)
      if (result.changedFile !== undefined) {
        changedFiles.add(result.changedFile)
        emit({ requestId: request.requestId, type: 'files-changed', files: [...changedFiles] })
      }
      for (const changedFile of result.changedFiles ?? []) changedFiles.add(changedFile)
      if (result.changedFiles !== undefined && result.changedFiles.length > 0) {
        emit({ requestId: request.requestId, type: 'files-changed', files: [...changedFiles] })
      }
      if (result.commandResult !== undefined) {
        commandsRun += 1
        if (result.commandResult.exitCode === 0 && /(?:^|\s)(?:test|build|lint|typecheck|check)(?:\s|$)|--test\b/i.test(result.commandResult.command)) verificationPassed = true
        emit({
          requestId: request.requestId,
          type: 'command-result',
          command: result.commandResult.command,
          exitCode: result.commandResult.exitCode,
          output: result.commandResult.output.slice(0, 4_000),
        })
      }
      try {
        budget.record(call, result.content, result.changedFile !== undefined || (result.changedFiles?.length ?? 0) > 0 || result.commandResult?.exitCode === 0)
      } catch (error) {
        if (!(error instanceof LoopDetectedError) || loopRecoveries >= 1) throw error
        loopRecoveries += 1
        emit({ requestId: request.requestId, type: 'activity', message: `${error.message} Asking the agent to choose a different approach.` })
        history.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content })
        history.push({ role: 'system', content: `${error.message} Do not repeat this action. Summarize its failure and choose a materially different recovery.` })
        continue
      }
      history.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content })
    }
  }
}

