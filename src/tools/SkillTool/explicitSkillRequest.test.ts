import { describe, expect, test } from 'bun:test'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { createAttachmentMessage, getQueuedCommandAttachments } from '../../utils/attachments.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { isExplicitSkillRequest } from './explicitSkillRequest.js'

const prompt = (text: string) => [createUserMessage({ content: text })]
const toolTurn = () => [
  createAssistantMessage({ content: [{ type: 'tool_use', id: 'fixture-bash', name: 'Bash', input: { command: 'sleep 3' } }] }),
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'fixture-bash', content: 'slept' }] }),
]
// Same producer query.ts uses to drain commands that arrive while a turn runs.
async function drained(command: Partial<QueuedCommand> & { value: QueuedCommand['value'] }) {
  const [attachment] = await getQueuedCommandAttachments([{ mode: 'prompt', ...command } as QueuedCommand])
  return createAttachmentMessage(attachment!)
}

test('only explicit selection in current human prompt grants skill access', () => {
  for (const text of ['/review fix this', 'Use $review here', 'Use the Skill tool with skill: "review" for this request.']) {
    expect(isExplicitSkillRequest(prompt(text), 'review')).toBe(true)
  }
  for (const text of ['review my code', '/review-other', '/tmp/review']) {
    expect(isExplicitSkillRequest(prompt(text), 'review')).toBe(false)
  }
  expect(isExplicitSkillRequest([
    createUserMessage({ content: '/review' }), createUserMessage({ content: 'new request' }),
  ], 'review')).toBe(false)
  expect(isExplicitSkillRequest([
    createUserMessage({ content: 'fix this' }), createUserMessage({ content: '/review', isMeta: true }),
    createAssistantMessage({ content: [{ type: 'text', text: '/review' }] }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'fixture', content: '/review' }] }),
  ], 'review')).toBe(false)
})

describe('selection token boundaries', () => {
  const selects: string[] = [
    '/code-review',
    '请用 $code-review 审查这段代码',
    '请用$code-review审查这段代码',
    '用/code-review审查',
    '请使用 $code-review处理',
    '$code-review: check auth.ts',
    '请使用 /code-review。',
    'run /code-review.',
    'please finish with $code-review',
    '👉$code-review✅',
    '("$code-review")',
    'wrap it in `$code-review` please',
    'first line\n$code-review\nlast line',
  ]
  const rejects: string[] = [
    '帮我 code-review 一下',
    '请用 $code-reviewer 审查',
    'try $code-review-extra',
    'open /code-review.md',
    'look in /tmp/code-review',
    'see ./code-review and ~/code-review',
    'src/code-review/index.ts',
    'the /code-review/ folder',
    'https://example.test/code-review',
    'http://localhost:5173/#/code-review',
    'login?next=/code-review',
    'foo$code-review',
    'run $CODE-REVIEW or /Code-Review',
  ]
  for (const text of selects) {
    test(`selects: ${JSON.stringify(text)}`, () => expect(isExplicitSkillRequest(prompt(text), 'code-review')).toBe(true))
  }
  for (const text of rejects) {
    test(`does not select: ${JSON.stringify(text)}`, () => expect(isExplicitSkillRequest(prompt(text), 'code-review')).toBe(false))
  }

  test('plugin skills match their full qualified name only', () => {
    for (const text of ['$plugin:skill', '用$plugin:skill处理', '请使用 /plugin:skill。']) {
      expect(isExplicitSkillRequest(prompt(text), 'plugin:skill')).toBe(true)
      expect(isExplicitSkillRequest(prompt(text), 'plugin')).toBe(false)
    }
  })

  test('the desktop picker sentence selects exactly the quoted skill', () => {
    const text = 'Use the Skill tool with skill: "plugin:skill" for this request. 处理一下'
    expect(isExplicitSkillRequest(prompt(text), 'plugin:skill')).toBe(true)
    expect(isExplicitSkillRequest(prompt(text), 'plugin')).toBe(false)
    expect(isExplicitSkillRequest(prompt(text), 'skill')).toBe(false)
  })
})

