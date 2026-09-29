import { describe, expect, it } from 'vitest'
import { applyUnifiedPatch } from '../tools/patch'
import { unifiedDiff } from './text-diff'

describe('unifiedDiff', () => {
  it('produces hunks that apply back to the new content', () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
    const after = before.replace('line 3\n', 'line three\n').replace('line 25\n', '').concat('line 31\n')
    const diff = unifiedDiff('a.txt', before, after)
    expect(diff).toMatch(/^--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ -1,6 \+1,6 @@/)
    expect(diff).toContain('-line 3\n+line three')
    expect(applyUnifiedPatch(before, diff)).toBe(after)
  })
  it('handles added, deleted and unchanged files', () => {
    expect(unifiedDiff('n.ts', null, 'x\ny\n')).toBe('--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n')
    expect(unifiedDiff('d.ts', 'x\n', null)).toBe('--- a/d.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n')
    expect(unifiedDiff('s.ts', 'same\n', 'same\n')).toBe('')
  })
})
