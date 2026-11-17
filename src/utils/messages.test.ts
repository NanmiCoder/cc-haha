import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { BUSINESS_ERROR_CODES } from '../constants/businessErrors.js'
import {
  getAssistantMessageFromError,
  getImageTooLargeErrorMessage,
} from '../services/api/errors.js'
import type { Tool } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import { createAttachmentMessage } from './attachments.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
  normalizeContentFromAPI,
  replaceMediaWithPlaceholders,
  stripSignatureBlocksAfterModelChange,
} from './messages.js'

function assistant(
  messageId: string,
  content: AssistantMessage['message']['content'],
): AssistantMessage {
  const message = createAssistantMessage({ content })
  message.message.id = messageId
  return message
}

function toolUse(id: string): AssistantMessage['message']['content'][number] {
  return {
    type: 'tool_use',
    id,
    name: 'Read',
    input: { file_path: `/tmp/${id}` },
  }
}

function toolResult(id: string) {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: 'ok',
      },
    ] as ContentBlockParam[],
  })
}

describe('background task guidance at the model boundary', () => {
  const notification = '<task-notification><task-id>build</task-id><status>failed</status><summary>Background command "build" failed with exit code 143</summary></task-notification>'
  const guidance = 'Treat background task notifications as internal lifecycle updates'
  const text = (messages: ReturnType<typeof normalizeMessagesForAPI>) =>
    JSON.stringify(messages.map(message => message.message.content))

  test('guides an idle follow-up without changing its original XML or provenance', () => {
    const message = createUserMessage({ content: notification, origin: { kind: 'task-notification' } })
    const before = JSON.stringify(message)
    const normalized = normalizeMessagesForAPI([message])

    expect(text(normalized)).toContain(guidance)
    expect(text(normalized)).toContain('Do not infer intentional cleanup from exit code 143 alone')
    expect(text(normalized)).toContain('Investigate failures that block the requested task')
    expect(normalized[0]?.type === 'user' && normalized[0].origin).toEqual({ kind: 'task-notification' })
    expect(JSON.stringify(message)).toBe(before)
    expect(text(normalized)).toContain('task-id>build</task-id>')
    expect(text(normalizeMessagesForAPI(normalized)).split(guidance)).toHaveLength(2)
  })

  test('guides queued results while preserving a real user message in the same tool round', () => {
    const human = createUserMessage({ content: 'Please also check the API.' })
    const update = createAttachmentMessage({ type: 'queued_command', commandMode: 'task-notification', prompt: notification })
    const before = JSON.stringify([human, update])
    const normalized = normalizeMessagesForAPI([human, update])

    expect(text(normalized)).toContain(guidance)
    expect(text(normalized)).toContain('Please also check the API.')
    expect(text(normalized)).toContain('failed with exit code 143')
    expect(JSON.stringify([human, update])).toBe(before)
  })

  test('does not reclassify a user quoting a task notification as an internal update', () => {
    const message = createUserMessage({ content: `Why did this fail? ${notification}` })
    expect(text(normalizeMessagesForAPI([message]))).not.toContain(guidance)
  })

  test('leaves hook and cancellation instructions using the same queue mode unchanged', () => {
    const message = createUserMessage({ content: 'The user stopped this task. Wait for their next message.', origin: { kind: 'task-notification' } })
    const update = createAttachmentMessage({ type: 'queued_command', commandMode: 'task-notification', prompt: 'A hook blocked this action. Fix its reported error.' })
    expect(text(normalizeMessagesForAPI([message, update]))).not.toContain(guidance)
  })

  test.each([
    { name: 'missing', prompt: undefined },
    { name: 'null', prompt: null },
    { name: 'number', prompt: 42 },
    { name: 'object', prompt: {} },
    { name: 'null block', prompt: [null] },
    { name: 'primitive block', prompt: [7] },
    { name: 'missing text', prompt: [{ type: 'text' }] },
    { name: 'non-string text', prompt: [{ type: 'text', text: 42 }] },
  ])('keeps normal user input after malformed queued prompt: $name', ({ prompt }) => {
    const update = createAttachmentMessage({ type: 'queued_command', commandMode: 'task-notification', prompt: prompt as never })
    const human = createUserMessage({ content: 'Please continue checking the API.' })
    const normalized = normalizeMessagesForAPI([update, human])

    expect(text(normalized)).toContain('Please continue checking the API.')
    expect(text(normalized)).not.toContain(guidance)
  })

  test('adds the shared guidance once for several separate background results', () => {
    const messages = [
      createUserMessage({ content: notification, origin: { kind: 'task-notification' } }),
      createAssistantMessage({ content: 'The requested work is complete.' }),
      createUserMessage({ content: notification.replace('build', 'checks'), origin: { kind: 'task-notification' } }),
    ]
    expect(text(normalizeMessagesForAPI(messages)).split(guidance)).toHaveLength(2)
  })
})

