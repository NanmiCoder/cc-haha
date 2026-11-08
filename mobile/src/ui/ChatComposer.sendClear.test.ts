import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

// React Native applies a controlled value from JS only when JS has seen every change the
// native field made (it compares event counts); Android silently drops it otherwise. On an
// emulator, a fast typist's last keys landing with the send tap left the whole sent message
// in the box: either the keyboard's commit arrived while the finger was on the button (the
// tap ran on a render without it), or it arrived after the clear and reported the sent text
// back.
test('on Android the keyboard racing the send can neither drop a key nor put the sent message back', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    // Hooks of the composer itself keep state, refs and effect deps between renders;
    // nested components rendered by flatten() get throwaway ones.
    let slots = [], slot = 0, inComposer = false, effects = []
    const keep = initial => {
      const index = slot++
      if (!(index in slots)) slots[index] = initial()
      return index
    }
    const useState = initial => {
      const value = typeof initial === 'function' ? initial() : initial
      if (!inComposer) return [value, () => {}]
      const index = keep(() => value)
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    }
    let focused = true, fieldRef = false
    const field = { blur() {}, focus() {}, isFocused: () => focused }
    // The composer's first empty ref is the text field.
    const useRef = initial => {
      const ref = () => ({ current: initial === null && !fieldRef ? (fieldRef = true, field) : initial })
      return inComposer ? slots[keep(ref)] : ref()
    }
    const useEffect = (effect, deps) => {
      if (!inComposer) return
      const cell = slots[keep(() => ({}))]
      if (cell.deps && deps && deps.every((value, index) => Object.is(value, cell.deps[index]))) return
      cell.deps = deps
      effects.push(effect)
    }
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({ ...React, default: React, useState, useRef, useEffect }))
    const Platform = { OS: 'android' }
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) }, Linking: { openSettings: async () => {} },
      Platform, Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-linear-gradient'))}, () => ({ LinearGradient: 'LinearGradient' }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({ Icon: 'Icon', Mono: 'Mono', Spinner: 'Spinner', useColors: () => ({}) }))
    mock.module(${JSON.stringify(import.meta.resolve('./theme'))}, () => ({ errorText: String }))
    mock.module(${JSON.stringify(import.meta.resolve('./chatMaterials'))}, () => ({ pickChatMaterial: async () => [] }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/BringSheet'))}, () => ({ BringSheet: 'BringSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/glyphs'))}, () => ({ Glyph: 'Glyph' }))
    mock.module(${JSON.stringify(import.meta.resolve('./chat/ImagePreview'))}, () => ({ ImagePreview: 'ImagePreview' }))
    mock.module(${JSON.stringify(import.meta.resolve('../core/useVoiceDictation'))}, () => ({
      useVoiceDictation: () => ({
        phase: 'idle', live: false, startedAt: 0, limitSeconds: 120, sendRequested: false, issue: null, pendingText: null,
        getLevel: () => 0, start() {}, stop() {}, stopAndSend() {}, cancel() {}, edited() {}, insertPending() {}, dismissPending() {}, dismissIssue() {},
      }),
    }))
    const { ChatComposer } = require(${JSON.stringify(import.meta.resolve('./ChatComposer'))})
    const sent = []
    // The chat page: a send that goes out empties the draft, one that cannot keeps it.
    let delivers = true
    const props = {
      client: { host: { id: 'phone-fixture' } }, sessionId: 'fixture-chat',
      draft: '', onDraft: value => { props.draft = value }, references: [], onReferences: () => {}, attachments: [], onAttachments: () => {},
      team: false, onTeam: () => {}, computer: { enabled: false }, lean: false, empty: false, busy: false, disabled: false,
      run: { label: '测试模型', risk: 'normal' }, onOpenRun: () => {}, onError: () => {},
    }
    // Like the page's own handler, the send sees the draft of the render it came from and
    // says whether it took it.
    const pageSend = draft => () => {
      if (!delivers) return false
      sent.push(draft)
      props.draft = ''
      return true
    }
    globalThis.requestAnimationFrame = () => 0
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return [node, ...flatten(node.type(node.props))]
      return [node, ...flatten(node.props?.children)]
    }
    // One render and its commit. Its effects run right after, unless held: React runs
    // passive effects after paint, so newer native changes can be handled before them.
    let hold = false, held = []
    const render = () => {
      slot = 0
      props.onSend = pageSend(props.draft)
      inComposer = true
      let tree
      try { tree = flatten(ChatComposer(props)) } finally { inComposer = false }
      const pending = effects
      effects = []
      if (hold) held.push(...pending)
      else for (const effect of pending) effect()
      return tree
    }
    const runHeld = () => { hold = false; for (const effect of held.splice(0)) effect() }
    const input = () => render().find(node => node.type === 'TextInput')
    const sendButton = () => render().find(node => node.type === 'Pressable' && node.props.accessibilityLabel === '发送')
    // The native field reports a change, then where its caret went.
    const native = value => {
      input().props.onChangeText(value)
      input().props.onSelectionChange({ nativeEvent: { selection: { start: value.length, end: value.length } } })
    }
    const caret = (start, end = start) => input().props.onSelectionChange({ nativeEvent: { selection: { start, end } } })
    const message = '把 mobile 的推送测试跑一遍，然后告诉我哪些用例失败了'

    // 1. The last key lands while the finger is on the button: its change is reported,
    //    but the tap is handled by the render before it. The send waits for that render
    //    and takes the whole text.
    native(message.slice(0, -1))
    const fieldBefore = input()
    const tap = sendButton().props.onPress
    fieldBefore.props.onChangeText(message)
    tap()
    assert.deepEqual(sent, [], 'a send from a render without the last key waits')
    render()
    assert.deepEqual(sent, [message], 'the rendered send takes the last key too')
    assert.equal(props.draft, '')
    caret(0)

    //    The render of an earlier key ("…失") can still have its effects pending when the
    //    last keys and the tap are handled. Those effects must not send without them.
    native(message.slice(0, -3))
    input().props.onChangeText(message.slice(0, -2))
    hold = true
    const fieldOlder = input()
    const tapOlder = sendButton().props.onPress
    fieldOlder.props.onChangeText(message.slice(0, -1))
    fieldOlder.props.onChangeText(message)
    tapOlder()
    runHeld()
    assert.deepEqual(sent, [message], 'nothing is sent from the older render')
    render()
    assert.deepEqual(sent, [message, message], 'the send waits for the render with every key')
    assert.equal(props.draft, '')
    caret(0)
    sent.length = 0

    // 2. The last keys ("好的") arrive after the send cleared the box: Android kept the
    //    old text, appended them and reported both.
    native(message)
    sendButton().props.onPress()
    assert.deepEqual(sent, [message])
    assert.equal(props.draft, '')
    input().props.onChangeText(message + '好')
    assert.equal(props.draft, '好', 'the sent text must not come back; the late key stays')
    input().props.onChangeText(message + '好的')
    assert.equal(props.draft, '好的', 'every key typed on top of the sent text is kept, the sent text never returns')
    assert.deepEqual(input().props.selection, { start: 2, end: 2 })
    // Once the field shows the kept keys, typing is ordinary again.
    native('好的，')
    assert.equal(props.draft, '好的，')

    //    Handled in the same batch as the tap, the key's handler still sees the render
    //    from before the send.
    native(message)
    const fieldAtTap = input()
    sendButton().props.onPress()
    fieldAtTap.props.onChangeText(message + '好')
    assert.equal(props.draft, '好')
    assert.deepEqual(sent, [message, message])
    native('好')

    // 3. The clear landed: the field moves its caret to the start. A new message that
    //    happens to begin with the sent one is the user's, untouched.
    native('')
    native(message)
    sendButton().props.onPress()
    caret(0)
    native(message + '，再跑一次')
    assert.equal(props.draft, message + '，再跑一次')

    // 4. A send that could not go out keeps the draft; typing on it is ordinary.
    native('')
    native(message)
    delivers = false
    sendButton().props.onPress()
    assert.equal(props.draft, message)
    native(message + '！')
    assert.equal(props.draft, message + '！')
    delivers = true

    // 5. Sent with the keyboard down: no key can race the clear, nothing to undo later.
    native('')
    native(message)
    focused = false
    sendButton().props.onPress()
    focused = true
    native(message + '，再跑一次')
    assert.equal(props.draft, message + '，再跑一次')
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
