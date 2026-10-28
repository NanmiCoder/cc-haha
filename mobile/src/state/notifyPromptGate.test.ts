import { describe, expect, test } from 'bun:test'
import {
  classifyPermission,
  continueNotifyPrompt,
  decideNotifyPrompt,
  emitPermissionDecided,
  subscribePermissionDecided,
  type NotifyGateInput,
} from './notifyPromptGate'

const ready: NotifyGateInput = {
  platform: 'ios',
  appReady: true,
  hostCount: 1,
  preferencesReady: true,
  preferencesError: false,
  prompted: false,
  permission: 'undetermined',
  onHome: true,
}

describe('classifyPermission', () => {
  test('Android reports denied before the first ask: still undetermined while it can ask again', () => {
    // OnePlus 9 / Android 14 实测：清数据后 status 是 denied、canAskAgain 是 true。
    expect(classifyPermission({ granted: false, status: 'denied', canAskAgain: true })).toBe(
      'undetermined'
    )
  })
  test('a real refusal can no longer be asked again', () => {
    expect(classifyPermission({ granted: false, status: 'denied', canAskAgain: false })).toBe(
      'denied'
    )
  })
  test('iOS undetermined and granted map straight through', () => {
    expect(classifyPermission({ granted: false, status: 'undetermined', canAskAgain: true })).toBe(
      'undetermined'
    )
    expect(classifyPermission({ granted: true, status: 'granted', canAskAgain: true })).toBe(
      'granted'
    )
  })
})

describe('decideNotifyPrompt', () => {
  test('shows once permission is undetermined and the user is home', () => {
    expect(decideNotifyPrompt(ready)).toBe('show')
    expect(decideNotifyPrompt({ ...ready, platform: 'android' })).toBe('show')
  })

  test('does not show while away from home', () => {
    expect(decideNotifyPrompt({ ...ready, onHome: false })).toBe('none')
  })

  test('waits for hosts, preferences and the permission read', () => {
    expect(decideNotifyPrompt({ ...ready, appReady: false })).toBe('none')
    expect(decideNotifyPrompt({ ...ready, hostCount: 0 })).toBe('none')
    expect(decideNotifyPrompt({ ...ready, preferencesReady: false })).toBe('none')
    expect(decideNotifyPrompt({ ...ready, preferencesError: true })).toBe('none')
    expect(decideNotifyPrompt({ ...ready, permission: 'unknown' })).toBe('none')
  })

  test('stays silent on web and after the prompt was handled', () => {
    expect(decideNotifyPrompt({ ...ready, platform: 'web' })).toBe('none')
    expect(
      decideNotifyPrompt({ ...ready, platform: 'web', permission: 'granted' })
    ).toBe('none')
    expect(decideNotifyPrompt({ ...ready, prompted: true })).toBe('none')
    expect(
      decideNotifyPrompt({ ...ready, prompted: true, permission: 'denied' })
    ).toBe('none')
  })

  test('marks prompted without a screen when the system already answered', () => {
    expect(decideNotifyPrompt({ ...ready, permission: 'granted' })).toBe('markPrompted')
    expect(decideNotifyPrompt({ ...ready, permission: 'denied' })).toBe('markPrompted')
    // 这类用户不需要停在首页，也不受所在页面影响。
    expect(
      decideNotifyPrompt({ ...ready, permission: 'denied', onHome: false })
    ).toBe('markPrompted')
  })
})

describe('continueNotifyPrompt', () => {
  type Deps = Parameters<typeof continueNotifyPrompt>[0]
  function recorder(overrides: (calls: string[]) => Partial<Deps> = () => ({})) {
    const calls: string[] = []
    const deps = {
      ensureChannel: async () => {
        calls.push('channel')
      },
      request: async () => {
        calls.push('request')
        return { granted: true }
      },
      markPrompted: async () => {
        calls.push('mark')
      },
      decided: () => {
        calls.push('decided')
      },
      ...overrides(calls),
    }
    return { calls, deps }
  }

  test('creates the channel before the system prompt, then marks prompted', async () => {
    const { calls, deps } = recorder()
    await continueNotifyPrompt(deps)
    expect(calls).toEqual(['channel', 'request', 'mark', 'decided'])
  })

  test('a denied answer still marks prompted', async () => {
    const { calls, deps } = recorder((calls) => ({
      request: async () => {
        calls.push('request')
        return { granted: false }
      },
    }))
    await continueNotifyPrompt(deps)
    expect(calls).toEqual(['channel', 'request', 'mark', 'decided'])
  })

  test('failures never trap the user', async () => {
    const { calls, deps } = recorder((calls) => ({
      ensureChannel: async () => {
        throw new Error('channel')
      },
      request: async () => {
        throw new Error('request')
      },
      markPrompted: async () => {
        calls.push('mark')
        throw new Error('storage')
      },
    }))
    await expect(continueNotifyPrompt(deps)).resolves.toBeUndefined()
    expect(calls).toEqual(['mark', 'decided'])
  })
})

describe('permission decided events', () => {
  test('notifies subscribers until they unsubscribe', () => {
    let count = 0
    const off = subscribePermissionDecided(() => {
      count += 1
    })
    emitPermissionDecided()
    off()
    emitPermissionDecided()
    expect(count).toBe(1)
  })
})