describe('normalizeMessagesForAPI assistant fragment indexing', () => {
  test('preserves a 10,000-step tool-result chain', () => {
    const messages = [createUserMessage({ content: 'start' })]

    for (let i = 0; i < 10_000; i++) {
      const toolId = `tool-${i}`
      messages.push(
        assistant(`response-${i}`, [toolUse(toolId)]),
        toolResult(toolId),
      )
    }

    const normalized = normalizeMessagesForAPI(messages)
    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )
    const toolResults = normalized.filter(message => message.type === 'user')

    expect(normalized).toHaveLength(20_001)
    expect(assistants).toHaveLength(10_000)
    expect(toolResults).toHaveLength(10_001)
    expect(assistants.at(-1)?.message.id).toBe('response-9999')
    expect(toolResults.at(-1)?.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tool-9999',
        content: 'ok',
      },
    ])
  })

  test('merges interleaved response IDs across tool-result messages', () => {
    const normalized = normalizeMessagesForAPI([
      assistant('response-a', [toolUse('tool-a')]),
      toolResult('tool-a'),
      assistant('response-b', [toolUse('tool-b')]),
      toolResult('tool-b'),
      assistant('response-a', [{ type: 'text', text: 'A complete' }]),
      assistant('response-b', [{ type: 'text', text: 'B complete' }]),
    ])

    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )

    expect(assistants.map(message => message.message.id)).toEqual([
      'response-a',
      'response-b',
    ])
    expect(assistants[0]!.message.content.map(block => block.type)).toEqual([
      'tool_use',
      'text',
    ])
    expect(assistants[1]!.message.content.map(block => block.type)).toEqual([
      'tool_use',
      'text',
    ])
  })

  test('does not merge the same response ID across a normal user turn', () => {
    const normalized = normalizeMessagesForAPI([
      assistant('response-a', [{ type: 'text', text: 'before' }]),
      createUserMessage({ content: 'next turn' }),
      assistant('response-a', [{ type: 'text', text: 'after' }]),
    ])

    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )

    expect(assistants).toHaveLength(2)
    expect(
      assistants.map(message =>
        message.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join(''),
      ),
    ).toEqual(['before', 'after'])
  })
})

describe('normalizeMessagesForAPI tool-result media', () => {
  test('preserves nested images from restored messages at the API boundary', () => {
    const image = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: 'AAECAwQ=',
      },
    }
    const message = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: [image],
        },
      ],
    })

    const [normalized] = normalizeMessagesForAPI([message])

    expect(normalized?.type).toBe('user')
    if (normalized?.type === 'user') {
      expect(normalized.message.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: [image],
        },
      ])
    }
  })

  test('keeps parallel tool results contiguous and preserves their ownership', () => {
    const imageA = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'A' },
    }
    const imageB = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'B' },
    }
    const message = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'tool-a', content: [imageA] },
        { type: 'tool_result', tool_use_id: 'tool-b', content: [imageB] },
      ],
    })

    const [normalized] = normalizeMessagesForAPI([message])

    expect(normalized?.type).toBe('user')
    if (normalized?.type === 'user') {
      expect(normalized.message.content).toEqual([
        { type: 'tool_result', tool_use_id: 'tool-a', content: [imageA] },
        { type: 'tool_result', tool_use_id: 'tool-b', content: [imageB] },
      ])
    }
  })
})

