import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import {
  clearFilesystemAccessRootsForTests,
  isWithinRegisteredFilesystemRoot,
  registerChangedFileAccessRoot,
  registerCanonicalFilesystemAccessRoot,
} from './filesystemAccessRoots.js'

describe('registerChangedFileAccessRoot', () => {
  beforeEach(() => clearFilesystemAccessRootsForTests())
  afterEach(() => clearFilesystemAccessRootsForTests())

  it('registers an already verified canonical root without repeating native I/O', () => {
    const realpath = spyOn(fs, 'realpathSync').mockImplementation(() => { throw new Error('Unexpected main-thread realpath') })
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
