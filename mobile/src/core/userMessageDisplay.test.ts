import { expect, test } from 'bun:test'
import { buildComposerMessage } from './chatComposer'
import { userMessageDisplay } from './userMessageDisplay'

const skill = (id: string) => `Use the Skill tool with skill: ${JSON.stringify(id)} for this request.`

test('recovers Teams, computer use, skills, plugins and a command from the durable prompt format', () => {
  const plugin = 'Use plugin "github@connectors" for this request.'
  const prompt = buildComposerMessage(`${skill('computer-use')}\n\n${skill('owner:review')}\n\n${plugin}\n\n/check Take a look`, [], true).content
  expect(userMessageDisplay(prompt)).toEqual({
    text: 'Take a look',
    capabilities: [
      { kind: 'team', id: 'agent-team', label: 'Agent Team' },
      { kind: 'computer', id: 'computer-use', label: 'Computer use' },
      { kind: 'skill', id: 'owner:review', label: '@review' },
      { kind: 'plugin', id: 'github@connectors', label: '@github' },
      { kind: 'command', id: '/check', label: '/check' },
    ],
  })
})

test('does not consume paths, inline slash text, mentions, command arguments or Markdown code', () => {
  for (const text of ['Handwritten @review /check', '/folder/file Keep as is', '```\n/check\n```']) {
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
  expect(userMessageDisplay('Skill(owner:computer-use) Tap to play').capabilities).toEqual([
    { kind: 'computer', id: 'owner:computer-use', label: 'Computer use' },
  ])
  expect(userMessageDisplay('Raw text with unclosed <agent-team-request>').text).toBe('Raw text with unclosed <agent-team-request>')
})
