import { describe, expect, test } from 'bun:test'
import { recordedCommandIsReadOnly } from './readOnlyValidation'

// Session rewind uses this to decide whether a command that already ran could
// have written files the checkpoint never captured. A false positive here makes
// undo silently under-report; a false negative only adds a coverage warning, so
// everything unproven must land on `false`.
describe('recordedCommandIsReadOnly', () => {
  test('accepts allowlisted inspection commands', () => {
    for (const command of [
      'git status --short',
      'git diff',
      'git log --oneline -5',
      'ls -la',
      'cat package.json',
      'grep -rn foo src/',
      'rg foo',
      'pwd',
      'wc -l src/a.ts',
      'echo hi',
      'git status 2>&1',
      'ls && git status',
    ]) {
      expect(recordedCommandIsReadOnly(command), command).toBe(true)
    }
  })

  test('rejects commands that write, delete, or run arbitrary code', () => {
    for (const command of [
      'printf written > shell.txt',
      'rm -rf dist',
      'sed -i s/a/b/ f.ts',
      'mv a b',
      'cp a b',
      'mkdir -p out',
      'touch new.ts',
      'npm test',
      'bun test',
      'npm install',
      'python script.py',
      'node build.js',
      'git commit -m x',
      'git checkout .',
    ]) {
      expect(recordedCommandIsReadOnly(command), command).toBe(false)
    }
  })

  test('rejects a compound command when any part can write', () => {
    expect(recordedCommandIsReadOnly('git status && rm -rf x')).toBe(false)
    expect(recordedCommandIsReadOnly('ls; printf x > f.txt')).toBe(false)
    expect(recordedCommandIsReadOnly('cat a.txt | tee b.txt')).toBe(false)
  })

  test('rejects an otherwise read-only command that redirects into a file', () => {
    // The reader itself writes nothing, but the shell creates the target — the
    // most common way a "harmless" command changes the workspace.
    expect(recordedCommandIsReadOnly('echo a > file.txt')).toBe(false)
    expect(recordedCommandIsReadOnly('echo a >> file.txt')).toBe(false)
    expect(recordedCommandIsReadOnly('git diff > patch.diff')).toBe(false)
    expect(recordedCommandIsReadOnly('grep x a.ts > b.ts')).toBe(false)
    // Discarding output is still read-only.
    expect(recordedCommandIsReadOnly('echo a > /dev/null')).toBe(true)
  })

  test('rejects commands whose effect cannot be resolved from the text', () => {
    // Empty, expansion-dependent, or hook-capable git forms.
    expect(recordedCommandIsReadOnly('')).toBe(false)
    expect(recordedCommandIsReadOnly('   ')).toBe(false)
    expect(recordedCommandIsReadOnly('ls $HOME')).toBe(false)
    expect(recordedCommandIsReadOnly('ls $(whoami)')).toBe(false)
    expect(recordedCommandIsReadOnly('cd /tmp && git status')).toBe(false)
    expect(recordedCommandIsReadOnly('git -c core.fsmonitor=evil status')).toBe(false)
    expect(recordedCommandIsReadOnly('mkdir -p hooks && git status')).toBe(false)
  })

  test('rejects a non-string command', () => {
    expect(recordedCommandIsReadOnly(undefined as unknown as string)).toBe(false)
    expect(recordedCommandIsReadOnly(null as unknown as string)).toBe(false)
  })
})
