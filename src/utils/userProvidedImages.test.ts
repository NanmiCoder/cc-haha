import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  clearUserProvidedImages,
  isUserProvidedImage,
  registerUserProvidedImage,
} from './userProvidedImages.js'

let scratchDir: string | undefined

afterEach(async () => {
  clearUserProvidedImages()
  if (scratchDir) await rm(scratchDir, { recursive: true, force: true })
  scratchDir = undefined
})

describe('userProvidedImages', () => {
  test('stores the real path so a symlinked attachment still matches', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'user-images-'))
    const realDirectory = join(scratchDir, 'original')
    const aliasDirectory = join(scratchDir, 'alias')
    await mkdir(realDirectory)
    const realPath = join(realDirectory, 'portrait.png')
    const linkPath = join(aliasDirectory, 'portrait.png')
    await writeFile(realPath, 'png')
    await symlink(realDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir')

    await registerUserProvidedImage(linkPath)

    // Callers realpath() before asking, so the link must resolve to the same key.
    expect(isUserProvidedImage(await realpath(realPath))).toBe(true)
  })

  test('does not authorize a path that was never registered', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'user-images-'))
    const unregistered = join(scratchDir, 'private.png')
    await writeFile(unregistered, 'png')

    expect(isUserProvidedImage(await realpath(unregistered))).toBe(false)
  })

  test('ignores a path that does not exist', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'user-images-'))
    const missing = join(scratchDir, 'missing.png')

    await registerUserProvidedImage(missing)

    expect(isUserProvidedImage(missing)).toBe(false)
  })

  test('evicts the oldest entries past the cap but keeps reused ones', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'user-images-'))
    const paths: string[] = []
    for (let index = 0; index < 200; index++) {
      const filePath = join(scratchDir, `image-${index}.png`)
      await writeFile(filePath, 'png')
      paths.push(await realpath(filePath))
      await registerUserProvidedImage(filePath)
    }

    // Re-registering the oldest entry moves it back to the newest position.
    await registerUserProvidedImage(paths[0]!)

    const overflowPath = join(scratchDir, 'overflow.png')
    await writeFile(overflowPath, 'png')
    await registerUserProvidedImage(overflowPath)

    expect(isUserProvidedImage(paths[0]!)).toBe(true)
    expect(isUserProvidedImage(await realpath(overflowPath))).toBe(true)
    // paths[1] was the oldest once paths[0] was refreshed.
    expect(isUserProvidedImage(paths[1]!)).toBe(false)
  })

  test('clearUserProvidedImages drops every authorization', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'user-images-'))
    const filePath = join(scratchDir, 'portrait.png')
    await writeFile(filePath, 'png')
    await registerUserProvidedImage(filePath)
    const resolved = await realpath(filePath)
    expect(isUserProvidedImage(resolved)).toBe(true)

    clearUserProvidedImages()

    expect(isUserProvidedImage(resolved)).toBe(false)
  })
})
