import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { Message } from '../../types/message.js'
import type { ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'

const inFixtureProcess = process.env.CC_HAHA_IMAGE_DIMENSIONS_FIXTURE === '1'
const fixtureTest = inFixtureProcess ? test : test.skip

if (!inFixtureProcess) {
  test('image request and real CLI fixtures run in an isolated process', async () => {
    const home = await mkdtemp(join(tmpdir(), 'image-dimensions-worker-'))
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', fileURLToPath(import.meta.url)], {
      cwd: home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: createSandboxedTestEnvironment(home, { CC_HAHA_IMAGE_DIMENSIONS_FIXTURE: '1' }),
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 50_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(exitCode, stdout + stderr).toBe(0)
      expect(stderr).toContain('14 pass')
      expect(stderr).toContain('0 fail')
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
      await rm(home, { recursive: true, force: true })
    }
  }, 60_000)
}

const originalEnvironment = { ...process.env }
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO
let sandbox: string
let server: ReturnType<typeof Bun.serve>
let requests: Array<{ messages: Array<{ content: Block[] | string }> }> = []
let queryModelWithStreaming: typeof import('./claude.js').queryModelWithStreaming
let createUserMessage: typeof import('../../utils/messages.js').createUserMessage
let createAssistantMessage: typeof import('../../utils/messages.js').createAssistantMessage
let asSystemPrompt: typeof import('../../utils/systemPromptType.js').asSystemPrompt
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext

type Block = { type: string; text?: string; content?: Block[]; source?: { type: string; data: string; media_type: string } }
const model = 'claude-sonnet-4-6'
const events = [
  { type: 'message_start', message: { id: 'msg_image_fixture', type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture accepted' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]

beforeAll(async () => {
  if (!inFixtureProcess) return
  sandbox = await mkdtemp(join(tmpdir(), 'claude-image-dimensions-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    NODE_ENV: 'production', ANTHROPIC_API_KEY: 'offline-fixture-key',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  }, originalEnvironment))
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method === 'HEAD') return new Response(null)
    requests.push(await request.json())
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  } })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
  globals.MACRO = { BUILD_TIME: '' }
  ;({ queryModelWithStreaming } = await import('./claude.js'))
  ;({ createUserMessage, createAssistantMessage } = await import('../../utils/messages.js'))
  ;({ asSystemPrompt } = await import('../../utils/systemPromptType.js'))
  ;({ getEmptyToolPermissionContext } = await import('../../Tool.js'))
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
})

afterAll(async () => {
  if (!inFixtureProcess) return
  server?.stop(true)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  await rm(sandbox, { recursive: true, force: true })
})

function colors(index: number) {
  return [[40 + index * 5, 50, 180 - index * 3], [200 - index * 4, 180, 35 + index * 5]]
}

async function image(index: number, width: number, height = 30, format: 'png' | 'jpeg' | 'webp' | 'gif' = 'png'): Promise<ImageBlockParam> {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = colors(index)[x < width / 2 ? 0 : 1]!
      for (let c = 0; c < 3; c++) pixels[(y * width + x) * 3 + c] = color[c]!
    }
  }
  const buffer = await sharp(pixels, { raw: { width, height, channels: 3 } }).toFormat(format).toBuffer()
  expect(buffer.length).toBeLessThan(100_000)
  return { type: 'image', source: { type: 'base64', media_type: `image/${format}`, data: buffer.toString('base64') } }
}

function imagesIn(blocks: Block[]): Block[] {
  return blocks.flatMap(block => block.type === 'image' ? [block]
    : block.type === 'tool_result' && Array.isArray(block.content) ? imagesIn(block.content) : [])
}

async function send(messages: Message[]) {
  requests = []
  const before = JSON.stringify(messages)
  const errors: unknown[] = []
  for await (const message of queryModelWithStreaming({
    messages, systemPrompt: asSystemPrompt([]), thinkingConfig: { type: 'disabled' }, tools: [],
    signal: new AbortController().signal,
    options: { model, querySource: 'insights', agents: [], isNonInteractiveSession: true,
      hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false,
      getToolPermissionContext: async () => getEmptyToolPermissionContext() },
  })) {
    if (message.type === 'assistant' && message.isApiErrorMessage) errors.push(message)
  }
  expect(errors).toEqual([])
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(messages)).toBe(before)
  return requests[0]!.messages.flatMap(message => Array.isArray(message.content) ? imagesIn(message.content) : [])
}

