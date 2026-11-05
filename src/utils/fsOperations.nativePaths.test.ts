import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext, type Tool } from '../Tool.js'
import { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } from '../bootstrap/state.js'
import { getFsImplementation } from './fsOperations.js'
import { checkWritePermissionForTool, getResolvedWorkingDirPaths, pathInAllowedWorkingPath } from './permissions/filesystem.js'

const pathTool = { name: 'PathFixture', getPath: (input: { file_path: string }) => input.file_path } as unknown as Tool
let root: string
let workspace: string
let aliases: string[]
let originalCwd: string
let currentCwd: string

function realAliases(directory: string): string[] {
  if (process.platform !== 'win32') {
    const alias = `${directory}-alias`
    symlinkSync(directory, alias, 'dir')
    return [alias]
  }
  // Query the OS's actual short spelling, without changing volume settings.
  // Case aliases also exercise canonical identity on volumes without 8.3 names.
  const script = join(root, 'short-path.cmd')
  writeFileSync(script, '@echo off\r\nfor %%I in ("%NATIVE_PATH_FIXTURE%") do @echo %%~sI\r\n')
  const result = Bun.spawnSync([script], { env: { ...process.env, NATIVE_PATH_FIXTURE: directory } })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const short = result.stdout.toString().trim()
  expect(short).not.toBe('')
  return [...new Set([short, directory.toUpperCase()])]
}

function clearCache() {
  ;(getResolvedWorkingDirPaths.cache as { clear?: () => void }).clear?.()
}

beforeEach(() => {
  originalCwd = getOriginalCwd()
  currentCwd = getCwdState()
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fs-native-paths-')))
  workspace = join(root, 'Permission Workspace Long Name')
  mkdirSync(workspace)
  aliases = realAliases(workspace)
  setOriginalCwd(workspace)
  setCwdState(workspace)
  clearCache()
})

afterEach(() => {
  setOriginalCwd(originalCwd)
  setCwdState(currentCwd)
  clearCache()
  rmSync(root, { recursive: true, force: true })
})

test('real filesystem aliases resolve to one native canonical spelling', () => {
  const expected = realpathSync.native(workspace).normalize('NFC')
  for (const alias of aliases) {
    expect(statSync(alias).ino).toBe(statSync(workspace).ino)
    expect(getFsImplementation().realpathSync(alias)).toBe(expected)
  }
})

test('working-directory aliases permit reads and acceptEdits writes to the same physical workspace', () => {
  const existing = join(workspace, 'existing.txt')
  writeFileSync(existing, 'fixture')
  const context = { ...getEmptyToolPermissionContext(), mode: 'acceptEdits' as const }
  for (const alias of aliases) {
    setOriginalCwd(alias)
    setCwdState(alias)
    expect(pathInAllowedWorkingPath(existing, context)).toBe(true)
    for (const target of [existing, join(workspace, 'new.txt')]) {
      expect(checkWritePermissionForTool(pathTool, { file_path: target }, context).behavior).toBe('allow')
    }
  }
})

test('approved auxiliary directory aliases permit new files without authorizing sibling directories', () => {
  const auxiliary = join(root, 'Approved Auxiliary Long Name')
  mkdirSync(auxiliary)
  const context = { ...getEmptyToolPermissionContext(), mode: 'acceptEdits' as const }
  for (const alias of realAliases(auxiliary)) {
    context.additionalWorkingDirectories = new Map([[alias, { path: alias, source: 'session' as const }]])
    expect(checkWritePermissionForTool(pathTool, { file_path: join(auxiliary, 'new.txt') }, context).behavior).toBe('allow')
    expect(checkWritePermissionForTool(pathTool, { file_path: join(root, 'unapproved.txt') }, context).behavior).toBe('ask')
  }
})

test('real directory links escaping the workspace remain outside the permission boundary', () => {
  const outside = join(root, 'Outside Workspace')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'fixture-only secret')
  const link = join(workspace, 'escape')
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const context = { ...getEmptyToolPermissionContext(), mode: 'acceptEdits' as const }
  expect(pathInAllowedWorkingPath(join(link, 'secret.txt'), context)).toBe(false)
  expect(checkWritePermissionForTool(pathTool, { file_path: join(link, 'new.txt') }, context).behavior).toBe('ask')
})