describe('stripSignatureBlocksAfterModelChange', () => {
  test('removes protected thinking from history produced by another model', () => {
    const previous = assistant('response-a', [
      { type: 'redacted_thinking', data: 'encrypted reasoning' },
      { type: 'thinking', thinking: 'visible reasoning', signature: 'model-bound' },
      { type: 'text', text: 'Keep this answer.' },
    ])
    previous.message.model = 'gpt-luna'

    const messages = [previous, createUserMessage({ content: 'Continue' })]
    const result = stripSignatureBlocksAfterModelChange(messages, 'deepseek-v4-flash')

    expect(result).not.toBe(messages)
    expect(result[0]?.type).toBe('assistant')
    if (result[0]?.type === 'assistant') {
      expect(result[0].message.content).toEqual([
        { type: 'text', text: 'Keep this answer.' },
      ])
    }
    expect(previous.message.content.map(block => block.type)).toEqual([
      'redacted_thinking',
      'thinking',
      'text',
    ])
  })

  test('preserves protected thinking when the model has not changed', () => {
    const previous = assistant('response-a', [
      { type: 'redacted_thinking', data: 'encrypted reasoning' },
      { type: 'text', text: 'Keep all blocks.' },
    ])
    previous.message.model = 'deepseek-v4-flash'
    const messages = [previous, createUserMessage({ content: 'Continue' })]

    expect(
      stripSignatureBlocksAfterModelChange(messages, 'deepseek-v4-flash[1m]'),
    ).toBe(messages)
  })

  test('leaves history without protected thinking untouched', () => {
    const messages = [createUserMessage({ content: 'Continue' })]

    expect(
      stripSignatureBlocksAfterModelChange(messages, 'deepseek-v4-flash'),
    ).toBe(messages)
  })

  test('keeps removing the old model thinking after the new model has thought', () => {
    // Streaming stores each block as its own same-id assistant message.
    const geminiThinking = assistant('gemini-turn', [
      { type: 'thinking', thinking: '', signature: '' },
    ])
    const geminiSignature = assistant('gemini-turn', [
      {
        type: 'redacted_thinking',
        data: 'cc-haha:gemini-thought-signature:v1:abc',
      },
    ])
    const geminiTool = assistant('gemini-turn', [toolUse('tool-gemini')])
    const deepseekThinking = assistant('deepseek-turn', [
      { type: 'thinking', thinking: 'plan', signature: 'deepseek-sig' },
    ])
    const deepseekTool = assistant('deepseek-turn', [toolUse('tool-deepseek')])
    for (const message of [geminiThinking, geminiSignature, geminiTool]) {
      message.message.model = 'gemini-4-argon'
    }
    for (const message of [deepseekThinking, deepseekTool]) {
      message.message.model = 'deepseek-flash'
    }
    const messages = [
      createUserMessage({ content: 'start' }),
      geminiThinking,
      geminiSignature,
      geminiTool,
      toolResult('tool-gemini'),
      createUserMessage({ content: 'continue' }),
      deepseekThinking,
      deepseekTool,
      toolResult('tool-deepseek'),
      createUserMessage({ content: 'next question' }),
    ]

    const forAPI = normalizeMessagesForAPI(
      stripSignatureBlocksAfterModelChange(messages, 'deepseek-flash'),
    )

    const assistantBlocks = forAPI
      .filter(message => message.type === 'assistant')
      .map(message => message.message.content.map(block => block.type))
    expect(assistantBlocks).toEqual([
      ['tool_use'],
      ['thinking', 'tool_use'],
    ])
  })
})