async function verifyPixels(block: Block, index: number, width: number, height: number) {
  const data = Buffer.from(block.source!.data, 'base64')
  const metadata = await sharp(data).metadata()
  expect(block.source!.media_type).toBe(`image/${metadata.format}`)
  expect(metadata.width).toBe(width)
  expect(metadata.height).toBe(height)
  const decoded = await sharp(data).removeAlpha().raw().toBuffer()
  for (const [side, x] of [Math.floor(width / 4), Math.floor(width * 3 / 4)].entries()) {
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(decoded[(Math.floor(height / 2) * width + x) * 3 + c]! - colors(index)[side]![c]!)).toBeLessThanOrEqual(5)
    }
  }
}

for (const count of [20, 21]) {
  for (const longEdge of [2000, 2001]) {
    fixtureTest(`${count} images at ${longEdge}px use the actual outgoing request count`, async () => {
      const inputs = await Promise.all(Array.from({ length: count }, (_, index) => image(index, longEdge)))
      const output = await send([createUserMessage({ content: inputs })])
      expect(output).toHaveLength(count)
      for (let index = 0; index < count; index++) {
        await verifyPixels(output[index]!, index, count > 20 ? 2000 : longEdge, 30)
        if (count === 20 || longEdge === 2000) expect(output[index]!.source!.data).toBe((inputs[index]!.source as { data: string }).data)
      }
    })
  }
}

fixtureTest('byte-only compression shortcuts still obey the single-image dimension cap at send time', async () => {
  const { compressImageBlock } = await import('../../utils/imageResizer.js')
  const input = await compressImageBlock(await image(0, 8001))
  const output = await send([createUserMessage({ content: [input] })])
  await verifyPixels(output[0]!, 0, 8000, 30)
})

for (const orientation of [2, 6]) {
  fixtureTest(`request resizing preserves EXIF orientation ${orientation} and the displayed pixels`, async () => {
    const fixture = await image(0, 3000, 600, 'jpeg')
    const bytes = await sharp(Buffer.from((fixture.source as { data: string }).data, 'base64'))
      .withMetadata({ orientation }).toBuffer()
    const input: ImageBlockParam = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bytes.toString('base64') } }
    const before = await send([createUserMessage({ content: Array.from({ length: 20 }, () => input) })])
    expect(before[0]!.source!.data).toBe(input.source.type === 'base64' ? input.source.data : '')
    const after = await send([createUserMessage({ content: Array.from({ length: 21 }, () => input) })])
    const output = Buffer.from(after[0]!.source!.data, 'base64')
    expect(await sharp(output).metadata()).toMatchObject(orientation === 6
      ? { width: 400, height: 2000 } : { width: 2000, height: 400 })
    const expectedPixels = await sharp(bytes).autoOrient().resize(40, 40, { fit: 'fill' }).raw().toBuffer()
    const actualPixels = await sharp(output).autoOrient().resize(40, 40, { fit: 'fill' }).raw().toBuffer()
    expect(actualPixels.length).toBe(expectedPixels.length)
    for (let index = 0; index < actualPixels.length; index++) {
      expect(Math.abs(actualPixels[index]! - expectedPixels[index]!)).toBeLessThanOrEqual(5)
    }
  })
}

fixtureTest('request resizing updates existing original-image coordinate metadata', async () => {
  const { maybeResizeAndDownsampleImageBlock, createImageMetadataText } = await import('../../utils/imageResizer.js')
  const input = await maybeResizeAndDownsampleImageBlock(await image(0, 16000, 120))
  await send([createUserMessage({ content: [
    { type: 'text', text: createImageMetadataText(input.dimensions!, '/fixture.png')! },
    ...Array.from({ length: 21 }, () => input.block),
  ] })])
  const blocks = requests[0]!.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  expect(blocks[0]!.text).toBe('[Image: source: /fixture.png, original 16000x120, displayed at 2000x15. Multiply coordinates by 8.00 to map to original image.]')
  expect(blocks[1]!.text).toContain('current 2000x15 grid need no extra scaling')
})

for (const height of [53, 50, 2]) {
  fixtureTest(`coordinate notes follow encoded pixels rather than the resize box for a 3000x${height} image`, async () => {
    const input = await image(0, 3000, height)
    const { createImageMetadataText } = await import('../../utils/imageResizer.js')
    const output = await send([createUserMessage({ content: [
      { type: 'text', text: createImageMetadataText({ originalWidth: 6000, originalHeight: height * 2, displayWidth: 3000, displayHeight: height })! },
      ...Array.from({ length: 21 }, () => input),
    ] })])
    const actual = await sharp(Buffer.from(output[0]!.source!.data, 'base64')).metadata()
    const blocks = requests[0]!.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    expect(actual.width!).toBeLessThanOrEqual(2000)
    expect(blocks[0]!.text).toContain(`displayed at ${actual.width}x${actual.height}`)
    expect(blocks[0]!.text).toContain(`Multiply coordinates by ${(6000 / actual.width!).toFixed(2)}`)
    expect(blocks[1]!.text).toContain(`${actual.width}x${actual.height} pixels`)
    expect(blocks[1]!.text).toContain(`multiplying x by ${(3000 / actual.width!).toFixed(4)}`)
    expect(blocks[1]!.text).toContain(`(${actual.width! - 1},${actual.height! - 1})`)
    await verifyPixels(output[0]!, 0, actual.width!, actual.height!)
  })
}

