import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { createContextImage } from '../../utils/fixtures/contextImages.js'
import type { Message } from '../../types/message.js'
import type { ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'

const fixture = process.env.CC_HAHA_CONTEXT_IMAGES_FIXTURE === '1'
const fixtureTest = fixture ? test : test.skip
const root = fileURLToPath(new URL('../../../', import.meta.url))
if (!fixture) {
  test('context image request fixtures run with an isolated HOME and loopback transport', async () => {
    const home = await mkdtemp(join(tmpdir(), 'context-images-worker-'))
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', '--timeout=60000', fileURLToPath(import.meta.url)], {
      cwd: home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: createSandboxedTestEnvironment(home, { CC_HAHA_CONTEXT_IMAGES_FIXTURE: '1' }),
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 85_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code, stdout + stderr).toBe(0)
      expect(stderr).toContain('0 fail')
      expect(stderr).toContain('4 pass')
      process.stdout.write(stdout)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
      await rm(home, { recursive: true, force: true })
    }
  }, 90_000)
}

type Block = { type: string; text?: string; content?: Block[]; source?: { type: string; data: string; media_type: string } }
let sandbox: string
let server: ReturnType<typeof Bun.serve>
let requests: Array<{ messages: Array<{ role: string; content: Block[] | string }>; [key: string]: unknown }> = []
let source: Buffer
let image: ImageBlockParam
let queryModelWithStreaming: typeof import('./claude.js').queryModelWithStreaming
let createUserMessage: typeof import('../../utils/messages.js').createUserMessage
let createAssistantMessage: typeof import('../../utils/messages.js').createAssistantMessage
let asSystemPrompt: typeof import('../../utils/systemPromptType.js').asSystemPrompt
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext
const model = 'claude-sonnet-4-6'
const originalEnvironment = { ...process.env }
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO
const events = (content: Array<Record<string, unknown>> = [{ type: 'text', text: 'fixture accepted' }]) => [
  { type: 'message_start', message: { id: 'msg_context_fixture', type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  ...content.flatMap((block, index) => [
    { type: 'content_block_start', index, content_block: block.type === 'tool_use'
      ? { ...block, input: {} } : { ...block, text: '' } },
    { type: 'content_block_delta', index, delta: block.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text } },
    { type: 'content_block_stop', index },
  ]),
  { type: 'message_delta', delta: { stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]
let nextTools: Array<Record<string, unknown>> | undefined

beforeAll(async () => {
  if (!fixture) return
  sandbox = await mkdtemp(join(tmpdir(), 'context-image-requests-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    NODE_ENV: 'production', ANTHROPIC_API_KEY: 'offline-context-fixture-key', CLAUDE_CODE_SIMPLE: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }, originalEnvironment))
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 256 * 1024 * 1024,
    async fetch(request) {
      if (request.method === 'HEAD') return new Response(null)
      requests.push(await request.json())
      const content = nextTools
      nextTools = undefined
      return new Response(events(content).map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
  globals.MACRO = { BUILD_TIME: '' }
  ;({ queryModelWithStreaming } = await import('./claude.js'))
  ;({ createUserMessage, createAssistantMessage } = await import('../../utils/messages.js'))
  ;({ asSystemPrompt } = await import('../../utils/systemPromptType.js'))
  ;({ getEmptyToolPermissionContext } = await import('../../Tool.js'))
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
  source = await createContextImage()
  image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: source.toString('base64') } }
})
afterAll(async () => {
  if (!fixture) return
  server?.stop(true)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  await rm(sandbox, { recursive: true, force: true })
})

function imagesIn(content: Block[]): Block[] {
  return content.flatMap(block => block.type === 'image' ? [block]
    : block.type === 'tool_result' && Array.isArray(block.content) ? imagesIn(block.content) : [])
}
function sentImages(body = requests.at(-1)!) {
  return body.messages.flatMap(message => Array.isArray(message.content) ? imagesIn(message.content) : [])
}

async function send(messages: Message[]) {
  requests = []
  const errors: unknown[] = []
  for await (const message of queryModelWithStreaming({
    messages, systemPrompt: asSystemPrompt([]), thinkingConfig: { type: 'disabled' }, tools: [],
    signal: new AbortController().signal,
    options: { model, querySource: 'insights', agents: [], isNonInteractiveSession: true,
      hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false,
      getToolPermissionContext: async () => getEmptyToolPermissionContext() },
  })) if (message.type === 'assistant' && message.isApiErrorMessage) errors.push(message)
  expect(errors).toEqual([])
  return requests.at(-1)!
}

fixtureTest('actual request preparation protects merged user images and releases them after a later text input', async () => {
  const header = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#998855' } }).jpeg({ quality: 90 }).toBuffer()
  const data = Buffer.concat([header, Buffer.alloc(800 * 1024)]).toString('base64')
  const current: ImageBlockParam = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }
  const fresh: ImageBlockParam = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: header.toString('base64') } }
  const input = [{ type: 'text' as const, text: 'CURRENT HUMAN INPUT' }, ...Array.from({ length: 30 }, () => current)]
  const tool = (id: string) => createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/fresh.png' } }] })
  const result = (id: string) => createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: [fresh] }] })
  const attachment = (value: unknown) => ({ type: 'attachment', attachment: value,
    uuid: crypto.randomUUID(), timestamp: new Date().toISOString() }) as Message
  for (const kind of ['meta', 'queued', 'file attachments', 'next text', 'next text after whitespace',
    'next text before Read', 'next text after whitespace before Read'] as const) {
    const readRound = !kind.includes('before Read')
    const messages = kind === 'queued' ? [createUserMessage({ content: 'Initial task' }), tool('previous-read'), result('previous-read'),
      attachment({ type: 'queued_command', prompt: input, source_uuid: '10000000-0000-4000-8000-000000001888', commandMode: 'prompt' }),
      tool('current-read'), result('current-read'),
    ] : kind === 'file attachments' ? [createUserMessage({ content: 'CURRENT HUMAN INPUT' }),
      ...Array.from({ length: 30 }, (_, index) => attachment({ type: 'file', filename: `/fixtures/input-${index}.jpg`,
        content: { type: 'image', file: { base64: data, type: 'image/jpeg', originalSize: Buffer.from(data, 'base64').length } } })),
      tool('current-read'), result('current-read'),
    ] : [createUserMessage({ content: input }),
      ...(kind === 'meta' ? [] : [createAssistantMessage({ content: [{ type: 'text', text: kind.includes('whitespace') ? ' \n' : 'old task complete' }] }),
        createUserMessage({ content: 'New text-only task' })]),
      attachment({ type: 'opened_file_in_ide', filename: '/fixtures/example.ts' }),
      ...(readRound ? [tool('current-read'), result('current-read')] : []),
    ]
    const before = JSON.stringify(messages)
    const body = await send(messages)
    const images = sentImages(body)
    const currentImages = images.filter(image => image.source!.data === data)
    if (kind === 'meta' || kind === 'queued' || kind === 'file attachments') expect(currentImages).toHaveLength(30)
    else {
      expect(currentImages.length).toBeGreaterThan(0)
      expect(currentImages.length).toBeLessThan(30)
      expect(images.reduce((sum, image) => sum + image.source!.data.length, 0)).toBeLessThanOrEqual(24 * 1024 * 1024)
    }
    if (readRound) {
      const toolResult = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && (block as Block & { tool_use_id: string }).tool_use_id === 'current-read')!
      expect(imagesIn(toolResult.content!)).toHaveLength(1)
    }
    expect(JSON.stringify(messages)).toBe(before)
  }
})