describe('malformed provider tool arguments', () => {
  test('preserves invalid JSON as a bounded marker rather than executable empty input', () => {
    const raw = '{"path":' + 'x'.repeat(3000)
    const [block] = normalizeContentFromAPI([{ type: 'tool_use', id: 'bad-call', name: 'TaskList', input: raw }], [])
    expect(block).toEqual({ type: 'tool_use', id: 'bad-call', name: 'TaskList', input: { __unparsedToolInput: { raw: raw.slice(0, 2048), len: raw.length } } })
  })

  test('retains existing history markers and still accepts genuine empty input', () => {
    const marker = { __unparsedToolInput: { raw: '{broken', len: 7 } }
    const normalized = normalizeContentFromAPI([
      { type: 'tool_use', id: 'historical', name: 'Read', input: marker },
      { type: 'tool_use', id: 'empty', name: 'TaskList', input: '' },
      { type: 'tool_use', id: 'valid', name: 'TaskList', input: '{}' },
      { type: 'tool_use', id: 'null', name: 'TaskList', input: ' null ' },
    ], [])
    expect(normalized.map(block => block.type === 'tool_use' ? block.input : null)).toEqual([marker, {}, {}, {}])
  })
})


test('malformed and restored markers bypass TaskOutput default injection and survive API history normalization', () => {
  const tool = { name: 'TaskOutput' } as Tool
  const raw = '{truncated'
  const marker = { __unparsedToolInput: { raw, len: raw.length } }
  for (const input of [raw, marker]) {
    const blocks = normalizeContentFromAPI([{ type: 'tool_use', id: 'task-output', name: tool.name, input }], [tool])
    expect(blocks[0]).toMatchObject({ input: marker })
    const restored = JSON.parse(JSON.stringify(createAssistantMessage({ content: blocks })))
    const history = normalizeMessagesForAPI([restored, toolResult('task-output')], [tool])
    expect(history[0]!.message.content).toEqual([{ type: 'tool_use', id: 'task-output', name: tool.name, input: marker }])
  }
})

test('legacy ordinary tool-use JSON still round-trips without a migration', () => {
  const tool = { name: 'Read' } as Tool
  const historical = JSON.parse(JSON.stringify(assistant('legacy-response', [toolUse('legacy-read')])))
  const blocks = normalizeContentFromAPI(historical.message.content, [tool])
  expect(blocks).toEqual(historical.message.content)
  historical.message.content = blocks
  const replay = normalizeMessagesForAPI([historical, toolResult('legacy-read')], [tool])
  expect(replay[0]!.message.content).toEqual(historical.message.content)
})

type ApiBlock = { type: string; [key: string]: unknown }

function imageBlock(chars: number) {
  return {
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: 'image/png' as const,
      data: 'A'.repeat(chars),
    },
  }
}

function screenshotResult(id: string, chars: number) {
  return createUserMessage({
    content: [
      { type: 'tool_result', tool_use_id: id, content: [imageBlock(chars)] },
    ] as ContentBlockParam[],
  })
}

// The real classifier, so the anchor is exactly what a relay's 413 produces.
function requestTooLargeAnchor() {
  return getAssistantMessageFromError(
    new APIError(413, undefined, '413 Request Entity Too Large', undefined),
    'claude-sonnet-5-5',
  )
}

function allBlocks(
  messages: ReturnType<typeof normalizeMessagesForAPI>,
): ApiBlock[] {
  const blocks: ApiBlock[] = []
  for (const message of messages) {
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content as ApiBlock[]) {
      blocks.push(block)
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        blocks.push(...(block.content as ApiBlock[]))
      }
    }
  }
  return blocks
}

