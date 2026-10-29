import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test.each(['ios', 'android'])('%s: short conversations keep both messages mounted without native clipping', (platform) => {
  // Execute the real screen with native views substituted, as in the other
  // mobile UI tests. Browser geometry separately checks the resulting layout.
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = await import(${JSON.stringify(import.meta.resolve('react'))})
    let items = [{ id: 'u1', type: 'user', text: 'hello' }]
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React,
      useState(initial) {
        const value = typeof initial === 'function' ? initial() : initial
        return [value && Array.isArray(value.items) ? { ...value, items } : value, () => {}]
      },
      useRef: current => ({ current }),
      useMemo: fn => fn(),
      useCallback: fn => fn,
      useEffect: () => {},
      useEffectEvent: fn => fn,
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      View: 'View', FlatList: 'FlatList', Platform: { OS: ${JSON.stringify(platform)} }, AppState: {},
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 44, bottom: 34 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({
      router: {}, useFocusEffect: () => {}, useLocalSearchParams: () => ({ id: 'fixture', host: 'fixture' }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-clipboard'))}, () => ({}))
    mock.module(${JSON.stringify(import.meta.resolve('../../state/AppContext'))}, () => ({
      useApp: () => ({ drafts: new Map() }), useConnection: () => ({ client: null, host: { name: 'Fixture' } }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../../state/DashboardContext'))}, () => ({ useDashboard: () => ({ snapshot: null }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../../core/useComputerUse'))}, () => ({ useComputerUse: () => ({ enabled: false }) }))
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
    mock.module(${JSON.stringify(import.meta.resolve('./ContextSheet'))}, () => ({
      ContextMenuHeader: 'ContextMenuHeader', ContextSheet: 'ContextSheet', useContextInspection: () => ({}),
    }))
    const { default: Chat } = await import(${JSON.stringify(import.meta.resolve('../../app/chat/[id]'))})
    function find(node, type) {
      if (!node || typeof node !== 'object') return
      if (node.type === type) return node
      for (const child of [node.props?.children].flat(Infinity)) {
        const match = find(child, type)
        if (match) return match
      }
    }
    function timeline() { const screen = Chat(); return find(screen.type(screen.props), 'FlatList').props }
    let list = timeline()
    assert.equal(list.inverted, true, 'keep native latest tracking when content grows or the keyboard resizes the viewport')
    assert.equal(list.contentContainerStyle.flexGrow, 1)
    // An inverted list flips flex-start to the screen bottom. The empty space
    // must go before the latest-first rows, placing the oldest at the top.
    assert.equal(list.contentContainerStyle.justifyContent, 'flex-end', 'the first message must sit below the navigation bar, not beside the composer')
    assert.equal(list.data.length, 1)
    assert.equal(list.data[0].item.id, 'u1')
    // Android defaults to detaching clipped native children. During a stack
    // transition, an inverted/flex-end cell can be laid out outside the old
    // clipping rectangle and only reattached after the first scroll.
    items = [items[0], { id: 'a1', type: 'assistant', text: 'hi' }]
    list = timeline()
    assert.deepEqual(list.data.map(row => row.item.id), ['a1', 'u1'], 'both short messages are mounted before any scroll or older-history request')
    const nativeClipping = list.removeClippedSubviews ?? (${JSON.stringify(platform)} === 'android')
    assert.equal(nativeClipping, false, 'short cached conversations must not wait for an Android scroll to reattach the first message')
    // A fresh screen instance (returning from the task list) has the same
    // complete history and must not depend on an onScroll side effect.
    const reopened = timeline()
    assert.deepEqual(reopened.data.map(row => row.item.id), ['a1', 'u1'])
    assert.equal(reopened.removeClippedSubviews ?? (${JSON.stringify(platform)} === 'android'), false)
    items = [...items, { id: 'u2', type: 'user', text: 'again' }]
    list = timeline()
    assert.deepEqual(list.data.filter(row => row.kind === 'message').map(row => row.item.id).reverse(), ['u1', 'a1', 'u2'])
    assert.equal(list.maintainVisibleContentPosition, undefined, 'at latest, native inversion continues tracking newly appended content')
    assert.equal(list.keyboardShouldPersistTaps, 'handled', 'attachment preview must still receive taps while typing')
  `
  execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
})
