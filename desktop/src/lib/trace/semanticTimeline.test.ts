import { describe, expect, it } from 'vitest'

import {
  classifyUserContent,
  splitRequestMessages,
} from './semanticTimeline'
import type { NormalizedBlock, NormalizedMessage } from './types'

const text = (value: string): NormalizedBlock => ({ type: 'text', text: value })

describe('classifyUserContent', () => {
  it('keeps a plain typed message as user text', () => {
    const result = classifyUserContent([text('install the topic skill mentioned in here')])
    expect(result.injections).toEqual([])
    expect(result.userText).toBe('install the topic skill mentioned in here')
  })

  it('separates harness reminders from the text the person typed', () => {
    const result = classifyUserContent([
      text('<system-reminder>\n# Companion\n\nA small chonk named Quirky Spark…\n</system-reminder>'),
      text('<system-reminder>\nThe following skills are available for use with the Skill tool:\n- update-config\n</system-reminder>'),
      text('<system-reminder>\nAs you answer the user\'s questions…\n# claudeMd\nCodebase instructions\n</system-reminder>'),
      text('https://mp.weixin.qq.com/s/abc install the skill mentioned in here'),
    ])

    expect(result.userText).toBe('https://mp.weixin.qq.com/s/abc install the skill mentioned in here')
    expect(result.injections).toHaveLength(3)
    expect(result.injections.every((entry) => entry.kind === 'system-reminder')).toBe(true)
    expect(result.injections[0]?.label).toBe('Companion')
    expect(result.injections[2]?.label).toBe('claudeMd')
  })

  it('labels a reminder without a heading from its first line', () => {
    const result = classifyUserContent([
      text('<system-reminder>\nThe following skills are available for use with the Skill tool:\n</system-reminder>'),
    ])
    expect(result.injections[0]?.label).toBe('The following skills are available for use with the Skill to…')
  })

  it('recognizes the deferred-tool roster as its own injection', () => {
    const result = classifyUserContent([
      text('<available-deferred-tools> AskUserQuestion EnterPlanMode WebFetch </available-deferred-tools>'),
    ])
    expect(result.injections[0]?.kind).toBe('deferred-tools')
    expect(result.userText).toBeNull()
  })

  it('keeps an instruction typed after interrupting a tool as the message, not an attachment', () => {
    // hoistToolResults moves tool results to the front of a merged user
    // message, so this is the exact shape an interrupt-then-type produces.
    const result = classifyUserContent([
      { type: 'tool_result', toolUseId: 'call_1', content: "The user doesn't want to take this action right now." },
      text('stop, fix the trace panel bug first'),
    ])
    expect(result.injections).toEqual([])
    expect(result.userText).toBe('stop, fix the trace panel bug first')
  })

  it('recognizes the other harness wrappers it knows by name', () => {
    const result = classifyUserContent([text('<background-job-complete id="x">done</background-job-complete>')])
    expect(result.injections[0]?.kind).toBe('other')
    expect(result.userText).toBeNull()
  })

  it('keeps markup the person typed as their message rather than calling it injected', () => {
    const pasted = '<div class="card">hello</div>'
    const result = classifyUserContent([text(pasted)])
    expect(result.injections).toEqual([])
    expect(result.userText).toBe(pasted)
  })

  it('ignores blank and non-text blocks', () => {
    const result = classifyUserContent([
      text('   '),
      { type: 'thinking', thinking: 'internal' },
      { type: 'image', mediaType: 'image/png' },
    ])
    expect(result.injections).toEqual([])
    expect(result.userText).toBeNull()
  })

  it('joins multiple typed paragraphs into one user text', () => {
    const result = classifyUserContent([text('first'), text('second')])
    expect(result.userText).toBe('first\n\nsecond')
  })
})

describe('splitRequestMessages', () => {
  it('lifts injections out and leaves the typed exchange behind', () => {
    const result = splitRequestMessages([
      { role: 'user', content: [text('<available-deferred-tools> WebFetch </available-deferred-tools>')] },
      {
        role: 'user',
        content: [
          text('<system-reminder>\n# Companion\nwatcher\n</system-reminder>'),
          text('install this skill'),
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }] },
    ])

    expect(result.injections.map((entry) => entry.messageIndex)).toEqual([0, 1])
    expect(result.injections[1]?.label).toBe('Companion')

    expect(result.conversation).toHaveLength(3)
    expect(result.conversation[0]).toEqual({ role: 'user', content: [text('install this skill')] })
    expect(result.conversation[1]?.role).toBe('assistant')
    expect(result.conversation[2]?.content[0]?.type).toBe('tool_result')
  })

  it('drops a user message that carried only injected context', () => {
    const result = splitRequestMessages([
      { role: 'user', content: [text('<system-reminder>only context</system-reminder>')] },
    ])
    expect(result.conversation).toEqual([])
    expect(result.injections).toHaveLength(1)
  })

  it('keeps a tool result alongside the text that arrived with it', () => {
    const result = splitRequestMessages([
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'c1', content: 'Launching skill' },
          text('Base directory for this skill: /tmp'),
        ],
      },
    ])
    expect(result.injections).toEqual([])
    expect(result.conversation).toHaveLength(1)
    expect(result.conversation[0]?.content).toEqual([
      { type: 'tool_result', toolUseId: 'c1', content: 'Launching skill' },
      text('Base directory for this skill: /tmp'),
    ])
  })

  it('carries an unexpected non-text block on a user turn through instead of dropping it', () => {
    const result = splitRequestMessages([
      {
        role: 'user',
        content: [
          text('<system-reminder>context</system-reminder>'),
          { type: 'image', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AA' },
        ],
      },
    ])
    expect(result.conversation).toHaveLength(1)
    expect(result.conversation[0]?.content).toEqual([
      { type: 'image', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AA' },
    ])
  })

  it('passes assistant messages through untouched', () => {
    const assistant: NormalizedMessage = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'private' }, text('visible')],
    }
    const result = splitRequestMessages([assistant])
    expect(result.conversation[0]).toBe(assistant)
    expect(result.injections).toEqual([])
  })
})
