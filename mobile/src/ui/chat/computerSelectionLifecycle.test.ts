import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('the real chat page preserves failed selections, consumes sent or queued selections and restores withdrawn ones', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    const drafts = new Map(), sends = []
    let cursor = 0, slots = [], running = false, accepted = false
    const native = { send(message) { sends.push(message); return accepted }, scrollToOffset() {} }
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const id = cursor++
        if (!(id in slots)) { const value = typeof initial === 'function' ? initial() : initial; slots[id] = value === 'connecting' ? 'ready' : value }
        const value = slots[id]
        return [value && Array.isArray(value.items) ? { ...value, turnActive: running } : value, next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }]
      },
      useRef(initial) { const id = cursor++; if (!(id in slots)) slots[id] = { current: initial === null ? native : initial }; return slots[id] },
      useMemo: fn => fn(), useCallback: fn => fn, useEffect: () => {}, useEffectEvent: fn => fn,
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ View: 'View', FlatList: 'FlatList', Platform: { OS: 'ios' }, AppState: {} }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 44, bottom: 34 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({ router: {}, useFocusEffect: () => {}, useLocalSearchParams: () => ({ id: 'computer-lifecycle', host: 'fixture' }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-clipboard'))}, () => ({}))
    mock.module(${JSON.stringify(import.meta.resolve('../../state/AppContext'))}, () => ({ useApp: () => ({ drafts }), useConnection: () => ({ client: null, host: { name: 'Fixture', auth: 'lan' } }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../../state/DashboardContext'))}, () => ({ useDashboard: () => ({ snapshot: null }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../../core/useComputerUse'))}, () => ({ useComputerUse: () => ({ enabled: true }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../../core/sessionActivity'))}, () => ({ useSessionActivity: () => ({ runningCount: 0 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      ...Object.fromEntries(['ActionMenu', 'Button', 'Callout', 'Card', 'FloatingButton', 'InlineError', 'Mono', 'NavBar', 'ScreenView', 'Spinner'].map(name => [name, name])),
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
    const { computerUseReference } = require(${JSON.stringify(import.meta.resolve('../../core/computerUse'))})
    function find(node, type) {
      if (!node || typeof node !== 'object') return
      if (node.type === type) return node
      for (const child of [node.props?.children].flat(Infinity)) { const match = find(child, type); if (match) return match }
    }
    function composer() { cursor = 0; const page = Chat(); return find(page.type(page.props), 'ChatComposer').props }
    let box = composer()
    box.onDraft('用电脑检查')
    box.onReferences([computerUseReference])
    box.onTeam(true)
    box = composer()
    box.onSend()
    box = composer()
    assert.equal(box.draft, '用电脑检查')
    assert.equal(box.references[0].id, 'computer-use', 'a failed socket send must keep the current message selection')
    accepted = true
    box.onSend()
    box = composer()
    assert.equal(box.draft, '')
    assert.deepEqual(box.references, [])
    assert.equal(box.team, false)
    assert.ok(sends.at(-1).content.includes(computerUseReference.modelText))
    assert.ok(sends.at(-1).content.includes('<agent-team-request>'))
    running = true
    box.onDraft('下一轮继续检查')
    box.onReferences([computerUseReference])
    box = composer()
    const sentBeforeQueue = sends.length
    box.onSend()
    box = composer()
    assert.deepEqual(box.references, [])
    assert.equal(box.draft, '')
    assert.equal(sends.length, sentBeforeQueue, 'busy turns keep the message local until it can be sent')
    const queued = find(box.above, 'QueuedMessages').props
    assert.equal(queued.items[0].references[0].id, 'computer-use')
    assert.ok(queued.items[0].message.content.includes(computerUseReference.modelText))
    queued.onWithdraw(queued.items[0].id)
    box = composer()
    assert.equal(box.draft, '下一轮继续检查')
    assert.equal(box.references[0].id, 'computer-use')
    assert.equal(box.computer.enabled, true)
    assert.equal(sends.length, sentBeforeQueue)
  `
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
