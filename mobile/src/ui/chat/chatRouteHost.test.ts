import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

/**
 * 冷启动直接进聊天页时首页快照还是 null。不带 host 的链接（cchaha://chat/<id>）曾让页面拿
 * undefined 当 hostId，`dashboard?.hostId === hostId` 成立后读 null.activity 闪退。
 */
function renderHostlessChat(selectedId: string | undefined) {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let cursor = 0, slots = []
    const connections = []
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const id = cursor++
        if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial
        return [slots[id], next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }]
      },
      useRef(initial) { const id = cursor++; if (!(id in slots)) slots[id] = { current: initial }; return slots[id] },
      useMemo: fn => fn(), useCallback: fn => fn, useEffect: () => {}, useEffectEvent: fn => fn,
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ View: 'View', FlatList: 'FlatList', Platform: { OS: 'android' }, AppState: {} }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({ router: {}, useFocusEffect: () => {}, useLocalSearchParams: () => ({ id: 'cold-start' }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-clipboard'))}, () => ({}))
    mock.module(${JSON.stringify(import.meta.resolve('expo-crypto'))}, () => ({ getRandomValues: array => array }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-network'))}, () => ({ addNetworkStateListener: () => ({ remove() {} }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../../state/api'))}, () => ({ hostLinkFor: () => undefined, nativeSocketFactory: () => ({}), watchDeviceNetwork: () => () => {} }))
    mock.module(${JSON.stringify(import.meta.resolve('../../state/AppContext'))}, () => ({
      useApp: () => ({ drafts: new Map(), registry: { hosts: [], selectedId: ${JSON.stringify(selectedId ?? null)} ?? undefined } }),
      useConnection: (id) => { connections.push(id); return { client: null, host: undefined } },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../../state/DashboardContext'))}, () => ({ useDashboard: () => ({ snapshot: null }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../../core/useComputerUse'))}, () => ({ useComputerUse: () => ({ enabled: false }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../../core/sessionActivity'))}, () => ({ teamMembersAllStopped: () => false, useSessionActivity: () => ({ runningCount: 0 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      ...Object.fromEntries(['ActionMenu', 'Button', 'Callout', 'Card', 'FloatingButton', 'InlineError', 'Mono', 'NavBar', 'ScreenView', 'Spinner', 'Toast'].map(name => [name, name])),
      goBack() {}, useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../theme'))}, () => ({ errorText: String }))
    const views = [
      [${JSON.stringify(import.meta.resolve('../KeyboardViewport'))}, ['KeyboardViewport']],
      [${JSON.stringify(import.meta.resolve('../Approval'))}, ['Approval']],
      [${JSON.stringify(import.meta.resolve('../team/TeamPlanCard'))}, ['TeamPlanCard']],
      [${JSON.stringify(import.meta.resolve('../team/TeamPlanSheet'))}, ['TeamPlanSheet']],
      [${JSON.stringify(import.meta.resolve('../ChatComposer'))}, ['ChatComposer']],
      [${JSON.stringify(import.meta.resolve('../Message'))}, ['Message']],
      [${JSON.stringify(import.meta.resolve('../compose/RunSheet'))}, ['RunSheet']],
      [${JSON.stringify(import.meta.resolve('../activity/ActivityCapsule'))}, ['ActivityCapsule']],
      [${JSON.stringify(import.meta.resolve('../activity/ActivitySheet'))}, ['ActivitySheet']],
      [${JSON.stringify(import.meta.resolve('./StatusCaption'))}, ['StatusCaption']],
      [${JSON.stringify(import.meta.resolve('../SessionChangesCard'))}, ['SessionChangesCard']],
      [${JSON.stringify(import.meta.resolve('./StepGroup'))}, ['StepGroup', 'TurnFold']],
      [${JSON.stringify(import.meta.resolve('./QueuedMessages'))}, ['QueuedMessages']],
      [${JSON.stringify(import.meta.resolve('./OlderHistoryStatus'))}, ['OlderHistoryStatus']],
      [${JSON.stringify(import.meta.resolve('./MessageMenu'))}, ['MessageMenu']],
      [${JSON.stringify(import.meta.resolve('./sheets'))}, ['ConfirmSheet', 'EditResendSheet', 'RenameSheet', 'SelectTextSheet']],
    ]
    for (const [path, names] of views) mock.module(path, () => Object.fromEntries(names.map(name => [name, name])))
    mock.module(${JSON.stringify(import.meta.resolve('../activity/useNow'))}, () => ({ useNow: () => 1 }))
    mock.module(${JSON.stringify(import.meta.resolve('../team/useTeamPlan'))}, () => ({ useTeamPlan: () => ({ plan: null, pending: null, error: '' }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./ContextSheet'))}, () => ({ ContextMenuHeader: 'ContextMenuHeader', ContextSheet: 'ContextSheet', useContextInspection: () => ({}) }))
    const { default: Chat } = require(${JSON.stringify(import.meta.resolve('../../app/chat/[id]'))})
    const page = Chat()
    page.type(page.props)
    console.log(JSON.stringify({ key: page.key, hostId: page.props.hostId, connections }))
  `
  try {
    const out = execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(String(out).trim().split('\n').at(-1) ?? '{}') as {
      key: string
      hostId: string
      connections: string[]
    }
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
}

test('不带 host 的聊天链接冷启动时按当前电脑打开，不读空快照', () => {
  const page = renderHostlessChat('desk')
  expect(page.hostId).toBe('desk')
  expect(page.key).toBe('desk:cold-start')
  expect(page.connections).toEqual(['desk'])
})

test('一台电脑都没有时，不带 host 的聊天链接也不闪退', () => {
  const page = renderHostlessChat(undefined)
  expect(page.hostId).toBe('')
  expect(page.connections).toEqual([''])
})
