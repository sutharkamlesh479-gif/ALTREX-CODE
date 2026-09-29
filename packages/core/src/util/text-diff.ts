// Line-based unified diff (LCS) for showing a task's changes to the reviewer and the UI. Bounded: very
// large files are summarized instead of diffed.

const MAX_CELLS = 4_000_000

type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number }

function operations(before: string[], after: string[]): Op[] | null {
  const n = before.length, m = after.length
  if ((n + 1) * (m + 1) > MAX_CELLS) return null
  const width = m + 1, table = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * width + j] = before[i] === after[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
  }
  const ops: Op[] = []
  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) { ops.push({ kind: ' ', text: before[i]!, a: i, b: j }); i++; j++ }
    else if (i < n && (j >= m || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { ops.push({ kind: '-', text: before[i]!, a: i, b: j }); i++ }
    else { ops.push({ kind: '+', text: after[j]!, a: i, b: j }); j++ }
  }
  return ops
}

const lines = (text: string | null) => (text === null || text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'))

/** Unified diff of one file. `null` content means the file does not exist on that side. */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  const a = lines(before), b = lines(after)
  const header = `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ ${after === null ? '/dev/null' : `b/${path}`}\n`
  const ops = operations(a, b)
  if (!ops) return `${header}@@ file too large for an inline diff (${a.length} → ${b.length} lines); read it directly @@\n`
  const changed = ops.map((op, index) => (op.kind !== ' ' ? index : -1)).filter(index => index >= 0)
  if (!changed.length) return ''
  const hunks: string[] = []
  let start = 0
  while (start < changed.length) {
    let end = start
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! <= context * 2) end++
    const from = Math.max(0, changed[start]! - context), to = Math.min(ops.length - 1, changed[end]! + context)
    const slice = ops.slice(from, to + 1)
    const oldStart = slice.find(op => op.kind !== '+')?.a ?? slice[0]!.a, newStart = slice.find(op => op.kind !== '-')?.b ?? slice[0]!.b
    const oldCount = slice.filter(op => op.kind !== '+').length, newCount = slice.filter(op => op.kind !== '-').length
    hunks.push(`@@ -${oldCount ? oldStart + 1 : oldStart},${oldCount} +${newCount ? newStart + 1 : newStart},${newCount} @@\n${slice.map(op => `${op.kind}${op.text}`).join('\n')}\n`)
    start = end + 1
  }
  return header + hunks.join('')
}
