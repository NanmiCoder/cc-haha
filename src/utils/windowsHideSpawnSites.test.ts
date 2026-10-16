import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The desktop sidecar and the CLI it launches each own an invisible console that
// their children inherit (desktop/scripts/assert-windows-console-subsystem.ts).
// `windowsHide` keeps these console children windowless even if that chain is
// lost again, as it was in v0.7.2 (#1489, #1583). GUI launches such as Explorer
// are the opposite case and live elsewhere (see #983).
const SRC_ROOT = join(import.meta.dir, '..')
const GUARDED_FILES = [
  'server/api/computer-use.ts',
  'server/api/sessions.ts',
  'server/services/repositoryLaunchService.ts',
  'server/services/reviewService.ts',
  'server/services/searchService.ts',
  'server/services/workspaceService.ts',
  'utils/Shell.ts',
  'utils/auth.ts',
  'utils/bash/ShellSnapshot.ts',
  'utils/ripgrep.ts',
  'utils/settings/mdm/rawRead.ts',
  'utils/windowsPaths.ts',
]
const SPAWN_CALL = /(?<!function )(?<![\w.])(?:Bun\.spawn|spawnSync|spawn|execFileSync|execFile|exec)\(/g

function spawnCallArguments(source: string): Array<{ line: number; args: string }> {
  const calls: Array<{ line: number; args: string }> = []
  for (const match of source.matchAll(SPAWN_CALL)) {
    const start = match.index! + match[0].length
    let depth = 1
    let end = start
    while (end < source.length && depth > 0) {
      const char = source[end]
      if (char === '(') depth++
      else if (char === ')') depth--
      end++
    }
    calls.push({
      line: source.slice(0, match.index).split('\n').length,
      args: source.slice(start, end - 1),
    })
  }
  return calls
}

describe('Windows console spawn sites', () => {
  test.each(GUARDED_FILES)('%s hides every child console window', (file) => {
    const calls = spawnCallArguments(readFileSync(join(SRC_ROOT, file), 'utf8'))
    expect(calls.length).toBeGreaterThan(0)
    const unhidden = calls
      .filter(call => !/\bwindowsHide:\s*true\b/.test(call.args))
      .map(call => `${file}:${call.line}`)
    expect(unhidden).toEqual([])
  })

  test('the scanner flags a spawn call without windowsHide', () => {
    const calls = spawnCallArguments([
      'export async function exec(command: string) {}',
      "execFile('git', ['status'], { cwd, windowsHide: true })",
      "Bun.spawn(['rg', '--version'], { stdout: 'pipe' })",
    ].join('\n'))
    expect(calls.map(call => /\bwindowsHide:\s*true\b/.test(call.args))).toEqual([true, false])
  })
})