fixtureTest('legacy tool image history is optimized on the actual request and survives Chat/Responses serialization', async () => {
  const history: Message[] = [createUserMessage({ content: 'Inspect each frame, preserving the captions.' })]
  for (let index = 0; index < 59; index++) {
    const id = `read-old-${index}`
    history.push(createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/original.png' } }] }),
      createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id,
        content: [{ type: 'text', text: `caption ${index}` }, image] }] }))
  }
  const path = join(sandbox, 'legacy.jsonl')
  const sessionId = '10000000-0000-4000-8000-000000001888'
  const fixtureText = history.map((message, index) => JSON.stringify({ ...message,
    parentUuid: index ? history[index - 1]!.uuid : null, sessionId,
    timestamp: new Date(1700000000000 + index).toISOString(), isSidechain: false,
  })).join('\n') + '\n'
  await writeFile(path, fixtureText)
  const { loadMessagesFromJsonlPath } = await import('../../utils/conversationRecovery.js')
  const restored = await loadMessagesFromJsonlPath(path)
  const body = await send(restored.messages as Message[])
  const bodyJson = JSON.stringify(body)
  const output = sentImages(body)
  expect(output.length).toBeGreaterThan(0)
  expect(output.length).toBeLessThanOrEqual(59)
  expect(Buffer.byteLength(bodyJson)).toBeLessThan(32 * 1024 * 1024)
  expect(output.at(-1)!.source!.data).not.toBe((image.source as { data: string }).data)
  for (const block of output.filter((block, index) => output.findIndex(image => image.source!.data === block.source!.data) === index)) {
    const bytes = Buffer.from(block.source!.data, 'base64')
    const metadata = await sharp(bytes).metadata()
    expect(block.source!.media_type).toBe(`image/${metadata.format}`)
    expect(metadata.width).toBeGreaterThanOrEqual(1568)
  }
  for (let index = 0; index < 59; index++) expect(bodyJson).toContain(`caption ${index}`)
  expect(await readFile(path, 'utf8')).toBe(fixtureText)
  const { anthropicToOpenaiChat } = await import('../../server/proxy/transform/anthropicToOpenaiChat.js')
  const { anthropicToOpenaiResponses } = await import('../../server/proxy/transform/anthropicToOpenaiResponses.js')
  for (const converted of [anthropicToOpenaiChat(body as never), anthropicToOpenaiResponses(body as never)]) {
    const json = JSON.stringify(converted)
    expect(Buffer.byteLength(json)).toBeLessThan(32 * 1024 * 1024)
    expect(json).toContain(`data:${output[0]!.source!.media_type};base64,${output[0]!.source!.data}`)
    expect(json).toContain('caption 58')
  }
  const processor = await import('../../tools/FileReadTool/imageProcessor.js')
  const unavailable = spyOn(processor, 'getImageProcessor').mockRejectedValue(new Error('fixture unavailable'))
  try {
    const fallback = await send(restored.messages as Message[])
    expect(sentImages(fallback).length).toBeGreaterThan(0)
    expect(sentImages(fallback).length).toBeLessThan(59)
    expect(sentImages(fallback).at(-1)!.source!.data).toBe((image.source as { data: string }).data)
    for (const converted of [fallback, anthropicToOpenaiChat(fallback as never), anthropicToOpenaiResponses(fallback as never)]) {
      const json = JSON.stringify(converted)
      expect(Buffer.byteLength(json)).toBeLessThan(32 * 1024 * 1024)
      expect(json).toContain('[Image omitted from this request to keep older image data')
      expect(json).toContain('caption 0')
      expect(json).toContain('caption 58')
      expect(json).toContain('read-old-58')
    }
    console.info(JSON.stringify({ scenario: '59 legacy Read images through Anthropic/Chat/Responses',
      originalImageBytes: source.length * 59, compressedRequestBytes: Buffer.byteLength(bodyJson),
      compressedImagesRetained: output.length, fallbackImagesRetained: sentImages(fallback).length,
      fallbackRequestBytes: Buffer.byteLength(JSON.stringify(fallback)), originalTranscriptUnchanged: true }))
  } finally { unavailable.mockRestore() }
  expect(await readFile(path, 'utf8')).toBe(fixtureText)
}, 60_000)

