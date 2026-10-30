import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('a running composer keeps the model disabled and muted without a separate lock hint', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {}, useRef: current => ({ current }),
    }))
    const platform = { OS: 'ios' }
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Keyboard: {}, Linking: {}, Platform: platform, Pressable: 'Pressable',
      ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-linear-gradient'))}, () => ({ LinearGradient: 'LinearGradient' }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    const colors = { ink: 'ink', ink2: 'ink2', ink3: 'muted' }
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({ Icon: 'Icon', Mono: 'Mono', Spinner: 'Spinner', useColors: () => colors }))
    mock.module(${JSON.stringify(import.meta.resolve('./theme'))}, () => ({ errorText: String }))
    mock.module(${JSON.stringify(import.meta.resolve('./chatMaterials'))}, () => ({ pickChatMaterial: async () => [] }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/BringSheet'))}, () => ({ BringSheet: 'BringSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/glyphs'))}, () => ({ Glyph: 'Glyph' }))
    mock.module(${JSON.stringify(import.meta.resolve('./chat/ImagePreview'))}, () => ({ ImagePreview: 'ImagePreview' }))
    mock.module(${JSON.stringify(import.meta.resolve('../core/useVoiceDictation'))}, () => ({ useVoiceDictation: () => ({ phase: 'idle', live: false, issue: null, pendingText: null }) }))
    const { ChatComposer } = require(${JSON.stringify(import.meta.resolve('./ChatComposer'))})
    const props = {
      draft: '', onDraft: () => {}, references: [], onReferences: () => {},
      attachments: [], onAttachments: () => {}, team: false, onTeam: () => {},
      computer: { enabled: false }, lean: false, empty: false, busy: true, disabled: false,
      run: { label: '测试模型 · 高', risk: 'normal', locked: true },
      onOpenRun: () => {}, onSend: () => {}, onStop: () => {}, onError: () => {},
    }
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }
    for (const os of ['ios', 'android', 'web']) {
      platform.OS = os
      props.run.locked = true
      props.busy = true
      let nodes = flatten(ChatComposer(props))
      assert.equal(nodes.some(node => node.type === 'Text' && node.props.children === '运行中不能换模型'), false, os + ': no separate hint should occupy toolbar space')
      const model = nodes.find(node => node.type === 'Pressable' && node.props.accessibilityLabel.startsWith('运行方式：'))
      assert.ok(model)
      assert.equal(model.props.disabled, true)
      assert.equal(model.props.accessibilityState.disabled, true)
      assert.equal(model.props['aria-disabled'], true)
      assert.ok(model.props.accessibilityLabel.includes('运行中不可改'))
      assert.equal(nodes.find(node => node.type === 'Text' && node.props.children === props.run.label).props.style.color, colors.ink3)
      assert.ok(nodes.some(node => node.type === 'Glyph' && node.props.name === 'lock'))
      assert.equal(nodes.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === '停止').props.disabled, false)
      props.run.locked = false
      props.busy = false
      nodes = flatten(ChatComposer(props))
      const unlocked = nodes.find(node => node.type === 'Pressable' && node.props.accessibilityLabel.startsWith('运行方式：'))
      assert.equal(unlocked.props.disabled, false)
      assert.equal(unlocked.props.accessibilityState.disabled, false)
      assert.equal(nodes.find(node => node.type === 'Text' && node.props.children === props.run.label).props.style.color, colors.ink)
      assert.ok(nodes.some(node => node.type === 'Icon' && node.props.name === 'chevron-down'))
    }
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
