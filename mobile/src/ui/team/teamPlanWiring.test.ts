import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('the real chat page keeps the composer and Stop while a team plan waits, and pops the sheet once per plan', () => {
  // Same harness as the other real-chat-page tests: native views become strings,
  // hooks are deterministic, and useTeamPlan returns whatever plan the case sets.
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let cursor = 0, slots = [], running = false, plan = null
    const native = { send() { return true }, scrollToOffset() {} }
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
    mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({ router: {}, useFocusEffect: () => {}, useLocalSearchParams: () => ({ id: 'team-review', host: 'fixture' }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-clipboard'))}, () => ({}))
    mock.module(${JSON.stringify(import.meta.resolve('../../state/AppContext'))}, () => ({ useApp: () => ({ drafts: new Map() }), useConnection: () => ({ client: null, host: { name: 'Fixture', auth: 'lan' } }) }))
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
      [${JSON.stringify(import.meta.resolve('./TeamPlanCard'))}, ['TeamPlanCard']],
      [${JSON.stringify(import.meta.resolve('./TeamPlanSheet'))}, ['TeamPlanSheet']],
      [${JSON.stringify(import.meta.resolve('../ChatComposer'))}, ['ChatComposer']],
      [${JSON.stringify(import.meta.resolve('../Message'))}, ['Message']],
      [${JSON.stringify(import.meta.resolve('../compose/RunSheet'))}, ['RunSheet']],
      [${JSON.stringify(import.meta.resolve('../activity/ActivityCapsule'))}, ['ActivityCapsule']],
      [${JSON.stringify(import.meta.resolve('../activity/ActivitySheet'))}, ['ActivitySheet']],
      [${JSON.stringify(import.meta.resolve('../chat/StatusCaption'))}, ['StatusCaption']],
      [${JSON.stringify(import.meta.resolve('../SessionChangesCard'))}, ['SessionChangesCard']],
      [${JSON.stringify(import.meta.resolve('../chat/StepGroup'))}, ['StepGroup', 'TurnFold']],
      [${JSON.stringify(import.meta.resolve('../chat/QueuedMessages'))}, ['QueuedMessages']],
      [${JSON.stringify(import.meta.resolve('../chat/OlderHistoryStatus'))}, ['OlderHistoryStatus']],
      [${JSON.stringify(import.meta.resolve('../chat/MessageMenu'))}, ['MessageMenu']],
      [${JSON.stringify(import.meta.resolve('../chat/sheets'))}, ['ConfirmSheet', 'EditResendSheet', 'RenameSheet', 'SelectTextSheet']],
    ]
    for (const [path, names] of views) mock.module(path, () => Object.fromEntries(names.map(name => [name, name])))
    mock.module(${JSON.stringify(import.meta.resolve('../activity/useNow'))}, () => ({ useNow: () => 1 }))
    mock.module(${JSON.stringify(import.meta.resolve('./useTeamPlan'))}, () => ({ useTeamPlan: () => ({ plan, pending: null, error: '', edit: async () => true, act: async () => true }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../chat/ContextSheet'))}, () => ({ ContextMenuHeader: 'ContextMenuHeader', ContextSheet: 'ContextSheet', useContextInspection: () => ({}) }))
    const { default: Chat } = require(${JSON.stringify(import.meta.resolve('../../app/chat/[id]'))})
    function find(node, type) {
      if (!node || typeof node !== 'object') return
      if (node.type === type) return node
      for (const child of [node.props?.children].flat(Infinity)) { const match = find(child, type); if (match) return match }
    }
    function page() { cursor = 0; const screen = Chat(); return screen.type(screen.props) }
    const review = (patch = {}) => ({ planId: 'p1', revision: 2, state: 'review_pending', teamName: 'taskboard', members: [], tasks: [], ...patch })

    // The lead is still working (an addition to a running team): Stop and typing stay available.
    running = true
    plan = review({ parentPlanId: 'p0' })
    let tree = page()
    const composer = find(tree, 'ChatComposer')
    assert.ok(composer, 'a plan under review must not take the composer away')
    assert.equal(typeof composer.props.onStop, 'function')
    assert.equal(composer.props.busy, true, 'the running turn keeps its Stop button')
    const card = find(composer.props.above, 'TeamPlanCard')
    assert.equal(card?.props.surface, 'review')
    assert.equal(find(tree, 'Approval'), undefined)

    // The sheet pops up once for a newly submitted plan, then only on request.
    tree = page()
    let sheet = find(tree, 'TeamPlanSheet')
    assert.equal(sheet.props.visible, true, 'a newly submitted plan pops the sheet up')
    sheet.props.onClose()
    plan = review({ parentPlanId: 'p0', revision: 3 })
    tree = page()
    assert.equal(find(tree, 'TeamPlanSheet').props.visible, false, 'editing the same plan must not pop it up again')
    find(find(tree, 'ChatComposer').props.above, 'TeamPlanCard').props.onOpen()
    assert.equal(find(page(), 'TeamPlanSheet').props.visible, true)

    // A different plan pops up again; a plan nobody has to act on shows nothing.
    plan = review({ planId: 'p2' })
    page()
    assert.equal(find(page(), 'TeamPlanSheet').props.visible, true)
    plan = review({ planId: 'p2', state: 'running' })
    tree = page()
    assert.equal(find(tree, 'TeamPlanSheet'), undefined)
    assert.equal(find(find(tree, 'ChatComposer').props.above, 'TeamPlanCard'), undefined)

    // A failed launch is a card above the composer without the sheet.
    running = false
    plan = review({ planId: 'p3', state: 'launch_failed' })
    tree = page()
    assert.equal(find(find(tree, 'ChatComposer').props.above, 'TeamPlanCard')?.props.surface, 'failed')
    assert.equal(find(tree, 'TeamPlanSheet'), undefined)
  `
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
