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
      draft: '原来的草稿', onDraft: () => {}, references: [], onReferences: () => {}, attachments: [], onAttachments: () => {},
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
    let nodes = render()
    assert.equal(button(nodes, '语音输入').props.disabled, false)
    button(nodes, '语音输入').props.onPress()
    assert.deepEqual([blurred, dismissed, started], [1, 1, 1])
    assert.ok(options.contextKey.includes('phone-fixture:fixture-chat'))
    voice = { ...voice, phase: 'recording', live: true }
    nodes = render()
    assert.equal(button(nodes, '语音输入'), undefined)
    assert.equal(nodes.some(node => node.props?.accessibilityLabel?.startsWith('运行方式：')), false)
    assert.equal(nodes.find(node => node.type === 'TextInput').props.editable, false)
    assert.equal(nodes.find(node => node.type === 'TextInput').props.value, '原来的草稿')
    button(nodes, '停止录音并转成文字').props.onPress()
    button(nodes, '转写后发送').props.onPress()
    button(nodes, '取消语音输入').props.onPress()
    assert.deepEqual([stopped, sent, cancelled], [1, 1, 1])
    props.busy = true
    props.queueing = true
    nodes = render()
    assert.equal(button(nodes, '转写后发送').props.disabled, false, 'a running model permits a dictated queued message')
    voice = { ...voice, phase: 'transcribing' }
    nodes = render()
    assert.equal(button(nodes, '停止录音并转成文字').props.disabled, true)
    assert.equal(button(nodes, '取消语音输入').props.disabled, undefined)
    voice = { ...voice, sendRequested: true }
    assert.equal(button(render(), '转写后发送').props.disabled, true)
    voice = { ...voice, phase: 'idle', live: false, pendingText: '待插入的识别文字', issue: { code: 'permission', message: '请允许麦克风' } }
    nodes = render()
    assert.ok(nodes.some(node => node.type === 'Text' && node.props.children === '待插入的识别文字'))
    button(nodes, '插入转写文字').props.onPress()
    assert.equal(inserted, 1)
    await button(nodes, '打开麦克风权限设置').props.onPress()
    assert.equal(settings, 1)
    props.disabled = true
    nodes = render()
    assert.equal(button(nodes, '插入转写文字').props.disabled, true)
    assert.equal(button(nodes, '语音输入').props.disabled, true)
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
