import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  canonicalizeFilesystemAccessPath,
  clearFilesystemAccessRootsForTests,
  isWithinRegisteredFilesystemRoot,
  registerChangedFileAccessRoot,
  registerCanonicalFilesystemAccessRoot,
  registerFilesystemAccessRoot,
} from './filesystemAccessRoots.js'

describe('registerChangedFileAccessRoot', () => {
  beforeEach(() => clearFilesystemAccessRootsForTests())
  afterEach(() => clearFilesystemAccessRootsForTests())

  it('uses the same canonical spelling as async filesystem reads, including Windows short paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-access-alias-'))
    try {
      const file = path.join(root, 'preview.html')
      fs.writeFileSync(file, 'fixture')
      const canonicalRoot = await fs.promises.realpath(root)
      expect(canonicalizeFilesystemAccessPath(root)).toBe(canonicalRoot)
      registerFilesystemAccessRoot(root)
      expect(isWithinRegisteredFilesystemRoot(await fs.promises.realpath(file))).toBe(true)
      expect(canonicalizeFilesystemAccessPath(path.join(root, 'missing', 'child.html'))).toBe(path.join(canonicalRoot, 'missing', 'child.html'))
      expect(isWithinRegisteredFilesystemRoot(path.join(`${canonicalRoot}-other`, 'private.html'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('registers an already verified canonical root without repeating native I/O', () => {
    const realpath = spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw new Error('Unexpected main-thread realpath') })
    try {
      registerCanonicalFilesystemAccessRoot('/verified/project')
      expect(realpath).not.toHaveBeenCalled()
    } finally { realpath.mockRestore() }
    expect(isWithinRegisteredFilesystemRoot('/verified/project/file.txt')).toBe(true)
    expect(isWithinRegisteredFilesystemRoot('/verified/other/file.txt')).toBe(false)
  })

  it('registers the containing dir of a changed file outside the workdir', () => {
    registerChangedFileAccessRoot('/elsewhere/proj/todo.html', '/work/dir')
    expect(isWithinRegisteredFilesystemRoot('/elsewhere/proj/todo.html')).toBe(true)
    // sibling assets in the same dir become previewable too (html needs its css/js)
    expect(isWithinRegisteredFilesystemRoot('/elsewhere/proj/style.css')).toBe(true)
    // an unrelated dir stays denied
    expect(isWithinRegisteredFilesystemRoot('/elsewhere/other/secret.txt')).toBe(false)
  })

  it('skips files already inside the workdir (already previewable)', () => {
    registerChangedFileAccessRoot('/work/dir/sub/page.html', '/work/dir')
    expect(isWithinRegisteredFilesystemRoot('/work/dir/sub/page.html')).toBe(false)
  })

  it('registers when no workdir context is given', () => {
    registerChangedFileAccessRoot('/scratch/a/b.html', null)
    expect(isWithinRegisteredFilesystemRoot('/scratch/a/b.html')).toBe(true)
  })

  it('ignores empty / nullish input', () => {
    registerChangedFileAccessRoot('', '/work/dir')
    registerChangedFileAccessRoot(null, '/work/dir')
    registerChangedFileAccessRoot(undefined, '/work/dir')
    expect(isWithinRegisteredFilesystemRoot('/anything')).toBe(false)
  })
})
