import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('sent capabilities precede the user text with the same colored badges after replay and reopening history', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = await import(${JSON.stringify(import.meta.resolve('react'))})
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, memo: fn => fn, useMemo: fn => fn(), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useRef: current => ({ current }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ View: 'View', Text: 'Text', Image: 'Image', ScrollView: 'ScrollView', Pressable: 'Pressable', Keyboard: {}, Platform: { OS: 'ios' } }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      Callout: 'Callout', CodeBlock: 'CodeBlock', InlineCode: 'InlineCode', Icon: 'Icon',
      useColors: () => ({ bubble: 'bubble', ink: 'ink', fill: 'neutral-fill', ink2: 'secondary-ink', run: 'capability-ink', runTint: 'capability-fill' }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../compose/glyphs'))}, () => ({ Glyph: 'Glyph' }))
    mock.module(${JSON.stringify(import.meta.resolve('./ImagePreview'))}, () => ({ ImagePreview: 'ImagePreview' }))
    const { Message, UserBubble } = await import(${JSON.stringify(import.meta.resolve('../Message'))})
    const { serializeComposer } = await import(${JSON.stringify(import.meta.resolve('../../core/composerReferences'))})
    const { buildComposerMessage } = await import(${JSON.stringify(import.meta.resolve('../../core/chatComposer'))})
    const { appendPendingUserMessage, chatReducer, createChatState, normalizeHistory } = await import(${JSON.stringify(import.meta.resolve('../../core/chat'))})
    const references = ['computer-use', 'owner:review'].map(id => ({ kind: 'skill', id, name: id, displayName: id, description: '', modelText: 'Use the Skill tool with skill: ' + JSON.stringify(id) + ' for this request.' }))
    const content = buildComposerMessage(serializeComposer('/check 核对这些改动', references), [], true).content
    const pending = appendPendingUserMessage(createChatState('fixture'), content)
    const replayed = chatReducer(pending, { type: 'user_message_replay', content })
    const history = normalizeHistory([{ id: 'saved', type: 'user', content: [{ type: 'text', text: content }], timestamp: '2026-10-29T00:00:00Z' }])
    const withImage = normalizeHistory([{ id: 'saved-photo', type: 'user', content: [{ type: 'text', text: content }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }], timestamp: '2026-10-29T00:00:00Z' }])
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }
    const inspect = node => {
      const nodes = flatten(node)
      const row = nodes.find(node => node.props.testID === 'user-message-capabilities')
      assert.ok(row, 'selected capabilities must move into a leading row on the sent bubble')
      assert.equal(row.props.style.alignSelf, 'flex-start')
      assert.equal(row.props.style.flexWrap, 'wrap')
      const badges = nodes.filter(node => node.props.testID === 'user-message-capability')
      assert.deepEqual(badges.map(node => node.props.accessibilityLabel), ['Agent 团队', '操作电脑', '@review', '/check'])
      assert.ok(badges.every(node => node.props.style.backgroundColor === 'capability-fill'), 'message badges must retain the selected capability color')
      assert.ok(nodes.indexOf(row) < nodes.findIndex(node => node.type === 'Text' && node.props.children === '核对这些改动'))
      const text = nodes.filter(node => node.type === 'Text').flatMap(node => [node.props.children].flat(Infinity)).filter(value => typeof value === 'string').join(' ')
      assert.ok(!text.includes('Use the Skill tool') && !text.includes('agent-team-request'))
      return badges.map(node => node.props.accessibilityLabel)
    }
    for (const item of [pending.items[0], replayed.items[0], history[0], withImage[0]]) inspect(Message({ item }))
    // The long-press copy uses UserBubble too, so it cannot regress to raw instructions.
    inspect(UserBubble({ item: history[0], text: content, team: true }))
    const plain = flatten(Message({ item: { id: 'literal', type: 'user', text: '手写 @review 和 /folder/file 都是原文' } }))
    assert.equal(plain.some(node => node.props.testID === 'user-message-capabilities'), false)
    assert.ok(plain.some(node => node.type === 'Text' && node.props.children === '手写 @review 和 /folder/file 都是原文'))
    const assistant = flatten(Message({ item: { id: 'answer', type: 'assistant', text: references[0].modelText } }))
    assert.equal(assistant.some(node => node.props.testID === 'user-message-capabilities'), false, 'quoted instructions in an assistant response must stay response text')
    const unclosed = flatten(Message({ item: { id: 'literal-tag', type: 'user', text: '没有闭合的 <agent-team-request> 原文' } }))
    assert.equal(unclosed.some(node => node.props.testID === 'user-message-capabilities'), false)
  `
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
