import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('the actual composer wires microphone, recording controls, transcript feedback and queued sending', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let blurred = 0, dismissed = 0, started = 0, stopped = 0, sent = 0, cancelled = 0, inserted = 0, settings = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {}, useRef: current => ({ current: current ?? { blur: () => blurred++, focus: () => {} } }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Keyboard: { dismiss: () => dismissed++ }, Linking: { openSettings: async () => settings++ },
      Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
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
    let voice = {
      phase: 'idle', live: false, startedAt: Date.now(), limitSeconds: 120, sendRequested: false, issue: null, pendingText: null,
      getLevel: () => 0.4, start: () => started++, stop: () => stopped++, stopAndSend: () => sent++, cancel: () => cancelled++,
      edited: () => {}, insertPending: () => inserted++, dismissPending: () => {}, dismissIssue: () => {},
    }
    let options
    mock.module(${JSON.stringify(import.meta.resolve('../core/useVoiceDictation'))}, () => ({ useVoiceDictation: input => { options = input; return voice } }))
    const { ChatComposer } = require(${JSON.stringify(import.meta.resolve('./ChatComposer'))})
    const props = {
      client: { host: { id: 'phone-fixture' } }, sessionId: 'fixture-chat',
      draft: 'Original draft', onDraft: () => {}, references: [], onReferences: () => {}, attachments: [], onAttachments: () => {},
      team: false, onTeam: () => {}, computer: { enabled: false }, lean: false, empty: false, busy: false, disabled: false,
      run: { label: 'Test model', risk: 'normal' }, onOpenRun: () => {}, onSend: () => {}, onError: () => {},
    }
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }
    const render = () => flatten(ChatComposer(props))
    const button = (nodes, label) => nodes.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label)
    let nodes = render()
    assert.equal(button(nodes, 'Voice input').props.disabled, false)
    button(nodes, 'Voice input').props.onPress()
    assert.deepEqual([blurred, dismissed, started], [1, 1, 1])
    assert.ok(options.contextKey.includes('phone-fixture:fixture-chat'))
    voice = { ...voice, phase: 'recording', live: true }
    nodes = render()
    assert.equal(button(nodes, 'Voice input'), undefined)
    assert.equal(nodes.some(node => node.props?.accessibilityLabel?.startsWith('Run mode: ')), false)
    assert.equal(nodes.find(node => node.type === 'TextInput').props.editable, false)
    assert.equal(nodes.find(node => node.type === 'TextInput').props.value, 'Original draft')
    // Recording owns the composer: an empty, disabled editor used to take up
    // space while the waveform was squeezed between three toolbar buttons.
    assert.equal(nodes.find(node => node.type === 'TextInput').props.style.display, 'none')
    const panel = nodes.find(node => node.props?.testID === 'voice-recording-panel')
    assert.ok(panel, 'recording has its own full-width surface')
    assert.notEqual(panel.props.style.flexDirection, 'row', 'the trace and actions must not share one narrow row')
    assert.ok(nodes.some(node => node.type === 'Text' && node.props.children === 'Listening'))
    button(nodes, 'Stop recording and transcribe').props.onPress()
    button(nodes, 'Send after transcribing').props.onPress()
    button(nodes, 'Cancel voice input').props.onPress()
    assert.deepEqual([stopped, sent, cancelled], [1, 1, 1])
    props.busy = true
    props.queueing = true
    nodes = render()
    assert.equal(button(nodes, 'Send after transcribing').props.disabled, false, 'a running model permits a dictated queued message')
    voice = { ...voice, phase: 'transcribing' }
    nodes = render()
    assert.equal(button(nodes, 'Stop recording and transcribe').props.disabled, true)
    assert.equal(button(nodes, 'Cancel voice input').props.disabled, undefined)
    voice = { ...voice, sendRequested: true }
    assert.equal(button(render(), 'Send after transcribing').props.disabled, true)
    voice = { ...voice, phase: 'idle', live: false, pendingText: 'Recognized text to insert', issue: { code: 'permission', message: 'Please allow the microphone' } }
    nodes = render()
    assert.notEqual(nodes.find(node => node.type === 'TextInput').props.style.display, 'none')
    assert.equal(nodes.find(node => node.type === 'TextInput').props.value, 'Original draft')
    assert.ok(nodes.some(node => node.type === 'Text' && node.props.children === 'Recognized text to insert'))
    button(nodes, 'Insert transcribed text').props.onPress()
    assert.equal(inserted, 1)
    await button(nodes, 'Open microphone permission settings').props.onPress()
    assert.equal(settings, 1)
    props.disabled = true
    nodes = render()
    assert.equal(button(nodes, 'Insert transcribed text').props.disabled, true)
    assert.equal(button(nodes, 'Voice input').props.disabled, true)
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