fixtureTest('Azure request applies the same image optimization before producing its Responses input', async () => {
  const { requestAzureOpenAI } = await import('./azureOpenAI.js')
  const oldBase = process.env.AZURE_OPENAI_BASE_URL
  const oldKey = process.env.AZURE_OPENAI_API_KEY
  process.env.AZURE_OPENAI_BASE_URL = 'https://azure-fixture.invalid'
  process.env.AZURE_OPENAI_API_KEY = 'fake-azure-key'
  let captured: Record<string, unknown> | undefined
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    captured = JSON.parse(String(init!.body))
    return Response.json({ id: 'response_fixture', output_text: 'accepted', usage: { input_tokens: 1, output_tokens: 1 } })
  })
  try {
    const messages = [{ type: 'attachment', attachment: { type: 'opened_file_in_ide', filename: '/fixture.ts' } } as Message,
      createUserMessage({ content: [image] }),
      createAssistantMessage({ content: [{ type: 'tool_use', id: 'azure-read', name: 'Read', input: {} }] }),
      createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'azure-read', content: [image] }] })]
    const before = JSON.stringify(messages)
    await requestAzureOpenAI({ model: 'fixture-deployment', systemPrompt: '', messages, tools: [],
      maxOutputTokens: 100, signal: new AbortController().signal, agents: [],
      getToolPermissionContext: async () => getEmptyToolPermissionContext() })
    const serialized = JSON.stringify(captured)
    expect(serialized).not.toContain((image.source as { data: string }).data)
    expect(serialized.match(/data:image\/[^;]+;base64,/g)).toHaveLength(2)
    expect(serialized).toContain('azure-read')
    expect(Buffer.byteLength(serialized)).toBeLessThan(source.length)
    expect(JSON.stringify(messages)).toBe(before)
    const processor = await import('../../tools/FileReadTool/imageProcessor.js')
    const unavailable = spyOn(processor, 'getImageProcessor').mockRejectedValue(new Error('fixture unavailable'))
    try {
      const padded = Buffer.concat([await sharp({ create: { width: 100, height: 100, channels: 3,
        background: '#998855' } }).png().toBuffer(), Buffer.alloc(800 * 1024)])
      const oldImage: ImageBlockParam = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: padded.toString('base64') } }
      await requestAzureOpenAI({ model: 'fixture-deployment', systemPrompt: '', messages: [
        createAssistantMessage({ content: [{ type: 'tool_use', id: 'azure-old-read', name: 'Read', input: { file_path: '/old.png' } }] }),
        createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'azure-old-read',
          content: [{ type: 'text', text: 'old caption' }, ...Array.from({ length: 30 }, () => oldImage)] }] }),
        createAssistantMessage({ content: [{ type: 'text', text: 'ready' }] }),
        createUserMessage({ content: [{ type: 'text', text: 'current caption' }, image, image] }),
      ], tools: [], maxOutputTokens: 100, signal: new AbortController().signal, agents: [],
      getToolPermissionContext: async () => getEmptyToolPermissionContext() })
      const json = JSON.stringify(captured)
      expect(json).toContain('[Image omitted from this request to keep older image data')
      expect(json).toContain('azure-old-read')
      expect(json).toContain('old caption')
      expect(json).toContain('current caption')
      expect(json.split((image.source as { data: string }).data)).toHaveLength(3)
      expect(Buffer.byteLength(json)).toBeLessThan(32 * 1024 * 1024)
    } finally { unavailable.mockRestore() }
  } finally {
    transport.mockRestore()
    if (oldBase === undefined) delete process.env.AZURE_OPENAI_BASE_URL
    else process.env.AZURE_OPENAI_BASE_URL = oldBase
    if (oldKey === undefined) delete process.env.AZURE_OPENAI_API_KEY
    else process.env.AZURE_OPENAI_API_KEY = oldKey
  }
})

