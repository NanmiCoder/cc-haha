import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRelocatedAttachmentPath, readStorageRelocations, resolveRelocatedAttachmentPath } from './storageRelocations.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('managed attachment relocation', () => {
  test('maps attachment prefixes across multiple migrations without changing project references', () => {
    for (const prefix of ['uploads', 'image-cache', 'im-downloads', 'cc-haha/generated-images']) {
      expect(mapRelocatedAttachmentPath(`/old/${prefix}/session/file.png`, '/new', ['/older', '/old'], 'darwin'))
        .toBe(`/new/${prefix}/session/file.png`)
    }
    for (const file of ['/old/projects/repo/file.txt', '/old/settings.json', '/oldish/uploads/a.png', '/old/uploads/../settings.json', '/project/image.png', 'uploads/image.png']) {
      expect(mapRelocatedAttachmentPath(file, '/new', ['/old'], 'darwin')).toBe(file)
    }
  })

  test('handles Windows roots case-insensitively, cross-drive moves and separator aliases', () => {
    expect(mapRelocatedAttachmentPath('c:/OLD/Uploads/session/a.png', 'D:\\data', ['C:\\old'], 'win32'))
      .toBe('D:\\data\\Uploads\\session\\a.png')
    expect(mapRelocatedAttachmentPath('C:\\old2\\uploads\\a.png', 'D:\\data', ['C:\\old'], 'win32'))
      .toBe('C:\\old2\\uploads\\a.png')
  })

  test('resolves a copied upload with its original root absent, and defaults to no mapping for old installations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storage-relocation-'))
    directories.push(root)
    const oldRoot = join(root, 'absent-original')
    const currentRoot = join(root, 'current')
    const oldPath = join(oldRoot, 'uploads', 'session', 'a.png')
    expect(resolveRelocatedAttachmentPath(oldPath, currentRoot)).toBe(oldPath)
    await mkdir(join(currentRoot, 'cc-haha'), { recursive: true })
    await writeFile(join(currentRoot, 'cc-haha', 'storage-relocations.json'), JSON.stringify({ version: 1, previousRoots: [oldRoot], futureField: true }))
    expect(resolveRelocatedAttachmentPath(oldPath, currentRoot)).toBe(join(currentRoot, 'uploads', 'session', 'a.png'))
    expect(readStorageRelocations(currentRoot).futureField).toBe(true)
  })

  test('does not interpret malformed or future metadata as permission to fall back to old storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storage-relocation-invalid-'))
    directories.push(root)
    await mkdir(join(root, 'cc-haha'))
    for (const data of ['{', JSON.stringify({ version: 2, previousRoots: [] }), JSON.stringify({ version: 1, previousRoots: ['relative'] })]) {
      await writeFile(join(root, 'cc-haha', 'storage-relocations.json'), data)
      expect(() => readStorageRelocations(root)).toThrow()
    }
  })
})
