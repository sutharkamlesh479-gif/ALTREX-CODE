import type { ProviderToolCall } from '../tools/types'

export class LoopDetectedError extends Error {
  constructor(readonly repeatedAction: string, readonly repetitions: number) { super(`LOOP DETECTED: ${repeatedAction} repeated ${repetitions} times without useful progress.`) }
}

export class TaskBudget {
  readonly initialRounds: number
  private roundLimit: number
  private readonly hardRoundLimit: number
  private toolLimit: number
  private readonly signatures = new Map<string, { count: number; lastOutcome: string }>()
  private usefulActions = 0
  private usefulAtExtension = 0
  roundsUsed = 0
  toolCallsUsed = 0

  constructor(description: string, contractSize = 0) {
    const large = description.length > 1500 || contractSize > 8 || /\b(full|complete|entire|migration|redesign|multiple|application|website|architecture)\b/i.test(description)
    const simple = description.length < 240 && contractSize <= 2 && /\b(rename|comment|small|simple|single|one file|readme|typo)\b/i.test(description)
    this.initialRounds = simple ? 12 : large ? 32 : 22
    this.roundLimit = this.initialRounds
    this.hardRoundLimit = this.initialRounds + (large ? 16 : 8)
    this.toolLimit = this.roundLimit * 3
  }
  canStartRound(): boolean { return this.roundsUsed < this.roundLimit && this.toolCallsUsed < this.toolLimit }
  startRound(): void { this.roundsUsed++ }
  remaining(): number { return Math.max(0, this.roundLimit - this.roundsUsed) }
  approachingLimit(): boolean { return this.remaining() <= 3 }
  record(call: ProviderToolCall, outcome: string, useful: boolean): void {
    this.toolCallsUsed++
    if (useful) this.usefulActions++
    const signature = `${call.name}:${call.arguments.replace(/\s+/g, ' ').slice(0, 1000)}`, normalized = outcome.replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 500)
    const previous = this.signatures.get(signature), count = previous && previous.lastOutcome === normalized ? previous.count + 1 : 1
    this.signatures.set(signature, { count, lastOutcome: normalized })
    if (count >= 3 && (!useful || outcome.startsWith('ERROR:') || outcome.startsWith('No change'))) throw new LoopDetectedError(`${call.name} with the same arguments`, count)
  }
  extendForProgress(): boolean {
    if (this.roundLimit >= this.hardRoundLimit || this.usefulActions <= this.usefulAtExtension) return false
    this.usefulAtExtension = this.usefulActions; const extension = Math.min(8, this.hardRoundLimit - this.roundLimit); this.roundLimit += extension; this.toolLimit += extension * 3; return true
  }
  summary(): string { return `${this.toolCallsUsed} tool calls used; ${this.remaining()} rounds remain; ${this.usefulActions} actions produced measurable progress.` }
}
