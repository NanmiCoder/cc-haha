import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  useSessionRuntimeStore,
  type SessionHandoffInfo,
} from './sessionRuntimeStore'

const STORAGE_KEY = 'cc-haha-session-handoff'

const sampleHandoff: SessionHandoffInfo = {
  previousSessionId: 'prev-id',
  previousSessionTitle: '上次会话标题',
  approxTokens: 1234,
  generatedAt: '2026-06-10T08:00:00.000Z',
}

describe('sessionRuntimeStore — handoffInfo', () => {
  beforeEach(() => {
    localStorage.clear()
    // Reset zustand store with empty maps in all three slots.
    useSessionRuntimeStore.setState({
      selections: {},
      coordinatorModes: {},
      handoffInfo: {},
    })
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('setHandoffInfo persists to store and to localStorage', () => {
    useSessionRuntimeStore.getState().setHandoffInfo('session-a', sampleHandoff)

    expect(useSessionRuntimeStore.getState().handoffInfo['session-a']).toEqual(sampleHandoff)
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(persisted['session-a']).toEqual(sampleHandoff)
  })

  it('clearHandoffInfo removes the entry from store and localStorage', () => {
    useSessionRuntimeStore.getState().setHandoffInfo('session-a', sampleHandoff)
    useSessionRuntimeStore.getState().setHandoffInfo('session-b', { ...sampleHandoff, previousSessionId: 'other' })

    useSessionRuntimeStore.getState().clearHandoffInfo('session-a')

    expect(useSessionRuntimeStore.getState().handoffInfo['session-a']).toBeUndefined()
    expect(useSessionRuntimeStore.getState().handoffInfo['session-b']).toBeDefined()
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(persisted['session-a']).toBeUndefined()
    expect(persisted['session-b']).toBeDefined()
  })

  it('clearHandoffInfo on a missing key is a no-op (does not touch state)', () => {
    const before = useSessionRuntimeStore.getState()
    useSessionRuntimeStore.getState().clearHandoffInfo('nonexistent')
    const after = useSessionRuntimeStore.getState()
    expect(after.handoffInfo).toBe(before.handoffInfo)
  })

  it('clearSelection also drops handoffInfo for the same key', () => {
    useSessionRuntimeStore.getState().setHandoffInfo('session-a', sampleHandoff)
    useSessionRuntimeStore.getState().setSelection('session-a', {
      providerId: 'p',
      modelId: 'm',
    })

    useSessionRuntimeStore.getState().clearSelection('session-a')

    expect(useSessionRuntimeStore.getState().selections['session-a']).toBeUndefined()
    expect(useSessionRuntimeStore.getState().handoffInfo['session-a']).toBeUndefined()
  })

  it('moveSelection migrates handoffInfo to the new key', () => {
    useSessionRuntimeStore.getState().setHandoffInfo('draft-key', sampleHandoff)
    useSessionRuntimeStore.getState().setSelection('draft-key', {
      providerId: 'p',
      modelId: 'm',
    })

    useSessionRuntimeStore.getState().moveSelection('draft-key', 'real-session-id')

    expect(useSessionRuntimeStore.getState().handoffInfo['draft-key']).toBeUndefined()
    expect(useSessionRuntimeStore.getState().handoffInfo['real-session-id']).toEqual(sampleHandoff)
    expect(useSessionRuntimeStore.getState().selections['real-session-id']).toEqual({
      providerId: 'p',
      modelId: 'm',
    })
  })

  it('handoffInfo is independent of coordinatorModes (mutual non-interference)', () => {
    useSessionRuntimeStore.getState().setHandoffInfo('session-a', sampleHandoff)
    useSessionRuntimeStore.getState().setCoordinatorMode('session-a', true)

    expect(useSessionRuntimeStore.getState().handoffInfo['session-a']).toEqual(sampleHandoff)
    expect(useSessionRuntimeStore.getState().coordinatorModes['session-a']).toBe(true)

    useSessionRuntimeStore.getState().clearHandoffInfo('session-a')

    expect(useSessionRuntimeStore.getState().handoffInfo['session-a']).toBeUndefined()
    expect(useSessionRuntimeStore.getState().coordinatorModes['session-a']).toBe(true)
  })
})
