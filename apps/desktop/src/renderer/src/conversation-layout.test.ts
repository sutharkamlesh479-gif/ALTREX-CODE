import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('conversation scrolling layout', () => {
  it('keeps scrolling inside the message list without moving outer page layers', () => {
    const app = readFileSync(resolve('src/renderer/src/useAltrex.ts'), 'utf8')
    const css = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')

    expect(app).toContain('messageListRef.current')
    expect(app).toContain("list.scrollTo({ top: list.scrollHeight")
    expect(app).not.toContain('scrollIntoView')
    expect(css).toContain('.main-canvas:has(.conversation-active) { overflow: hidden; }')
    expect(css).toMatch(/\.message-list[^}]*overscroll-behavior: contain/)
  })
})
