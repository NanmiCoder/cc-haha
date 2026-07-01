import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROVIDER_COMPAT_STORAGE_KEY,
  PROVIDER_COMPAT_WARN_THRESHOLD,
  hasProviderCompatWarning,
  hasProviderThinkingIncompatible,
  useProviderCompatStore,
} from './providerCompatStore'
import { useUIStore } from './uiStore'

const initialUIState = useUIStore.getInitialState()

beforeEach(() => {
  window.localStorage.clear()
  useProviderCompatStore.getState().reset()
  useUIStore.setState(initialUIState, true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('providerCompatStore', () => {
  it('records counts per provider id', () => {
    const { recordFakeToolUse } = useProviderCompatStore.getState()
    recordFakeToolUse('provider-a', 'Bash')
    recordFakeToolUse('provider-a', 'Bash')
    recordFakeToolUse('provider-b', 'Edit')

    const events = useProviderCompatStore.getState().events
    expect(events['provider-a']?.count).toBe(2)
    expect(events['provider-b']?.count).toBe(1)
  })

  it('ignores null / undefined / empty providerId so we never miscredit a leak', () => {
    const { recordFakeToolUse } = useProviderCompatStore.getState()
    recordFakeToolUse(null, 'Bash')
    recordFakeToolUse(undefined, 'Bash')
    recordFakeToolUse('', 'Bash')
    expect(useProviderCompatStore.getState().events).toEqual({})
  })

  it('fires a toast exactly once when the warn threshold is reached', () => {
    const { recordFakeToolUse } = useProviderCompatStore.getState()

    for (let i = 0; i < PROVIDER_COMPAT_WARN_THRESHOLD - 1; i++) {
      recordFakeToolUse('provider-a', 'Bash')
    }
    expect(useUIStore.getState().toasts).toHaveLength(0)

    // Crossing event — toast should fire.
    recordFakeToolUse('provider-a', 'Bash')
    expect(useUIStore.getState().toasts).toHaveLength(1)
    const toast = useUIStore.getState().toasts[0]!
    expect(toast.type).toBe('warning')
    expect(toast.message).toContain('Bash')

    // Subsequent events do NOT re-toast — counter still bumps though.
    recordFakeToolUse('provider-a', 'Bash')
    recordFakeToolUse('provider-a', 'Bash')
    expect(useUIStore.getState().toasts).toHaveLength(1)
    expect(useProviderCompatStore.getState().events['provider-a']?.count).toBe(
      PROVIDER_COMPAT_WARN_THRESHOLD + 2,
    )
  })

  it('toasts independently for different providers', () => {
    const { recordFakeToolUse } = useProviderCompatStore.getState()
    for (let i = 0; i < PROVIDER_COMPAT_WARN_THRESHOLD; i++) {
      recordFakeToolUse('provider-a', 'Bash')
    }
    for (let i = 0; i < PROVIDER_COMPAT_WARN_THRESHOLD; i++) {
      recordFakeToolUse('provider-b', 'Edit')
    }
    expect(useUIStore.getState().toasts).toHaveLength(2)
  })

  it('persists events and warned set to localStorage', () => {
    const { recordFakeToolUse } = useProviderCompatStore.getState()
    for (let i = 0; i < PROVIDER_COMPAT_WARN_THRESHOLD; i++) {
      recordFakeToolUse('provider-a', 'Bash')
    }

    const raw = window.localStorage.getItem(PROVIDER_COMPAT_STORAGE_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.events['provider-a']?.count).toBe(PROVIDER_COMPAT_WARN_THRESHOLD)
    expect(parsed.warnedProviderIds).toContain('provider-a')
  })

  it('clearProvider resets both the count and the warned flag (re-arms the toast)', () => {
    const { recordFakeToolUse, clearProvider } = useProviderCompatStore.getState()
    for (let i = 0; i < PROVIDER_COMPAT_WARN_THRESHOLD; i++) {
      recordFakeToolUse('provider-a', 'Bash')
    }
    expect(useUIStore.getState().toasts).toHaveLength(1)

    clearProvider('provider-a')
    expect(useProviderCompatStore.getState().events['provider-a']).toBeUndefined()
    expect(useProviderCompatStore.getState().warnedProviderIds.has('provider-a')).toBe(false)

    // Threshold-crossing again — toast fires once more.
    for (let i = 0; i < PROVIDER_COMPAT_WARN_THRESHOLD; i++) {
      recordFakeToolUse('provider-a', 'Bash')
    }
    expect(useUIStore.getState().toasts).toHaveLength(2)
  })

  it('hasProviderCompatWarning reflects the current count vs threshold', () => {
    expect(hasProviderCompatWarning('provider-a')).toBe(false)
    expect(hasProviderCompatWarning(null)).toBe(false)
    expect(hasProviderCompatWarning(undefined)).toBe(false)

    const { recordFakeToolUse } = useProviderCompatStore.getState()
    for (let i = 0; i < PROVIDER_COMPAT_WARN_THRESHOLD - 1; i++) {
      recordFakeToolUse('provider-a', 'Bash')
    }
    expect(hasProviderCompatWarning('provider-a')).toBe(false)

    recordFakeToolUse('provider-a', 'Bash')
    expect(hasProviderCompatWarning('provider-a')).toBe(true)
  })

  it('hydrates events and warned set from localStorage on first load', async () => {
    window.localStorage.setItem(
      PROVIDER_COMPAT_STORAGE_KEY,
      JSON.stringify({
        events: { 'provider-a': { count: 5, lastSeenAt: 12345, lastToolName: 'Bash' } },
        warnedProviderIds: ['provider-a'],
      }),
    )

    vi.resetModules()
    const mod = await import('./providerCompatStore')
    expect(mod.useProviderCompatStore.getState().events['provider-a']?.count).toBe(5)
    expect(mod.useProviderCompatStore.getState().warnedProviderIds.has('provider-a')).toBe(true)
  })

  describe('thinking-incompatible flag', () => {
    it('records a thinking-incompatible provider id and fires a one-time toast', () => {
      const { recordThinkingIncompatible } = useProviderCompatStore.getState()
      recordThinkingIncompatible('provider-a', 'thinking is not supported')

      expect(
        useProviderCompatStore.getState().thinkingIncompatibleProviderIds.has('provider-a'),
      ).toBe(true)
      expect(useUIStore.getState().toasts).toHaveLength(1)
      expect(useUIStore.getState().toasts[0]!.type).toBe('warning')

      // Re-firing for the same provider must not double-toast (server may
      // re-emit on subsequent sidecar restarts).
      recordThinkingIncompatible('provider-a', 'thinking is not supported')
      expect(useUIStore.getState().toasts).toHaveLength(1)
    })

    it('persists the thinking-incompatible set to localStorage', () => {
      useProviderCompatStore.getState().recordThinkingIncompatible('provider-a', '')
      const raw = window.localStorage.getItem(PROVIDER_COMPAT_STORAGE_KEY)
      const parsed = JSON.parse(raw!)
      expect(parsed.thinkingIncompatibleProviderIds).toContain('provider-a')
    })

    it('hydrates the thinking-incompatible set from localStorage', async () => {
      window.localStorage.setItem(
        PROVIDER_COMPAT_STORAGE_KEY,
        JSON.stringify({
          events: {},
          warnedProviderIds: [],
          thinkingIncompatibleProviderIds: ['provider-a'],
        }),
      )
      vi.resetModules()
      const mod = await import('./providerCompatStore')
      expect(
        mod.useProviderCompatStore.getState().thinkingIncompatibleProviderIds.has('provider-a'),
      ).toBe(true)
      expect(mod.hasProviderThinkingIncompatible('provider-a')).toBe(true)
    })

    it('clearProvider removes both the fake-tool_use counter AND the thinking flag (re-arm both)', () => {
      const { recordFakeToolUse, recordThinkingIncompatible, clearProvider } =
        useProviderCompatStore.getState()
      for (let i = 0; i < PROVIDER_COMPAT_WARN_THRESHOLD; i++) {
        recordFakeToolUse('provider-a', 'Bash')
      }
      recordThinkingIncompatible('provider-a', 'rejected')
      expect(
        useProviderCompatStore.getState().thinkingIncompatibleProviderIds.has('provider-a'),
      ).toBe(true)
      expect(useProviderCompatStore.getState().events['provider-a']).toBeDefined()

      clearProvider('provider-a')
      expect(
        useProviderCompatStore.getState().thinkingIncompatibleProviderIds.has('provider-a'),
      ).toBe(false)
      expect(useProviderCompatStore.getState().events['provider-a']).toBeUndefined()
    })

    it('ignores empty / null / undefined providerId so a stray server event never miscredits', () => {
      const { recordThinkingIncompatible } = useProviderCompatStore.getState()
      recordThinkingIncompatible(null, 'rejected')
      recordThinkingIncompatible(undefined, 'rejected')
      recordThinkingIncompatible('', 'rejected')
      expect(
        useProviderCompatStore.getState().thinkingIncompatibleProviderIds.size,
      ).toBe(0)
    })

    it('hasProviderThinkingIncompatible returns false until the provider is flagged', () => {
      const { recordThinkingIncompatible } = useProviderCompatStore.getState()
      expect(hasProviderThinkingIncompatible('provider-a')).toBe(false)
      recordThinkingIncompatible('provider-a', '')
      expect(hasProviderThinkingIncompatible('provider-a')).toBe(true)
    })
  })
})
