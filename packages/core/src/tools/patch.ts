// Unified-diff application for one file (TOOL_SYSTEM.md §2 `fs.patch`). Atomic: every hunk must apply or
// nothing changes. Hunks are located by their content (preferring the position closest to the header's
// line number), tolerating stale line numbers; a whitespace-insensitive match is the fallback.

type Hunk = { oldStart: number; oldLines: string[]; newLines: string[] }

export class PatchError extends Error {}

function parse(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  // The patch's own final newline is a terminator, not an empty context line.
  for (const raw of patch.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('diff ') || raw.startsWith('index ')) continue
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw)
    if (header) { current = { oldStart: Number(header[1]), oldLines: [], newLines: [] }; hunks.push(current); continue }
    if (!current) continue
    if (raw.startsWith('\\')) continue // "\ No newline at end of file"
    const marker = raw[0], text = raw.slice(1)
    if (marker === ' ' || raw === '') { current.oldLines.push(raw === '' ? '' : text); current.newLines.push(raw === '' ? '' : text) }
    else if (marker === '-') current.oldLines.push(text)
    else if (marker === '+') current.newLines.push(text)
    else throw new PatchError(`Unrecognized patch line: ${raw.slice(0, 80)}`)
  }
  if (!hunks.length) throw new PatchError('The patch contains no hunks (expected unified diff "@@ -a,b +c,d @@" sections).')
  return hunks
}

function locate(lines: string[], block: string[], expected: number, from: number): number {
  const matches = (compare: (a: string, b: string) => boolean) => {
    const found: number[] = []
    for (let start = from; start + block.length <= lines.length; start++) if (block.every((line, offset) => compare(lines[start + offset]!, line))) found.push(start)
    return found
  }
  let found = matches((a, b) => a === b)
  if (!found.length) found = matches((a, b) => a.trim() === b.trim())
  if (!found.length) return -1
  return found.reduce((best, start) => (Math.abs(start - expected) < Math.abs(best - expected) ? start : best))
}

/** Apply a unified diff to `original`, preserving its line endings. Throws PatchError if any hunk fails. */
export function applyUnifiedPatch(original: string, patch: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const endsWithNewline = /\r?\n$/.test(original)
  const lines = original.replace(/\r\n/g, '\n').split('\n')
  if (endsWithNewline) lines.pop()
  let offset = 0, searchFrom = 0
  parse(patch).forEach((hunk, index) => {
    if (!hunk.oldLines.length) { // pure insertion at a line number
      const at = Math.min(lines.length, Math.max(0, hunk.oldStart + offset))
      lines.splice(at, 0, ...hunk.newLines); offset += hunk.newLines.length; searchFrom = at + hunk.newLines.length; return
    }
    const start = locate(lines, hunk.oldLines, hunk.oldStart - 1 + offset, searchFrom)
    if (start < 0) throw new PatchError(`Hunk ${index + 1} (near line ${hunk.oldStart}) does not match the current file. Read the file again and regenerate the patch.`)
    lines.splice(start, hunk.oldLines.length, ...hunk.newLines)
    offset += hunk.newLines.length - hunk.oldLines.length
    searchFrom = start + hunk.newLines.length
  })
  return lines.join(eol) + (endsWithNewline ? eol : '')
}