const imagesIn = (blocks: ApiBlock[]) => blocks.filter(b => b.type === 'image')
// Attachment text is wrapped in a system reminder, which adds a trailing newline.
const placeholdersIn = (blocks: ApiBlock[]) =>
  blocks.filter(b => b.type === 'text' && String(b.text).trim() === '[image]')
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

describe('normalizeMessagesForAPI after a request-too-large rejection', () => {
  test('replaces images from every earlier turn, including ones nested in tool results', () => {
    const history = [createUserMessage({ content: 'do a long GUI task' })]
    for (let i = 0; i < 3; i++) {
      history.push(assistant(`a${i}`, [toolUse(`s${i}`)]), screenshotResult(`s${i}`, 300_000))
    }
    const fresh = createUserMessage({
      content: [{ type: 'text', text: 'try again' }, imageBlock(1_000)] as ContentBlockParam[],
    })

    const normalized = normalizeMessagesForAPI([...history, requestTooLargeAnchor(), fresh])
    const blocks = allBlocks(normalized)

    // Only the image sent after the rejection is still a real image.
    expect(imagesIn(blocks)).toHaveLength(1)
    expect(placeholdersIn(blocks)).toHaveLength(3)
    // Placeholders replace media in place, so tool_use/tool_result pairing holds.
    expect(
      blocks.filter(b => b.type === 'tool_result').map(b => b.tool_use_id),
    ).toEqual(['s0', 's1', 's2'])
    expect(bytesOf(normalized)).toBeLessThan(20_000)
  })

  test('covers images from @-mentioned files, which are rebuilt on every normalization', () => {
    const mention = createAttachmentMessage({
      type: 'file',
      filename: '/tmp/shot.png',
      displayPath: 'shot.png',
      content: {
        type: 'image',
        file: { base64: 'A'.repeat(300_000), type: 'image/png', originalSize: 225_000 },
      },
    } as never)
    const history = [
      mention,
      createUserMessage({ content: 'what is in @shot.png?' }),
      assistant('a0', [{ type: 'text', text: 'A screenshot.' }]),
    ]
    const followUp = createUserMessage({ content: 'and now?' })

    // Without a rejection the attachment really does contribute an image.
    expect(imagesIn(allBlocks(normalizeMessagesForAPI([...history, followUp])))).toHaveLength(1)

    const blocks = allBlocks(
      normalizeMessagesForAPI([...history, requestTooLargeAnchor(), followUp]),
    )
    expect(imagesIn(blocks)).toHaveLength(0)
    expect(placeholdersIn(blocks)).toHaveLength(1)
  })

  test('leaves a history without media exactly as it was', () => {
    const history = [createUserMessage({ content: 'dump the logs' })]
    for (let i = 0; i < 3; i++) {
      history.push(
        assistant(`a${i}`, [toolUse(`t${i}`)]),
        createUserMessage({
          content: [
            { type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(50_000) },
          ] as ContentBlockParam[],
        }),
      )
    }
    const followUp = createUserMessage({ content: 'compact it' })

    expect(
      normalizeMessagesForAPI([...history, requestTooLargeAnchor(), followUp]).map(
        m => m.message.content,
      ),
    ).toEqual(normalizeMessagesForAPI([...history, followUp]).map(m => m.message.content))
  })

  test('holds for any model: the byte limit belongs to the provider, not to one model', () => {
    const history = [
      createUserMessage({ content: 'screenshot it' }),
      assistant('a0', [toolUse('s0')]),
      screenshotResult('s0', 300_000),
    ]
    const followUp = createUserMessage({ content: 'continue' })

    const normalized = normalizeMessagesForAPI(
      [...history, requestTooLargeAnchor(), followUp],
      [],
      'a-different-model',
    )

    expect(imagesIn(allBlocks(normalized))).toHaveLength(0)
  })

  test.each([
    'Request too large (max 20MB). Try with a smaller file.',
    'Request too large (max 20MB). Double press esc to go back and try with a smaller file.',
  ])('still recognizes transcripts saved with the old wording: %s', legacyText => {
    const legacyAnchor = createAssistantAPIErrorMessage({ content: legacyText })
    expect(legacyAnchor.businessErrorCode).toBeUndefined()
    const history = [
      createUserMessage({ content: 'screenshot it' }),
      assistant('a0', [toolUse('s0')]),
      screenshotResult('s0', 300_000),
      assistant('a1', [toolUse('s1')]),
      screenshotResult('s1', 300_000),
    ]

    const blocks = allBlocks(
      normalizeMessagesForAPI([...history, legacyAnchor, createUserMessage({ content: 'go on' })]),
    )

    expect(imagesIn(blocks)).toHaveLength(0)
    expect(placeholdersIn(blocks)).toHaveLength(2)
  })

  test('other media rejections stay scoped to the turn they followed', () => {
    const earlier = createUserMessage({
      content: [{ type: 'text', text: 'first' }, imageBlock(1_000)] as ContentBlockParam[],
    })
    const oversized = createUserMessage({
      content: [{ type: 'text', text: 'second' }, imageBlock(1_000)] as ContentBlockParam[],
    })
    const anchor = createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
      businessErrorCode: BUSINESS_ERROR_CODES.IMAGE_TOO_LARGE,
    })

    const blocks = allBlocks(
      normalizeMessagesForAPI([
        earlier,
        assistant('a0', [{ type: 'text', text: 'ok' }]),
        oversized,
        anchor,
        createUserMessage({ content: 'retry' }),
      ]),
    )

    // Only the rejected turn loses its image; earlier turns are not touched.
    expect(imagesIn(blocks)).toHaveLength(1)
  })
})