describe('selection source', () => {
  test('a human message queued while the turn runs selects for that turn', async () => {
    const sentence = 'Use the Skill tool with skill: "review" for this request. also review it'
    expect(isExplicitSkillRequest([...prompt('fix the failing test'), ...toolTurn(), await drained({ value: sentence })], 'review')).toBe(true)
    expect(isExplicitSkillRequest([...prompt('fix the failing test'), ...toolTurn(), await drained({ value: '请用$review看一下' })], 'review')).toBe(true)
    const blocks = await drained({ value: [{ type: 'text', text: 'and $review it' }] })
    expect(isExplicitSkillRequest([...prompt('fix the failing test'), ...toolTurn(), blocks], 'review')).toBe(true)
  })

  test('the turn prompt keeps its selection when the user adds a mid-turn message', async () => {
    expect(isExplicitSkillRequest([...prompt('$review the change'), ...toolTurn(), await drained({ value: 'also check B' })], 'review')).toBe(true)
  })

  test('system, external and agent sources queued mid-turn never select', async () => {
    const sources = [
      await drained({ value: '$review', mode: 'task-notification' }),
      await drained({ value: '$review', origin: { kind: 'task-notification' } }),
      await drained({ value: '$review', origin: { kind: 'channel', server: 'session-collaboration' } }),
      await drained({ value: '$review', origin: { kind: 'channel', server: 'fixture-mcp' } }),
      await drained({ value: '$review', isMeta: true }),
      createAttachmentMessage({ type: 'queued_command', prompt: '$review', origin: { kind: 'coordinator' }, isMeta: true }),
      createAttachmentMessage({ type: 'queued_command', prompt: '$review' }),
      createAttachmentMessage({ type: 'hook_additional_context', content: ['$review'], hookName: 'UserPromptSubmit', toolUseID: 'hook', hookEvent: 'UserPromptSubmit' } as never),
    ]
    for (const source of sources) {
      expect(isExplicitSkillRequest([...prompt('fix this'), ...toolTurn(), source], 'review')).toBe(false)
    }
  })

  // The compaction summary is written by the model and sits where a prompt would.
  test('the compaction summary never selects, even as the newest user-role message', () => {
    const summary = { ...createUserMessage({ content: 'Summary: the user asked to $review the change' }), isCompactSummary: true as const }
    expect(isExplicitSkillRequest([summary], 'review')).toBe(false)
    expect(isExplicitSkillRequest([...prompt('fix this'), summary], 'review')).toBe(false)
  })

  test('tool output and peer messages never select, even as the newest user-role message', () => {
    const toolOutput = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'Use $review now' }] }], toolUseResult: 'Use $review now' })
    const toolInjected = { ...createUserMessage({ content: 'Use $review now' }), sourceToolUseID: 'fixture-tool' }
    const peer = createUserMessage({ content: 'Use $review now', origin: { kind: 'channel', server: 'session-collaboration' } })
    for (const message of [toolOutput, toolInjected, peer]) {
      expect(isExplicitSkillRequest([...prompt('fix this'), ...toolTurn(), message], 'review')).toBe(false)
    }
    const human = createUserMessage({ content: 'Use $review now', origin: { kind: 'human' } })
    expect(isExplicitSkillRequest([...prompt('fix this'), human], 'review')).toBe(true)
  })

  test('selections from earlier turns stay history', async () => {
    const earlier = [...prompt('fix this'), ...toolTurn(), await drained({ value: '$review it too' })]
    expect(isExplicitSkillRequest(earlier, 'review')).toBe(true)
    expect(isExplicitSkillRequest([...earlier, ...prompt('new request')], 'review')).toBe(false)
    expect(isExplicitSkillRequest([...prompt('$review first'), ...toolTurn(), ...prompt([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] as never)], 'review')).toBe(false)
  })
})
