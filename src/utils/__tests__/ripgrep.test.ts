import { afterEach, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { isUsableBuiltinRipgrepPath } from '../ripgrep.js'

const tempFiles: string[] = []

afterEach(async () => {
  await Promise.all(tempFiles.splice(0).map(path => rm(path, { force: true })))
})

describe('isUsableBuiltinRipgrepPath', () => {
  test('rejects Bun virtual filesystem paths', () => {
    expect(
      isUsableBuiltinRipgrepPath('B:\\~BUN\\root\\vendor\\ripgrep\\x64-win32\\rg.exe'),
    ).toBe(false)
    expect(
      isUsableBuiltinRipgrepPath('/$bunfs/root/vendor/ripgrep/arm64-darwin/rg'),
    ).toBe(false)
  })

  test('rejects missing paths', () => {
    expect(
      isUsableBuiltinRipgrepPath(join(tmpdir(), 'missing-yuanclaw-rg')),
    ).toBe(false)
  })

  test('accepts real filesystem paths', async () => {
    const filePath = join(tmpdir(), `yuanclaw-rg-${Date.now()}`)
    await writeFile(filePath, '')
    tempFiles.push(filePath)

    expect(isUsableBuiltinRipgrepPath(filePath)).toBe(true)
  })
})
