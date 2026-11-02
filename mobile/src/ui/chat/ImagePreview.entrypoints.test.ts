import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

// Render the actual entry points in an isolated process: Bun's native module
// mocks must not affect other mobile suites, and no real picker/provider runs.
function checkEntryPoint(entry: 'composer' | 'message') {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let state = [], cursor = 0, dismissed = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React, memo: component => component,
      useState: initial => {
        const slot = cursor++
        if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
        return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
      },
      useEffect: () => {}, useMemo: fn => fn(), useRef: value => ({ current: value }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Keyboard: { dismiss: () => dismissed++ }, Linking: {}, Platform: { OS: 'ios' },
      Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 12 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-linear-gradient'))}, () => ({ LinearGradient: 'LinearGradient' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      Callout: 'Callout', CodeBlock: 'CodeBlock', Icon: 'Icon', InlineCode: 'InlineCode', Mono: 'Mono', Spinner: 'Spinner', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../theme'))}, () => ({ errorText: String }))
    mock.module(${JSON.stringify(import.meta.resolve('../chatMaterials'))}, () => ({ pickChatMaterial: async () => [] }))
    mock.module(${JSON.stringify(import.meta.resolve('../compose/BringSheet'))}, () => ({ BringSheet: 'BringSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('../compose/glyphs'))}, () => ({ Glyph: 'Glyph' }))
    mock.module(${JSON.stringify(new URL('./ImagePreview.tsx', import.meta.url).pathname)}, () => ({ ImagePreview: 'ImagePreview' }))
    mock.module(${JSON.stringify(import.meta.resolve('../../core/useVoiceDictation'))}, () => ({ useVoiceDictation: () => ({ phase: 'idle', live: false, issue: null, pendingText: null }) }))
    const { ChatComposer } = require(${JSON.stringify(import.meta.resolve('../ChatComposer'))})
    const { Message } = require(${JSON.stringify(import.meta.resolve('../Message'))})
    const attachments = [
      { id: 'a', type: 'image', name: '照片一.jpg', uri: 'file:///first.jpg', data: 'Zmlyc3Q=', mimeType: 'image/jpeg', bytes: 5 },
      { id: 'f', type: 'file', name: '材料.pdf', data: 'cGRm', mimeType: 'application/pdf', bytes: 3 },
      { id: 'b', type: 'image', name: '照片二.jpg', uri: 'file:///second.jpg', data: 'c2Vjb25k', mimeType: 'image/jpeg', bytes: 6 },
    ]
    let removed
    const props = {
      draft: '保留这段草稿', onDraft: () => assert.fail('preview must not edit draft'),
      attachments, onAttachments: value => { removed = value },
      references: [], onReferences: () => {}, team: false, onTeam: () => {}, computer: { enabled: false },
      lean: false, empty: false, busy: false, disabled: false,
      run: { label: '测试模型', risk: 'normal' }, onOpenRun: () => {}, onSend: () => {}, onError: () => {},
    }
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }
    const render = () => {
      cursor = 0
      return flatten(${JSON.stringify(entry)} === 'composer'
        ? ChatComposer(props)
        : Message({ item: { id: 'sent', type: 'user', text: '解释这些图片', attachments } }))
    }
    let nodes = render()
    const second = nodes.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === '预览 照片二.jpg')
    assert.ok(second, 'every image needs a reachable preview action')
    second.props.onPress()
    nodes = render()
    const preview = nodes.find(node => node.type === 'ImagePreview')
    assert.ok(preview, 'tapping a thumbnail must open the gallery')
    assert.equal(preview.props.initialIndex, 1, 'mixed files must not shift the selected image')
    assert.deepEqual(preview.props.images.map(image => image.name), ['照片一.jpg', '照片二.jpg'])
    assert.equal(dismissed, 1, 'preview should dismiss the keyboard')
    preview.props.onClose()
    nodes = render()
    assert.equal(nodes.some(node => node.type === 'ImagePreview'), false)
    if (${JSON.stringify(entry)} === 'composer') {
      assert.equal(nodes.find(node => node.type === 'TextInput').props.value, '保留这段草稿')
      nodes.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === '移除 照片二.jpg').props.onPress()
      assert.deepEqual(removed.map(item => item.id), ['a', 'f'])
      assert.equal(render().some(node => node.type === 'ImagePreview'), false, 'remove must not open a preview')
    }
  `
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
}

for (const entry of ['composer', 'message'] as const) {
  test(`${entry} opens the selected attachment, navigates images only and preserves its content on close`, () => {
    checkEntryPoint(entry)
  })
}
