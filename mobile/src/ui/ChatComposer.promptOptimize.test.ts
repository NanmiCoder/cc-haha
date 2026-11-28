import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('ChatComposer wires prompt optimization button, mid-turn support, cancel, restore, and error states', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let optimized = 0, cancelled = 0, restored = 0, edited = 0, dismissedRestore = 0, dismissedNotice = 0, dismissedIssue = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {}, useRef: current => ({ current }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Keyboard: { dismiss: () => {} }, Linking: { openSettings: async () => {} },
      Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
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
    let voice = {
      phase: 'idle', live: false, startedAt: Date.now(), limitSeconds: 120, sendRequested: false, issue: null, pendingText: null,
      getLevel: () => 0, start: () => {}, stop: () => {}, stopAndSend: () => {}, cancel: () => {},
      edited: () => {}, insertPending: () => {}, dismissPending: () => {}, dismissIssue: () => {},
    }
    mock.module(${JSON.stringify(import.meta.resolve('../core/useVoiceDictation'))}, () => ({ useVoiceDictation: () => voice }))
    let promptOptimize = {
      phase: 'idle', optimizing: false, restoreSnapshot: null, notice: null, issue: null,
      optimize: () => optimized++, cancel: () => cancelled++, restore: () => restored++,
      edited: () => edited++, dismissRestore: () => dismissedRestore++,
      dismissNotice: () => dismissedNotice++, dismissIssue: () => dismissedIssue++,
    }
    let optimizeOptions
    mock.module(${JSON.stringify(import.meta.resolve('../core/usePromptOptimize'))}, () => ({
      usePromptOptimize: input => { optimizeOptions = input; return promptOptimize },
    }))
    const { ChatComposer } = require(${JSON.stringify(import.meta.resolve('./ChatComposer'))})
    const props = {
      client: { host: { id: 'phone-fixture' } }, sessionId: 'fixture-chat',
      draft: '', onDraft: value => { props.draft = value }, references: [], onReferences: () => {}, attachments: [], onAttachments: () => {},
      team: false, onTeam: () => {}, computer: { enabled: false }, lean: false, empty: false, busy: false, disabled: false,
      run: { label: '测试模型', risk: 'normal' }, onOpenRun: () => {}, onSend: () => {}, onError: () => {},
    }
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }
    const render = () => flatten(ChatComposer(props))
    const button = (nodes, label) => nodes.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label)

    // Hidden when empty or slash command.
    assert.equal(button(render(), '优化提示词'), undefined)
    props.draft = '/review'
    assert.equal(button(render(), '优化提示词'), undefined)

    // Hidden on new-task screen without a sessionId.
    props.draft = '帮我重构登录流程'
    props.sessionId = undefined
    assert.equal(button(render(), '优化提示词'), undefined)

    // Visible on a session with optimizable text, including mid-turn (busy).
    props.sessionId = 'fixture-chat'
    props.busy = true
    props.queueing = true
    let nodes = render()
    assert.ok(optimizeOptions.contextKey.includes('phone-fixture:fixture-chat'))
    const optBtn = button(nodes, '优化提示词')
    assert.ok(optBtn)
    assert.equal(optBtn.props.disabled, false)
    optBtn.props.onPress()
    assert.equal(optimized, 1)

    // Typing and starting voice both notify promptOptimize.edited().
    nodes.find(node => node.type === 'TextInput').props.onChangeText('帮我重构登录流程并加测试')
    assert.equal(edited, 1)
    button(nodes, '语音输入').props.onPress()
    assert.equal(edited, 2)

    // Optimizing state shows busy cancel button and inline status strip.
    promptOptimize = { ...promptOptimize, phase: 'optimizing', optimizing: true }
    nodes = render()
    const cancelBtn = button(nodes, '取消优化提示词')
    assert.ok(cancelBtn)
    assert.equal(cancelBtn.props.accessibilityState.busy, true)
    assert.ok(nodes.some(node => node.type === 'Text' && node.props.children === '正在结合上下文优化提示词…'))
    cancelBtn.props.onPress()
    button(nodes, '取消优化').props.onPress()
    assert.equal(cancelled, 2)

    // Tapping Send cancels in-flight optimization cleanly.
    button(nodes, '排队发送').props.onPress()
    assert.equal(cancelled, 3)

    // Restorable state shows inline confirmation + one-click Restore + dismiss.
    promptOptimize = { ...promptOptimize, phase: 'idle', optimizing: false, restoreSnapshot: { id: 1, text: '原文' } }
    nodes = render()
    assert.ok(nodes.some(node => node.type === 'Text' && node.props.children === '提示词已优化'))
    button(nodes, '还原优化前的提示词').props.onPress()
    button(nodes, '关闭优化提示').props.onPress()
    assert.equal(restored, 1)
    assert.equal(dismissedRestore, 1)

    // Disabled composer disables restore action.
    props.disabled = true
    assert.equal(button(render(), '还原优化前的提示词').props.disabled, true)
    props.disabled = false

    // Unchanged notice and inline error alert render and dismiss.
    promptOptimize = { ...promptOptimize, restoreSnapshot: null, notice: '当前提示词已足够清晰' }
    nodes = render()
    assert.ok(nodes.some(node => node.type === 'Text' && node.props.children === '当前提示词已足够清晰'))
    button(nodes, '关闭提示词优化状态').props.onPress()
    assert.equal(dismissedNotice, 1)

    promptOptimize = { ...promptOptimize, notice: null, issue: { code: 'TIMEOUT', message: '优化提示词超时，请重试。' } }
    nodes = render()
    assert.ok(nodes.some(node => node.type === 'Text' && node.props.children === '优化提示词超时，请重试。'))
    button(nodes, '关闭提示词优化错误').props.onPress()
    assert.equal(dismissedIssue, 1)

    // Voice recording hides optimize feedback and button cleanly.
    voice = { ...voice, phase: 'recording', live: true }
    nodes = render()
    assert.equal(button(nodes, '优化提示词'), undefined)
    assert.equal(nodes.some(node => node.props?.testID === 'prompt-optimize-feedback'), false)
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
