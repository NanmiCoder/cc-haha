import { describe, it, expect } from 'vitest'

import { errorCountFromDiagnostics, toLegacyLspState } from './lspStateMap'
import type { LspDiagnostic, WorkspaceLspState } from '../types/lsp'

describe('toLegacyLspState', () => {
  it('returns starting when state is undefined (never loaded)', () => {
    const result = toLegacyLspState(undefined, 0, 'w1')
    expect(result).toEqual({ state: 'starting', workspaceId: 'w1', errorCount: 0 })
  })

  it('treats idle as starting so the pill does not flash unavailable', () => {
    const idle: WorkspaceLspState = { state: 'idle', path: null, serverName: null, command: null }
    expect(toLegacyLspState(idle, 0, 'w1')).toEqual({
      state: 'starting',
      workspaceId: 'w1',
      errorCount: 0,
    })
  })

  it('passes through starting', () => {
    const starting: WorkspaceLspState = { state: 'starting', path: null, serverName: null, command: null }
    expect(toLegacyLspState(starting, 0, 'w1')).toEqual({
      state: 'starting',
      workspaceId: 'w1',
      errorCount: 0,
    })
  })

  it('passes through ready and threads errorCount', () => {
    const ready: WorkspaceLspState = {
      state: 'ready',
      path: 'src/app.ts',
      serverName: 'typescript',
      command: 'typescript-language-server',
    }
    expect(toLegacyLspState(ready, 3, 'w1')).toEqual({
      state: 'ready',
      workspaceId: 'w1',
      errorCount: 3,
    })
  })

  it('maps unavailable to init-failed (Retry button) since wire shape lacks reason', () => {
    const unavailable: WorkspaceLspState = {
      state: 'unavailable',
      path: null,
      serverName: null,
      command: null,
      error: 'spawn ENOENT typescript-language-server',
    }
    expect(toLegacyLspState(unavailable, 0, 'w1')).toEqual({
      state: 'unavailable',
      workspaceId: 'w1',
      reason: 'init-failed',
      errorCount: 0,
      lastStderrTail: 'spawn ENOENT typescript-language-server',
    })
  })

  it('omits lastStderrTail when error string is absent', () => {
    const unavailable: WorkspaceLspState = {
      state: 'unavailable',
      path: null,
      serverName: null,
      command: null,
    }
    const result = toLegacyLspState(unavailable, 0, 'w1')
    expect(result).toEqual({
      state: 'unavailable',
      workspaceId: 'w1',
      reason: 'init-failed',
      errorCount: 0,
    })
  })
})

describe('errorCountFromDiagnostics', () => {
  function diag(severity: LspDiagnostic['severity']): LspDiagnostic {
    return { path: 'a.ts', line: 1, column: 1, severity, message: 'm' }
  }

  it('returns 0 when undefined or empty', () => {
    expect(errorCountFromDiagnostics(undefined)).toBe(0)
    expect(errorCountFromDiagnostics([])).toBe(0)
  })

  it('counts only error severity, not warning/info/hint', () => {
    expect(
      errorCountFromDiagnostics([
        diag('error'),
        diag('warning'),
        diag('error'),
        diag('info'),
        diag('hint'),
      ]),
    ).toBe(2)
  })
})