fixtureTest('actual CLI Read persists compressed images and resumes them without touching the originals', async () => {
  const home = join(sandbox, 'cli')
  const project = join(home, 'project')
  await mkdir(project, { recursive: true })
  const path = join(project, 'render.png')
  await writeFile(path, source)
  const sessionId = '10000000-0000-4000-8000-000000001889'
  for (const resume of [false, true]) {
    requests = []
    if (!resume) nextTools = [{ type: 'tool_use', id: 'read-context-render', name: 'Read', input: { file_path: path } }]
    const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', join(root, 'preload.ts'),
      join(root, 'src/entrypoints/cli.tsx'), '--print', '--model', model,
      '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose',
      resume ? '--resume' : '--session-id', sessionId,
      resume ? 'Inspect the previous render again.' : 'Read render.png and describe the image.',
    ], { cwd: project, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: createSandboxedTestEnvironment(home, { NODE_ENV: 'production', ANTHROPIC_API_KEY: 'offline-cli-context-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CALLER_DIR: project, CLAUDE_CODE_SIMPLE: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CC_HAHA_SKIP_DOTENV: '1' }),
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code, stdout + stderr).toBe(0)
      const result = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(message => message.type === 'result')
      expect(result?.is_error, stdout + stderr).toBe(false)
      const output = sentImages()
      expect(output, stdout + stderr).toHaveLength(1)
      expect(Buffer.from(output[0]!.source!.data, 'base64').length).toBeLessThan(source.length / 2)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    }
  }
  expect(await readFile(path)).toEqual(source)
  const projects = join(home, '.claude', 'projects')
  const history = (await Promise.all((await readdir(projects)).map(async directory => {
    const path = join(projects, directory)
    return Promise.all((await readdir(path)).filter(file => file.endsWith('.jsonl')).map(file => readFile(join(path, file), 'utf8')))
  }))).flat().join('\n')
  expect(history).not.toContain(source.toString('base64'))
  expect(history).toContain(sentImages()[0]!.source!.data)
}, 50_000)
