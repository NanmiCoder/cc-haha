import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

// On iOS Fabric, BaseTextInputShadowNode::layout updates state after Yoga's
// measureContent pass, leaving multiline TextInput stuck at its old height when
// JS clears or shortens the draft (send, prompt optimize, restore).
test('on iOS the composer triggers a Yoga re-measure when draft shrinks programmatically and tracks keyboardDidHide', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let slots = [], slot = 0, refs = [], refSlot = 0, effects = [], inComposer = false
    const useState = initial => {
      const value = typeof initial === 'function' ? initial() : initial
      if (!inComposer) return [value, () => {}]
      const index = slot++
      if (!(index in slots)) slots[index] = value
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    }
    const useRef = initial => {
      if (!inComposer) return { current: initial }
      const index = refSlot++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    }
    const useEffect = (fn, deps) => {
      if (!inComposer) return
      effects.push({ fn, deps })
    }
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React, useState, useEffect, useRef,
    }))
    const listeners = new Map()
    const Platform = { OS: 'ios' }
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image',
      Keyboard: {
        dismiss() {},
        isVisible: () => false,
        addListener(name, cb) {
          if (!listeners.has(name)) listeners.set(name, new Set())
          listeners.get(name).add(cb)
          return { remove: () => listeners.get(name)?.delete(cb) }
        },
      },
      Linking: { openSettings: async () => {} },
      Platform, Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-linear-gradient'))}, () => ({ LinearGradient: 'LinearGradient' }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({ Icon: 'Icon', Mono: 'Mono', Spinner: 'Spinner', useColors: () => ({}) }))
    mock.module(${JSON.stringify(import.meta.resolve('./theme'))}, () => ({ errorText: String, useTheme: () => ({ colors: {}, shadows: {}, dark: false, scheme: 'light' }) }))
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
    mock.module(${JSON.stringify(import.meta.resolve('../core/usePromptOptimize'))}, () => ({
      usePromptOptimize: () => ({
        phase: 'idle', optimizing: false, restoreSnapshot: null, notice: null, issue: null,
        optimize() {}, cancel() {}, restore() {}, edited() {}, dismissRestore() {}, dismissNotice() {}, dismissIssue() {},
      }),
    }))
    const { ChatComposer } = require(${JSON.stringify(import.meta.resolve('./ChatComposer'))})
    const props = {
      client: { host: { id: 'phone-fixture' } }, sessionId: 'fixture-chat',
      draft: '', onDraft: value => { props.draft = value }, references: [], onReferences: () => {}, attachments: [], onAttachments: () => {},
      team: false, onTeam: () => {}, computer: { enabled: false }, lean: false, empty: false, busy: false, disabled: false,
      run: { label: '测试模型', risk: 'normal' }, onOpenRun: () => {}, onSend: () => { props.draft = ''; return true }, onError: () => {},
    }
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return [node, ...flatten(node.type(node.props))]
      return [node, ...flatten(node.props?.children)]
    }
    let prevDeps = []
    const render = () => {
      slot = 0
      refSlot = 0
      effects = []
      inComposer = true
      let tree
      try { tree = ChatComposer(props) } finally { inComposer = false }
      effects.forEach((effect, i) => {
        const last = prevDeps[i]
        const changed = !last || !effect.deps || effect.deps.length !== last.length || effect.deps.some((d, j) => !Object.is(d, last[j]))
        if (changed) {
          prevDeps[i] = effect.deps
          effect.fn()
        }
      })
      return flatten(tree)
    }
    const input = () => render().find(node => node.type === 'TextInput')

    // Initial render starts at maxHeight 136 and registers keyboardDidHide on iOS.
    assert.equal(input().props.style.maxHeight, 136)
    assert.equal(listeners.get('keyboardDidHide')?.size, 1)
    assert.equal(listeners.get('keyboardWillHide')?.size, 1)

    // Typing and backspacing via onChangeText does not nudge maxHeight.
    const longText = 'line1\\nline2\\nline3\\nline4\\nline5\\nline6'
    input().props.onChangeText(longText)
    assert.equal(input().props.style.maxHeight, 136)
    input().props.onChangeText('line1\\nline2')
    assert.equal(input().props.style.maxHeight, 136)

    // Clearing the draft programmatically (e.g. tapping Send) nudges maxHeight on the next commit.
    input().props.onChangeText(longText)
    assert.equal(input().props.style.maxHeight, 136)
    props.draft = ''
    render() // commit N updates shadow node state and triggers effect
    assert.equal(input().props.style.maxHeight, 136.5)

    // A second programmatic shrink (e.g. Prompt Optimize shortening a long draft) nudges back to 136.
    input().props.onChangeText(longText)
    render()
    props.draft = 'short'
    render()
    assert.equal(input().props.style.maxHeight, 136)
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
