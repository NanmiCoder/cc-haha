import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { resetStateForTests, setCwdState, setOriginalCwd } from '../../bootstrap/state.js'
import { getResolvedWorkingDirPaths } from '../../utils/permissions/filesystem.js'
import * as ripgrep from '../../utils/ripgrep.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import { GlobTool } from './GlobTool.js'

let root: string
let workspace: string
let outside: string
const testGlobals = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
const originalMacro = testGlobals.MACRO

function context(overrides: Partial<ToolPermissionContext> = {}): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), ...overrides } }),
  } as unknown as ToolUseContext
}

beforeEach(async () => {
  testGlobals.MACRO = originalMacro ?? { VERSION: 'glob-permission-test' }
  // Windows TEMP may contain an 8.3 username. Use its canonical spelling so
  // these scope tests do not accidentally exercise the suspicious-path guard.
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'glob-permissions-')))
  workspace = join(root, 'workspace')
  outside = join(root, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  resetStateForTests()
  setCwdState(workspace)
  setOriginalCwd(workspace)
  getResolvedWorkingDirPaths.cache.clear?.()
})

afterEach(async () => {
  if (originalMacro === undefined) delete testGlobals.MACRO
  else testGlobals.MACRO = originalMacro
  resetStateForTests()
  getResolvedWorkingDirPaths.cache.clear?.()
  await rm(root, { recursive: true, force: true })
})

describe('Glob effective search-root permissions', () => {
  it('requires approval for an absolute pattern outside the workspace without path', async () => {
    const input = { pattern: join(outside, '**', '*.env') }
    expect((await GlobTool.checkPermissions(input, context())).behavior).toBe('ask')
    expect(GlobTool.getPath(input)).toBe(outside)
  })

  it('does not let an explicit workspace path conceal an absolute pattern root', async () => {
    const input = { path: workspace, pattern: join(outside, '**', '*.env') }
    expect((await GlobTool.checkPermissions(input, context())).behavior).toBe('ask')
    expect(GlobTool.getPath(input)).toBe(outside)
  })

  it('honors a path deny rule for the actual pattern root', async () => {
    const input = { path: workspace, pattern: join(outside, '**', '*.env') }
    const absoluteRulePath = windowsPathToPosixPath(outside)
    const result = await GlobTool.checkPermissions(input, context({
      alwaysDenyRules: { session: [`Read(/${absoluteRulePath}/**)`] },
    }))
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason?.type).toBe('rule')
  })

  it('keeps relative workspace patterns and absolute in-workspace patterns allowed', async () => {
    for (const pattern of ['**/*.ts', join(workspace, '**', '*.ts')]) {
      expect((await GlobTool.checkPermissions({ pattern }, context())).behavior).toBe('allow')
      expect(GlobTool.getPath({ pattern })).toBe(workspace)
    }
  })

  it('uses the same search root for permission checks and ripgrep execution', async () => {
    const input = { path: workspace, pattern: join(outside, '**', '*.env') }
    const search = spyOn(ripgrep, 'ripGrep').mockResolvedValue(['fixture.env'])
    try {
      await GlobTool.call(input, context())
      expect(search).toHaveBeenCalledTimes(1)
      expect(search.mock.calls[0]![1]).toBe(GlobTool.getPath(input))
      expect(search.mock.calls[0]![1]).toBe(outside)
    } finally {
      search.mockRestore()
    }
  })

  it('checks the drive/filesystem root for a root-level absolute wildcard', async () => {
    const rootPath = parse(outside).root
    const input = { pattern: join(rootPath, '*.env') }
    expect(GlobTool.getPath(input)).toBe(rootPath)
    expect((await GlobTool.checkPermissions(input, context())).behavior).toBe('ask')
  })
})