fixtureTest('counts only surviving images after the media cap strips the oldest image', async () => {
  const inputs = await Promise.all(Array.from({ length: 21 }, (_, index) => image(index, 2001)))
  const output = await send([createUserMessage({ content: [
    ...inputs,
    ...Array.from({ length: 80 }, () => ({ type: 'document' as const,
      source: { type: 'text' as const, media_type: 'text/plain' as const, data: 'fixture' } })),
  ] })])
  expect(output).toHaveLength(20)
  for (let index = 0; index < output.length; index++) await verifyPixels(output[index]!, index + 1, 2001, 30)
})

fixtureTest('replayed history plus a new tool result crosses 20 images without changing stored pixels', async () => {
  const inputs = await Promise.all(Array.from({ length: 21 }, (_, index) => image(index, 3000, 60,
    (['png', 'jpeg', 'webp', 'gif'] as const)[index % 4])))
  const history = [
    createUserMessage({ content: inputs.slice(0, 20) }),
    createAssistantMessage({ content: [{ type: 'tool_use', id: 'read_image', name: 'Read', input: { file_path: '/fixture.png' } }] }),
  ]
  const path = join(sandbox, 'old-session.jsonl')
  const fixture = history.map((message, index) => JSON.stringify({ ...message,
    parentUuid: index ? history[index - 1]!.uuid : null, sessionId: '10000000-0000-4000-8000-000000000001',
    timestamp: new Date(1700000000000 + index).toISOString(), isSidechain: false,
  })).join('\n') + '\n'
  await writeFile(path, fixture)
  const { loadMessagesFromJsonlPath } = await import('../../utils/conversationRecovery.js')
  const restored = await loadMessagesFromJsonlPath(path)
  expect(restored.messages).toHaveLength(2)
  const output = await send([...restored.messages as Message[], createUserMessage({ content: [
    { type: 'tool_result', tool_use_id: 'read_image', content: [inputs[20]!] },
  ] })])
  expect(output).toHaveLength(21)
  for (let index = 0; index < output.length; index++) await verifyPixels(output[index]!, index, 2000, 40)
  expect(await readFile(path, 'utf8')).toBe(fixture)
})

fixtureTest('real CLI resumes a persisted 20-image session and sends 21 compliant images', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const home = join(sandbox, 'cli')
  const project = join(home, 'project')
  await mkdir(project, { recursive: true })
  const inputs = await Promise.all(Array.from({ length: 21 }, (_, index) => image(index, 3000, 60)))
  const sessionId = '10000000-0000-4000-8000-000000000021'
  async function runCli(content: ImageBlockParam[], resume: boolean) {
    requests = []
    const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', join(root, 'preload.ts'),
      join(root, 'src/entrypoints/cli.tsx'), '--print', '--model', model,
      '--permission-mode', 'bypassPermissions', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose', resume ? '--resume' : '--session-id', sessionId,
    ], {
      cwd: project, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: createSandboxedTestEnvironment(home, {
        NODE_ENV: 'production', ANTHROPIC_API_KEY: 'offline-cli-fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CALLER_DIR: project,
        CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1', CC_HAHA_SKIP_DOTENV: '1',
      }),
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    try {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'text', text: 'Describe these fixture images.' }, ...content,
      ] }, session_id: sessionId, parent_tool_use_id: null }) + '\n')
      await child.stdin.flush()
      child.stdin.end()
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      const result = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(message => message.type === 'result')
      expect(result?.is_error, stdout + stderr).toBe(false)
      const sent = requests.flatMap(request => request.messages.flatMap(message => Array.isArray(message.content) ? imagesIn(message.content) : []))
      expect(sent).toHaveLength(resume ? 21 : 20)
      for (let index = 0; index < sent.length; index++) await verifyPixels(sent[index]!, index, resume ? 2000 : 3000, resume ? 40 : 60)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    }
  }
  await runCli(inputs.slice(0, 20), false)
  await runCli(inputs.slice(20), true)
  const projects = join(home, '.claude', 'projects')
  const histories = await Promise.all((await readdir(projects)).map(async directory => {
    const dir = join(projects, directory)
    return Promise.all((await readdir(dir)).filter(file => file.endsWith('.jsonl')).map(file => readFile(join(dir, file), 'utf8')))
  }))
  const history = histories.flat().join('\n')
  for (const input of inputs) expect(history).toContain((input.source as { data: string }).data)
}, 40_000)
