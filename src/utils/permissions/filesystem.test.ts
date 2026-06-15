import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Tool, ToolPermissionContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import {
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  getResolvedWorkingDirPaths,
} from './filesystem.js'

const pathTool = {
  name: 'PathTool',
  getPath(input: { file_path: string }) {
    return input.file_path
  },
} as unknown as Tool

function clearWorkingDirCache(): void {
  ;(getResolvedWorkingDirPaths.cache as { clear?: () => void }).clear?.()
}

function permissionContext(
  mode: ToolPermissionContext['mode'] = 'default',
): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    mode,
  }
}

describe('filesystem permissions for UNC working directories', () => {
  const uncWorkspace = '\\\\server\\share\\project'
  const insideWorkspace = `${uncWorkspace}\\issue591.txt`
  const outsideWorkspace = '\\\\server\\share\\project-extra\\issue591.txt'

  beforeEach(() => {
    resetStateForTests()
    setOriginalCwd(uncWorkspace)
    setCwdState(uncWorkspace)
    clearWorkingDirCache()
  })

  afterEach(() => {
    resetStateForTests()
    clearWorkingDirCache()
  })

  it('allows reads inside a UNC working directory on Windows', () => {
    if (process.platform !== 'win32') return

    const result = checkReadPermissionForTool(
      pathTool,
      { file_path: insideWorkspace },
      permissionContext(),
    )

    expect(result.behavior).toBe('allow')
  })

  it('does not mark writes inside a UNC working directory as a bypass-immune safety check', () => {
    if (process.platform !== 'win32') return

    const result = checkWritePermissionForTool(
      pathTool,
      { file_path: insideWorkspace },
      permissionContext(),
    )

    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).not.toBe('safetyCheck')
  })

  it('allows acceptEdits writes inside a UNC working directory on Windows', () => {
    if (process.platform !== 'win32') return

    const result = checkWritePermissionForTool(
      pathTool,
      { file_path: insideWorkspace },
      permissionContext('acceptEdits'),
    )

    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'mode',
      mode: 'acceptEdits',
    })
  })

  it('keeps UNC writes outside the working directory behind a safety check', () => {
    if (process.platform !== 'win32') return

    const result = checkWritePermissionForTool(
      pathTool,
      { file_path: outsideWorkspace },
      permissionContext('acceptEdits'),
    )

    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({
      type: 'safetyCheck',
    })
  })
})
