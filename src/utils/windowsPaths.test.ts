import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { tryFindGitBashPath } from './windowsPaths.js'

const originalOverride = process.env.CLAUDE_CODE_GIT_BASH_PATH
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  if (originalOverride === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH
  else process.env.CLAUDE_CODE_GIT_BASH_PATH = originalOverride
  tryFindGitBashPath.cache.clear!()
})

describe('Windows Git Bash discovery', () => {
  test('finds the standard Git installation without launching any process', () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH
    const git = 'C:\\Program Files\\Git\\cmd\\git.exe'
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    const exists = spyOn(fs, 'existsSync').mockImplementation(file => file === git || file === bash)
    cleanups.push(() => exists.mockRestore())
    const shell = spyOn(childProcess, 'execSync').mockImplementation(() => {
      throw new Error('Discovery must not launch cmd.exe')
    })
    cleanups.push(() => shell.mockRestore())
    const where = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('Standard installation does not need executable lookup')
    })
    cleanups.push(() => where.mockRestore())
    tryFindGitBashPath.cache.clear!()

    expect(tryFindGitBashPath()).toBe(bash)
    expect(shell).not.toHaveBeenCalled()
    expect(where).not.toHaveBeenCalled()
  })

  test('checks an explicit path as a literal file without launching a command shell', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-shell-discovery-'))
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
    const binary = path.join(directory, 'bash & 100%.exe')
    fs.writeFileSync(binary, '')
    process.env.CLAUDE_CODE_GIT_BASH_PATH = binary
    const shell = spyOn(childProcess, 'execSync').mockImplementation(() => {
      throw new Error('Filesystem discovery must not create a console')
    })
    cleanups.push(() => shell.mockRestore())
    tryFindGitBashPath.cache.clear!()

    expect(tryFindGitBashPath()).toBe(binary)
    expect(shell).not.toHaveBeenCalled()
    fs.unlinkSync(binary)
    tryFindGitBashPath.cache.clear!()
    expect(tryFindGitBashPath()).toBeNull()
    expect(shell).not.toHaveBeenCalled()
  })

  test('hides the where.exe fallback console and skips workspace executables', () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH
    const installedGit = path.resolve(os.tmpdir(), 'cc-haha-installed-git', 'cmd', 'git.exe')
    const installedBash = path.win32.join(installedGit, '..', '..', 'bin', 'bash.exe')
    const exists = spyOn(fs, 'existsSync').mockImplementation(file => file === installedBash)
    cleanups.push(() => exists.mockRestore())
    const where = spyOn(childProcess, 'execFileSync').mockReturnValue(
      `${path.join(process.cwd(), 'git.exe')}\r\n${installedGit}\r\n`,
    )
    cleanups.push(() => where.mockRestore())
    const shell = spyOn(childProcess, 'execSync').mockImplementation(() => {
      throw new Error('Discovery must not launch cmd.exe')
    })
    cleanups.push(() => shell.mockRestore())
    tryFindGitBashPath.cache.clear!()

    expect(tryFindGitBashPath()).toBe(installedBash)
    expect(where).toHaveBeenCalledWith('where.exe', ['git'], expect.objectContaining({
      encoding: 'utf8',
      windowsHide: true,
    }))
    expect(shell).not.toHaveBeenCalled()
  })
})
