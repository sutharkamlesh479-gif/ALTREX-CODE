// Best-effort output parsers for common test runners. They only report counts they actually find in the
// output; when nothing is recognized the caller reports the exit code alone (never an invented count).

export type ParsedCounts = { passed?: number | undefined; failed?: number | undefined; skipped?: number | undefined; failingTests?: string[] | undefined }

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')
const num = (value: string | undefined) => (value === undefined ? undefined : Number(value))
const defined = (counts: ParsedCounts): ParsedCounts | undefined => {
  const result = Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== undefined && !(Array.isArray(value) && !value.length))) as ParsedCounts
  return Object.keys(result).length ? result : undefined
}

export function parseTestOutput(raw: string): ParsedCounts | undefined {
  const text = strip(raw)
  // vitest: "Tests  2 failed | 40 passed | 1 skipped (43)"
  const vitest = /^\s*Tests\s+((?:\d+\s+\w+(?:\s*\|\s*)?)+)\s*\(\d+\)/m.exec(text)
  if (vitest) {
    const part = (word: string) => num(new RegExp(`(\\d+)\\s+${word}`).exec(vitest[1]!)?.[1])
    const failing = [...text.matchAll(/^\s*(?:×|✗|FAIL)\s+(.+?)(?:\s+\d+ms)?$/gm)].map(match => match[1]!.trim()).slice(0, 50)
    return defined({ passed: part('passed'), failed: part('failed'), skipped: part('skipped') ?? part('todo'), failingTests: failing })
  }
  // jest: "Tests:       1 failed, 12 passed, 13 total"
  const jest = /^Tests:\s+(.+?)\s+total/m.exec(text)
  if (jest) {
    const part = (word: string) => num(new RegExp(`(\\d+) ${word}`).exec(jest[1]!)?.[1])
    const failing = [...text.matchAll(/^\s*●\s+(.+)$/gm)].map(match => match[1]!.trim()).slice(0, 50)
    return defined({ passed: part('passed'), failed: part('failed'), skipped: part('skipped') ?? part('todo'), failingTests: [...new Set(failing)] })
  }
  // pytest: "==== 2 failed, 10 passed, 1 skipped in 0.12s ===="
  const pytest = /=+\s+((?:\d+\s+\w+,?\s*)+)in\s+[\d.]+s/.exec(text)
  if (pytest) {
    const part = (word: string) => num(new RegExp(`(\\d+) ${word}`).exec(pytest[1]!)?.[1])
    const failing = [...text.matchAll(/^FAILED\s+(\S+)/gm)].map(match => match[1]!).slice(0, 50)
    return defined({ passed: part('passed'), failed: part('failed') ?? part('error'), skipped: part('skipped'), failingTests: failing })
  }
  // node:test (TAP summary): "# pass 5" / "# fail 1"
  const tapPass = /^# pass (\d+)/m.exec(text), tapFail = /^# fail (\d+)/m.exec(text)
  if (tapPass || tapFail) return defined({ passed: num(tapPass?.[1]), failed: num(tapFail?.[1]), skipped: num(/^# skipped (\d+)/m.exec(text)?.[1]) })
  // cargo: "test result: FAILED. 3 passed; 1 failed; 0 ignored"
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)]
  if (cargo.length) {
    const sum = (index: number) => cargo.reduce((total, match) => total + Number(match[index]), 0)
    return defined({ passed: sum(1), failed: sum(2), skipped: sum(3), failingTests: [...text.matchAll(/^---- (\S+) stdout ----/gm)].map(match => match[1]!).slice(0, 50) })
  }
  // go test: count "--- PASS"/"--- FAIL" lines
  const goPass = text.match(/^\s*--- PASS: /gm)?.length ?? 0, goFail = [...text.matchAll(/^\s*--- FAIL: (\S+)/gm)]
  if (goPass || goFail.length) return defined({ passed: goPass, failed: goFail.length, failingTests: goFail.map(match => match[1]!).slice(0, 50) })
  return undefined
}

/**
 * Stable identity of a failure for repair-loop bookkeeping: the check name plus the first failing test ids
 * or the first error lines, with numbers, paths' line/column positions and durations normalized away.
 */
export function failureSignature(check: string, output: string, parsed?: ParsedCounts): string {
  if (parsed?.failingTests?.length) return `${check}:${parsed.failingTests.slice(0, 3).join('|')}`.slice(0, 200)
  const lines = strip(output).split(/\r?\n/).filter(line => /error|fail|exception|cannot|undefined|expected/i.test(line)).slice(0, 3)
  const normalized = lines.map(line => line.replace(/:\d+(:\d+)?/g, ':N').replace(/\b\d+(\.\d+)?(ms|s)\b/g, 'T').replace(/\s+/g, ' ').trim()).join('|')
  return `${check}:${normalized || 'exit'}`.slice(0, 200)
}
