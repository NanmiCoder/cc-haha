import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionListItem } from '../types/session'
import { useSessionRuntimeStore } from './sessionRuntimeStore'

const EXPECTED_GROK_SELECTION = {
  providerId: 'grok-official',
  modelId: 'grok-4.7',
  effortLevel: 'high',
}

describe('sessionRuntimeStore runtime cleanup', () => {
  beforeEach(() => {
    localStorage.clear()
    useSessionRuntimeStore.setState({ selections: {} })
  })

  it('keeps an explicit model choice through stale, matching, then stale metadata refreshes', () => {
    const store = useSessionRuntimeStore.getState()
    const oldSession = {
      id: 'switch-session', runtimeProviderId: 'kimi', runtimeModelId: 'k3[1m]',
    } as SessionListItem
    store.syncFromSessions([oldSession])
    const next = { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
    store.setSelection(oldSession.id, next)
    const startedWith = useSessionRuntimeStore.getState().selections

    for (const metadata of [oldSession, {
      ...oldSession, runtimeProviderId: next.providerId, runtimeModelId: next.modelId,
    }, oldSession]) {
      store.syncFromSessions([metadata], startedWith)
      expect(useSessionRuntimeStore.getState().selections[oldSession.id]).toEqual(next)
      expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)[oldSession.id]).toEqual(next)
    }
  })

  it('accepts later remote changes after confirmation but ignores pre-confirmation requests', () => {
    const store = useSessionRuntimeStore.getState()
    const next = { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
    store.setSelection('confirmed', next)
    const oldRequest = useSessionRuntimeStore.getState().selections
    store.settleSelection('confirmed')
    const remote = { id: 'confirmed', runtimeProviderId: 'kimi', runtimeModelId: 'k3' } as SessionListItem
    store.syncFromSessions([remote], oldRequest)
    expect(useSessionRuntimeStore.getState().selections.confirmed).toEqual(next)
    store.syncFromSessions([remote], useSessionRuntimeStore.getState().selections)
    expect(useSessionRuntimeStore.getState().selections.confirmed).toEqual({ providerId: 'kimi', modelId: 'k3' })
  })

  it('preserves a moved draft choice and releases local ownership when cleared', () => {
    const store = useSessionRuntimeStore.getState()
    const next = { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
    const metadata = {
      id: 'new-session', runtimeProviderId: 'kimi', runtimeModelId: 'k3',
    } as SessionListItem
    store.setSelection('__draft__', next)
    store.moveSelection('__draft__', metadata.id)
    store.syncFromSessions([metadata])
    expect(useSessionRuntimeStore.getState().selections[metadata.id]).toEqual(next)
    store.clearSelection(metadata.id)
    store.syncFromSessions([metadata])
    expect(useSessionRuntimeStore.getState().selections[metadata.id]).toEqual({ providerId: 'kimi', modelId: 'k3' })
  })

  it.each(['grok-build', 'grok-composer-2.5-fast'])(
    'discards the retired Grok model %s before persisting it',
    (retiredModelId) => {
      useSessionRuntimeStore.getState().setSelection('session-grok', {
        providerId: 'grok-official',
        modelId: retiredModelId,
        effortLevel: 'max',
      })

      expect(useSessionRuntimeStore.getState().selections['session-grok']).toEqual(
        EXPECTED_GROK_SELECTION,
      )
      expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
        'session-grok': EXPECTED_GROK_SELECTION,
      })
    },
  )

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

  it('preserves a custom-provider xhigh selection loaded from localStorage', async () => {
    localStorage.setItem('cc-haha-session-runtime', JSON.stringify({
      'session-loaded-kimi': {
        providerId: 'kimi-provider',
        modelId: 'k3',
        effortLevel: 'xhigh',
      },
    }))
    vi.resetModules()

    const { useSessionRuntimeStore: loadedStore } = await import('./sessionRuntimeStore')

    const expectedSelection = {
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'xhigh',
    }
    expect(loadedStore.getState().selections['session-loaded-kimi']).toEqual(
      expectedSelection,
    )
    expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
      'session-loaded-kimi': expectedSelection,
    })
  })

  it('drops only the legacy Claude Official opus[1m] default and preserves the same suffix for third-party providers', async () => {
    localStorage.setItem('cc-haha-session-runtime', JSON.stringify({
      'session-loaded-claude': {
        providerId: null,
        modelId: 'opus[1m]',
        effortLevel: 'max',
      },
      'session-loaded-minimax': {
        providerId: 'provider-minimax',
        modelId: 'MiniMax-M3[1m]',
        effortLevel: 'max',
      },
    }))
    vi.resetModules()

    const { useSessionRuntimeStore: loadedStore } = await import('./sessionRuntimeStore')

    expect(loadedStore.getState().selections['session-loaded-claude']).toBeUndefined()
    expect(loadedStore.getState().selections['session-loaded-minimax']).toEqual({
      providerId: 'provider-minimax',
      modelId: 'MiniMax-M3[1m]',
      effortLevel: 'max',
    })
    expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
      'session-loaded-minimax': {
        providerId: 'provider-minimax',
        modelId: 'MiniMax-M3[1m]',
        effortLevel: 'max',
      },
    })
  })

  it('does not restore a legacy Claude Official default from old session metadata', () => {
    useSessionRuntimeStore.getState().syncFromSessions([{
      id: 'legacy-claude-session',
      runtimeProviderId: null,
      runtimeModelId: 'opus[1m]',
      effortLevel: 'max',
    } as SessionListItem])

    expect(useSessionRuntimeStore.getState().selections['legacy-claude-session']).toBeUndefined()
  })
})