describe('replaceMediaWithPlaceholders', () => {
  test('replaces top-level and tool-result media without touching the input', () => {
    const message = createUserMessage({
      content: [
        { type: 'text', text: 'see attached' },
        imageBlock(10),
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
        },
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [imageBlock(10), { type: 'text', text: 'caption' }],
        },
      ] as ContentBlockParam[],
    })
    const before = JSON.stringify(message)

    const replaced = replaceMediaWithPlaceholders(message)

    expect(replaced.message.content).toEqual([
      { type: 'text', text: 'see attached' },
      { type: 'text', text: '[image]' },
      { type: 'text', text: '[document]' },
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [
          { type: 'text', text: '[image]' },
          { type: 'text', text: 'caption' },
        ],
      },
    ])
    expect(JSON.stringify(message)).toBe(before)
  })

  test('returns the same message when it has no media', () => {
    const text = createUserMessage({ content: 'plain text' })
    const blocks = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      ] as ContentBlockParam[],
    })

    expect(replaceMediaWithPlaceholders(text)).toBe(text)
    expect(replaceMediaWithPlaceholders(blocks)).toBe(blocks)
  })
})

describe('stream retry display', () => {
  test("a mid-stream re-send clears the failed attempt's streaming tool calls", async () => {
    const { createSystemStreamingFallbackMessage, handleMessageFromStream } = await import('./messages.js')
    let toolUses = [{ index: 0, contentBlock: { type: 'tool_use', id: 'stale', name: 'Write', input: {} }, unparsedToolInput: '{"file_path":' }] as never[]
    const delivered: unknown[] = []
    const update = (f: (current: never[]) => never[]) => { toolUses = f(toolUses) }
    handleMessageFromStream(createSystemStreamingFallbackMessage('stream_retry'), message => delivered.push(message), () => {}, () => {}, update)
    expect(toolUses).toEqual([])
    expect(delivered).toHaveLength(1)

    toolUses = [{ index: 0 }] as never[]
    handleMessageFromStream(createUserMessage({ content: 'unrelated' }), () => {}, () => {}, () => {}, update)
    expect(toolUses).toHaveLength(1)
  })
})
