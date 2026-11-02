import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

// A browser drops an input method's composition (pinyin, kana…) when the page
// moves the caret mid-composition, and react-native-web moves it whenever the
// `selection` prop changes. iOS Safari turned "nihao" into "nnini hni hani hao".
test('on the web the composer leaves the caret to the browser while typing and moves it only on purpose', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    // Hooks of the composer itself keep their state between renders; nested
    // components rendered by flatten() get throwaway state.
    let slots = [], slot = 0, inComposer = false
    const useState = initial => {
      const value = typeof initial === 'function' ? initial() : initial
      if (!inComposer) return [value, () => {}]
      const index = slot++
      if (!(index in slots)) slots[index] = value
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    }
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React, useState, useEffect: () => {}, useRef: current => ({ current: current ?? { blur() {}, focus() {} } }),
    }))
    const Platform = { OS: 'web' }
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Keyboard: { dismiss() {} }, Linking: { openSettings: async () => {} },
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
    let voice
    mock.module(${JSON.stringify(import.meta.resolve('../core/useVoiceDictation'))}, () => ({
      useVoiceDictation: input => {
        voice = input
        return {
          phase: 'idle', live: false, startedAt: 0, limitSeconds: 120, sendRequested: false, issue: null, pendingText: null,
          getLevel: () => 0, start() {}, stop() {}, stopAndSend() {}, cancel() {}, edited() {}, insertPending() {}, dismissPending() {}, dismissIssue() {},
        }
      },
    }))
    const { ChatComposer } = require(${JSON.stringify(import.meta.resolve('./ChatComposer'))})
    const props = {
      client: { host: { id: 'phone-fixture' } }, sessionId: 'fixture-chat',
      draft: '', onDraft: value => { props.draft = value }, references: [], onReferences: () => {}, attachments: [], onAttachments: () => {},
      team: false, onTeam: () => {}, computer: { enabled: false }, lean: false, empty: false, busy: false, disabled: false,
      run: { label: '测试模型', risk: 'normal' }, onOpenRun: () => {}, onSend: () => {}, onError: () => {},
    }
    globalThis.requestAnimationFrame = () => 0
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return [node, ...flatten(node.type(node.props))]
      return [node, ...flatten(node.props?.children)]
    }
    const render = () => {
      slot = 0
      inComposer = true
      let tree
      try { tree = ChatComposer(props) } finally { inComposer = false }
      return flatten(tree)
    }
    const input = () => render().find(node => node.type === 'TextInput')
    const type = value => input().props.onChangeText(value)

    // Typing, including every composition update of an input method, never
    // hands the caret to the input.
    assert.equal(input().props.selection, undefined)
    for (const value of ['n', 'ni', 'ni h', 'ni ha', 'ni hao', '你好']) {
      type(value)
      assert.equal(input().props.selection, undefined, 'typing "' + value + '" must not move the caret')
    }

    // The composer moving the caret itself (dictated text) does hand it over,
    // as the same object across renders so the input applies it once.
    voice.onDraft('你好，世界', 3)
    const moved = input().props.selection
    assert.deepEqual(moved, { start: 3, end: 3 })
    assert.equal(input().props.selection, moved)
    assert.equal(props.draft, '你好，世界')

    // The browser reporting the caret, or the next keystroke, takes it back.
    input().props.onSelectionChange({ nativeEvent: { selection: { start: 3, end: 3 } } })
    assert.equal(input().props.selection, undefined)
    voice.onDraft('你好，世界！', 6)
    assert.deepEqual(input().props.selection, { start: 6, end: 6 })
    type('你好，世界！h')
    assert.equal(input().props.selection, undefined)

    // Picking a / candidate moves the caret behind the inserted command.
    type('请执行 /')
    const card = render().find(node => node.type?.name === 'CandidateCard')
    assert.ok(card, 'typing / opens the candidate card')
    card.props.onChoose({ name: 'review', description: '审查改动' })
    assert.equal(props.draft, '请执行 /review ')
    const picked = input().props.selection
    assert.deepEqual(picked, { start: 12, end: 12 })
    assert.equal(input().props.selection, picked)
    type('请执行 /review n')
    assert.equal(input().props.selection, undefined)

    // Applying the + sheet puts the caret at the end of its draft.
    render().find(node => node.type === 'BringSheet').props.onApply({ draft: '整理一下', references: [] })
    assert.equal(props.draft, '整理一下')
    assert.deepEqual(input().props.selection, { start: 4, end: 4 })

    // The native app keeps its controlled caret, tracked through typing.
    Platform.OS = 'ios'
    type('你好，世界！ha')
    assert.deepEqual(input().props.selection, { start: 8, end: 8 })
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
