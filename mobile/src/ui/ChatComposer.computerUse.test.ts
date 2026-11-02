import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('computer-use chips belong to the current message, clear with references and never disable global authorization', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let state = [], cursor = 0, mutations = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState: initial => {
        const slot = cursor++
        if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
        return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
      },
      useEffect: () => {}, useMemo: fn => fn(), useRef: current => ({ current }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Keyboard: {}, Linking: {}, Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
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
    mock.module(${JSON.stringify(import.meta.resolve('../core/useVoiceDictation'))}, () => ({ useVoiceDictation: () => ({ phase: 'idle', live: false, issue: null, pendingText: null }) }))
    const { ChatComposer } = require(${JSON.stringify(import.meta.resolve('./ChatComposer'))})
    const props = {
      draft: '检查这个页面', onDraft: () => {}, references: [], onReferences: value => { props.references = value },
      attachments: [], onAttachments: () => {}, team: false, onTeam: () => {},
      computer: { enabled: true, toggle: () => mutations++ },
      lean: false, empty: false, busy: false, disabled: false,
      run: { label: '测试模型', risk: 'normal' }, onOpenRun: () => {}, onSend: () => {}, onError: () => {},
    }
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }
    const render = () => { cursor = 0; return flatten(ChatComposer(props)) }
    let nodes = render()
    assert.equal(nodes.some(node => node.props?.children === '操作电脑'), false, 'global consent alone must not leave a permanent chip in an empty selection')
    nodes.find(node => node.type === 'BringSheet').props.onComputerSelected(true)
    nodes = render()
    assert.equal(props.references.length, 1)
    assert.equal(props.references[0].id, 'computer-use')
    assert.equal(props.references[0].modelText, 'Use the Skill tool with skill: "computer-use" for this request.')
    const remove = nodes.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === '移除 操作电脑')
    assert.ok(remove)
    remove.props.onPress()
    assert.equal(props.references.length, 0)
    assert.equal(mutations, 0, 'removing a per-message chip must not revoke global consent')
    nodes = render()
    nodes.find(node => node.type === 'BringSheet').props.onComputerSelected(true)
    assert.equal(props.references.length, 1, 'an already authorized computer can be chosen for the next message')
    // The chat page clears references after either sending or queueing, and
    // preserves them after a failed send. The composer must follow that state.
    assert.ok(render().some(node => node.props?.children === '操作电脑'))
    props.references = []
    assert.equal(render().some(node => node.props?.children === '操作电脑'), false)
    assert.equal(props.computer.enabled, true)
    assert.equal(mutations, 0)
  `
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
