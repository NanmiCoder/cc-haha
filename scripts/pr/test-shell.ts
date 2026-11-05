import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'

/** Use Git's native Bash on Windows, never the unrelated WSL launcher. */
export function testBashPath(): string {
  if (process.platform !== 'win32') return 'bash'
  const git = (process.env.PATH ?? '').split(delimiter)
    .map(directory => join(directory.replace(/^"|"$/g, ''), 'git.exe'))
    .find(existsSync)
  const candidates = [
    ...(git ? [resolve(dirname(git), '../bin/bash.exe'), resolve(dirname(git), '../usr/bin/bash.exe')] : []),
    ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(root => resolve(root!, 'Git/bin/bash.exe')),
  ]
  const bash = candidates.find(existsSync)
  if (!bash) throw new Error('Git for Windows Bash is required for workflow shell tests')
  return bash
}

/** Bash accepts drive paths with forward slashes, including spaces. */
export function testShellPath(pathname: string): string {
  return process.platform === 'win32' ? pathname.replaceAll('\\', '/') : pathname
}
