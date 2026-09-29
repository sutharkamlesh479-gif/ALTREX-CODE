import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const brandingDir = resolve('assets/branding')

describe('official ALTREX branding', () => {
  it('retains the supplied Logo A wordmark source byte-for-byte', () => {
    const source = readFileSync(resolve(brandingDir, 'altrex-wordmark.png'))
    const hash = createHash('sha256').update(source).digest('hex')
    expect(hash).toBe('e54a767dd99f10562f38e557c07dfa3c5bfc4ac94ee1b14d513f73a63831269b')
  })

  it('packages every required Windows icon size', () => {
    const ico = readFileSync(resolve(brandingDir, 'altrex-app-icon.ico'))
    const imageCount = ico.readUInt16LE(4)
    const sizes = Array.from({ length: imageCount }, (_, index) => {
      const widthByte = ico.readUInt8(6 + index * 16)
      return widthByte === 0 ? 256 : widthByte
    })
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256])
  })

  it('keeps product identity and coding identity in their assigned surfaces', () => {
    const sidebar = readFileSync(resolve('src/renderer/src/components/Sidebar.tsx'), 'utf8')
    const home = readFileSync(resolve('src/renderer/src/components/HomeScreen.tsx'), 'utf8')
    const main = readFileSync(resolve('src/main/index.ts'), 'utf8')
    expect(sidebar).toContain('<AltrexLogo')
    expect(home).toMatch(/<AltrexCodeSymbol[^>]*>[\s\S]*What should we build\?/)
    expect(main).toContain("altrex-app-icon.ico?asset")
    expect(main).toContain('createSplashWindow')
  })
})
