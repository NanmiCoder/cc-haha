import { expect, test } from 'bun:test'
import { buildComposerMessage } from './chatComposer'
import { userMessageDisplay } from './userMessageDisplay'

const skill = (id: string) => `Use the Skill tool with skill: ${JSON.stringify(id)} for this request.`

test('recovers Teams, computer use, skills, plugins and a command from the durable prompt format', () => {
  const plugin = 'Use plugin "github@connectors" for this request.'
  const prompt = buildComposerMessage(`${skill('computer-use')}\n\n${skill('owner:review')}\n\n${plugin}\n\n/check 看一下`, [], true).content
  expect(userMessageDisplay(prompt)).toEqual({
    text: '看一下',
    capabilities: [
      { kind: 'team', id: 'agent-team', label: 'Agent 团队' },
      { kind: 'computer', id: 'computer-use', label: '操作电脑' },
      { kind: 'skill', id: 'owner:review', label: '@review' },
      { kind: 'plugin', id: 'github@connectors', label: '@github' },
      { kind: 'command', id: '/check', label: '/check' },
    ],
  })
})

test('does not consume paths, inline slash text, mentions, command arguments or Markdown code', () => {
  for (const text of ['手写 @review /check', '/folder/file 原样保留', '```\n/check\n```']) {
    expect(userMessageDisplay(text)).toEqual({ text, capabilities: [] })
  }
  expect(userMessageDisplay('/review /argument').text).toBe('/argument')
  expect(userMessageDisplay(`${skill('review')}\n\n/review /argument`)).toEqual({
    text: '/argument',
    capabilities: [
      { kind: 'skill', id: 'review', label: '@review' },
      { kind: 'command', id: '/review', label: '/review' },
    ],
  })
})

test('deduplicates repeated references without merging different kinds and handles capability-only messages', () => {
  const prompt = `${skill('review')}\n\n${skill('review')}\n\nUse plugin "review" for this request.`
  for (let pass = 0; pass < 3; pass++) {
    expect(userMessageDisplay(prompt)).toEqual({ text: '', capabilities: [
      { kind: 'skill', id: 'review', label: '@review' },
      { kind: 'plugin', id: 'review', label: '@review' },
    ] })
  }
  expect(userMessageDisplay('Skill(owner:computer-use) 点击播放').capabilities).toEqual([
    { kind: 'computer', id: 'owner:computer-use', label: '操作电脑' },
  ])
  expect(userMessageDisplay('没有闭合的 <agent-team-request> 原文').text).toBe('没有闭合的 <agent-team-request> 原文')
})

test('recovers Browser Use without fabricating an Agent Team badge and handles combined envelopes', () => {
  const browserOnly = buildComposerMessage('打开 modeldial.com', [], false, { browserUse: 'workspace' }).content
  expect(userMessageDisplay(browserOnly)).toEqual({
    text: '打开 modeldial.com',
    capabilities: [
      { kind: 'browser', id: 'browser-use', label: '浏览器 · 工作区' },
    ],
  })
  const combined = buildComposerMessage('并行检查页面', [], true, { browserUse: 'chrome' }).content
  expect(userMessageDisplay(combined)).toEqual({
    text: '并行检查页面',
    capabilities: [
      { kind: 'team', id: 'agent-team', label: 'Agent 团队' },
      { kind: 'browser', id: 'browser-use', label: '浏览器 · Chrome' },
    ],
  })
})
