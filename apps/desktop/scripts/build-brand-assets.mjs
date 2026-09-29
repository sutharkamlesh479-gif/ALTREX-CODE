import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , logoASource, logoBSource] = process.argv

if (!logoASource || !logoBSource) {
  console.error('Usage: node scripts/build-brand-assets.mjs <logo-a.png> <logo-b.png>')
  process.exit(1)
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const outputDir = resolve(scriptDir, '../assets/branding')
const temporaryDir = mkdtempSync(join(tmpdir(), 'altrex-brand-'))
const iconSizes = [16, 24, 32, 48, 64, 128, 256]

function runFfmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
}

function createIco(pngPaths, outputPath) {
  const images = pngPaths.map((path) => readFileSync(path))
  const directorySize = 6 + images.length * 16
  const header = Buffer.alloc(directorySize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  let imageOffset = directorySize
  images.forEach((image, index) => {
    const size = iconSizes[index]
    const offset = 6 + index * 16
    header.writeUInt8(size === 256 ? 0 : size, offset)
    header.writeUInt8(size === 256 ? 0 : size, offset + 1)
    header.writeUInt8(0, offset + 2)
    header.writeUInt8(0, offset + 3)
    header.writeUInt16LE(1, offset + 4)
    header.writeUInt16LE(32, offset + 6)
    header.writeUInt32LE(image.length, offset + 8)
    header.writeUInt32LE(imageOffset, offset + 12)
    imageOffset += image.length
  })

  writeFileSync(outputPath, Buffer.concat([header, ...images]))
}

mkdirSync(outputDir, { recursive: true })

try {
  copyFileSync(resolve(logoASource), join(outputDir, 'altrex-wordmark.png'))

  runFfmpeg([
    '-i', resolve(logoASource),
    '-vf', 'crop=424:424:416:356,scale=1024:1024:flags=lanczos',
    '-frames:v', '1',
    join(outputDir, 'altrex-app-icon.png'),
  ])

  runFfmpeg([
    '-i', resolve(logoBSource),
    '-vf', 'crop=448:448:544:288,scale=896:896:flags=lanczos',
    '-frames:v', '1',
    join(outputDir, 'altrex-code-symbol.png'),
  ])

  const icoImages = iconSizes.map((size) => {
    const output = join(temporaryDir, `altrex-${size}.png`)
    runFfmpeg([
      '-i', join(outputDir, 'altrex-app-icon.png'),
      '-vf', `scale=${size}:${size}:flags=lanczos`,
      '-frames:v', '1',
      output,
    ])
    return output
  })

  createIco(icoImages, join(outputDir, 'altrex-app-icon.ico'))
  console.log(`ALTREX brand assets written to ${outputDir}`)
} finally {
  rmSync(temporaryDir, { recursive: true, force: true })
}

