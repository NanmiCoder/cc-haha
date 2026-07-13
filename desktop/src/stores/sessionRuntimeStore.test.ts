import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionListItem } from '../types/session'
import { useSessionRuntimeStore } from './sessionRuntimeStore'

const EXPECTED_GROK_SELECTION = {
  providerId: 'grok-official',
  modelId: 'grok-4.5',
  effortLevel: 'high',
}

describe('sessionRuntimeStore Grok runtime cleanup', () => {
  beforeEach(() => {
    localStorage.clear()
    useSessionRuntimeStore.setState({ selections: {} })
  })

  it('discards retired Grok selections before persisting them', () => {
    useSessionRuntimeStore.getState().setSelection('session-grok', {
      providerId: 'grok-official',
      modelId: 'grok-build',
      effortLevel: 'max',
    })

    expect(useSessionRuntimeStore.getState().selections['session-grok']).toEqual(
      EXPECTED_GROK_SELECTION,
    )
    expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
      'session-grok': EXPECTED_GROK_SELECTION,
    })
  })

  it('does not let retired Grok session metadata restore the removed model', () => {
    useSessionRuntimeStore.getState().syncFromSessions([{
      id: 'session-restored-grok',
      runtimeProviderId: 'grok-official',
      runtimeModelId: 'grok-build',
      effortLevel: 'max',
    } as SessionListItem])

    expect(useSessionRuntimeStore.getState().selections['session-restored-grok']).toEqual(
      EXPECTED_GROK_SELECTION,
    )
  })

  it('cleans a retired Grok selection loaded from localStorage', async () => {
    localStorage.setItem('cc-haha-session-runtime', JSON.stringify({
      'session-loaded-grok': {
        providerId: 'grok-official',
        modelId: 'grok-build',
        effortLevel: 'max',
      },
    }))
    vi.resetModules()

    const { useSessionRuntimeStore: loadedStore } = await import('./sessionRuntimeStore')

    expect(loadedStore.getState().selections['session-loaded-grok']).toEqual(
      EXPECTED_GROK_SELECTION,
    )
    expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
      'session-loaded-grok': EXPECTED_GROK_SELECTION,
    })
  })
})
