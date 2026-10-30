import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import sharp from 'sharp'

const tmpDir = path.join(os.tmpdir(), `tool-image-media-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = tmpDir

const media = await import('../services/toolImageMedia.js')
const { handleSessionsApi } = await import('../api/sessions.js')
const { sessionService } = await import('../services/sessionService.js')
const { conversationService } = await import('../services/conversationService.js')
const ws = await import('../ws/handler.js')

type Json = Record<string, any>

async function noisePng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256)
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/** A turn shaped like a phone asking for screenshots: three Read results with large PNGs. */
async function writeScreenshotTurn(sessionId: string, png: Buffer) {
  const data = png.toString('base64')
  const at = (n: number) => `2026-10-30T14:50:${String(n).padStart(2, '0')}.000Z`
  const entries: Json[] = [
    { type: 'user', uuid: 'prompt', timestamp: at(0), message: { role: 'user', content: '帮我截个图发过来' } },
  ]
  for (let i = 0; i < 3; i++) {
    entries.push({
      type: 'assistant', uuid: `use-${i}`, timestamp: at(1 + i * 3),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_shot_${i}`, name: 'Read', input: { file_path: `/tmp/shot-${i}.png` } }] },
    })
    entries.push({
      type: 'user', uuid: `result-${i}`, timestamp: at(2 + i * 3),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_shot_${i}`, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] },
      toolUseResult: { type: 'image', file: { base64: data, type: 'image/png', originalSize: png.length, dimensions: { originalWidth: 900, originalHeight: 600 } } },
    })
  }
  entries.push({ type: 'assistant', uuid: 'done', timestamp: at(20), message: { role: 'assistant', content: [{ type: 'text', text: '截图已附上' }] } })
  const dir = path.join(tmpDir, 'projects', '-tmp-shots')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
}

async function api(pathname: string) {
  const url = new URL(`http://127.0.0.1${pathname}`)
  return handleSessionsApi(new Request(url), url, url.pathname.split('/').filter(Boolean))
}

let png: Buffer

beforeAll(async () => {
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  png = await noisePng(900, 600)
})

afterEach(() => {
  mock.restore()
  media.resetToolImageCachesForTests()
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
})

describe('tool image references', () => {
  it('replaces tool-result image bytes with references and keeps text blocks', () => {
    const content = [
      { type: 'text', text: 'caption' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
    ]
    const projected = media.projectToolResultContent(content, 'session-1', 'parent/toolu_1') as Json[]
    expect(projected[0]).toBe(content[0])
    expect(projected[1]!.source).toEqual({
      type: 'ref',
      media_type: 'image/png',
      url: '/api/sessions/session-1/tool-images/parent%2Ftoolu_1/0',
      bytes: png.length,
      width: 900,
      height: 600,
    })
    expect(JSON.stringify(projected)).not.toContain(png.toString('base64').slice(0, 64))
    // Content without base64 images is returned as the same object.
    const text = [{ type: 'text', text: 'only text' }]
    expect(media.projectToolResultContent(text, 's', 't')).toBe(text)
  })

  it('reads dimensions from PNG, JPEG, GIF and WebP headers', async () => {
    const base = sharp({ create: { width: 37, height: 21, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    for (const format of ['png', 'jpeg', 'gif', 'webp'] as const) {
      const bytes = await base.clone().toFormat(format).toBuffer()
      expect(media.imageDimensions(bytes)).toEqual({ width: 37, height: 21 })
    }
    const lossless = await base.clone().webp({ lossless: true }).toBuffer()
    expect(media.imageDimensions(lossless)).toEqual({ width: 37, height: 21 })
    expect(media.imageDimensions(Buffer.from('not an image'))).toBeUndefined()
  })
})

describe('history with media=ref', () => {
  it('keeps the default page unchanged and moves image bytes out of the referenced page', async () => {
    const sessionId = 'a1b2c3d4-0000-4000-8000-000000000001'
    await writeScreenshotTurn(sessionId, png)
    const encoded = png.toString('base64')

    const plain = await (await api(`/api/sessions/${sessionId}/messages`)).json() as Json
    // Context-scan accounting depends on index warmth, not on the response contract.
    const comparable = (page: Json) => ({ ...page, page: { ...page.page, contextScanBytes: 0 } })
    expect(comparable(plain)).toEqual(comparable(JSON.parse(JSON.stringify(await sessionService.getSessionHistoryPage(sessionId)))))
    // Without references each screenshot owns a page, so the prompt is far away.
    expect(plain.messages.map((message: Json) => message.id)).toEqual(['done'])

    const response = await api(`/api/sessions/${sessionId}/messages?media=ref`)
    const text = await response.text()
    expect(text).not.toContain(encoded.slice(0, 64))
    expect(text.length).toBeLessThan(16 * 1024)
    const page = JSON.parse(text) as Json
    // Paged by projected size: the whole turn, prompt included, fits one page.
    expect(page.messages.map((message: Json) => message.id)).toEqual([
      'prompt', 'use-0', 'result-0', 'use-1', 'result-1', 'use-2', 'result-2', 'done',
    ])
    const result = page.messages.find((message: Json) => message.id === 'result-1')
    expect(result.content[0].content[0].source).toMatchObject({
      type: 'ref', media_type: 'image/png', url: `/api/sessions/${sessionId}/tool-images/toolu_shot_1/0`, width: 900, height: 600,
    })
    // The Read tool's duplicate copy is dropped; its metadata stays.
    expect(result.toolUseResult.file).toEqual({ type: 'image/png', originalSize: png.length, dimensions: { originalWidth: 900, originalHeight: 600 } })

    expect((await api(`/api/sessions/${sessionId}/messages?media=inline`)).status).toBe(400)
    expect((await api(`/api/sessions/${sessionId}/messages?media=ref&mode=full`)).status).toBe(400)
  })

  it('serves a referenced image as a thumbnail or as the original bytes', async () => {
    const sessionId = 'a1b2c3d4-0000-4000-8000-000000000002'
    await writeScreenshotTurn(sessionId, png)
    const base = `/api/sessions/${sessionId}/tool-images/toolu_shot_2/0`

    const thumb = await api(base)
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get('Content-Type')).toBe('image/webp')
    const thumbBytes = Buffer.from(await thumb.arrayBuffer())
    expect(thumbBytes.length).toBeLessThan(png.length)
    const meta = await sharp(thumbBytes).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(media.TOOL_IMAGE_THUMBNAIL_EDGE)

    const full = await api(`${base}?variant=full`)
    expect(full.headers.get('Content-Type')).toBe('image/png')
    expect(Buffer.from(await full.arrayBuffer()).equals(png)).toBe(true)

    expect((await api(`/api/sessions/${sessionId}/tool-images/toolu_missing/0`)).status).toBe(404)
    expect((await api(`/api/sessions/${sessionId}/tool-images/toolu_shot_2/1`)).status).toBe(404)
    expect((await api(`${base}?variant=huge`)).status).toBe(400)
    expect((await api(`/api/sessions/${sessionId}/tool-images/toolu_shot_2/x`)).status).toBe(400)
  })
})

function makeClientSocket(sessionId: string, mediaRefs: boolean) {
  const sent: string[] = []
  return {
    data: { sessionId, connectedAt: Date.now(), channel: 'client', clientKind: 'full', sdkToken: null, serverPort: 0, serverHost: '127.0.0.1', mediaRefs },
    send: mock((payload: string) => { sent.push(payload) }),
    close: mock(() => {}),
    sent,
  } as unknown as ServerWebSocket<import('../ws/handler.js').WebSocketData> & { sent: string[] }
}

describe('live tool results', () => {
  it('sends references only to media=ref clients and serves the image before the transcript has it', async () => {
    const sessionId = `live-images-${crypto.randomUUID()}`
    const callbacks = new Set<(cliMsg: any) => void>()
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => { callbacks.add(callback) })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_id, callback) => { callbacks.delete(callback) })
    const desktop = makeClientSocket(sessionId, false)
    const phone = makeClientSocket(sessionId, true)
    ws.handleWebSocket.open(desktop)
    ws.handleWebSocket.open(phone)
    desktop.sent.length = 0
    phone.sent.length = 0

    const data = png.toString('base64')
    for (const callback of [...callbacks]) {
      callback({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] },
      })
    }
    const toolResult = (socket: { sent: string[] }) => socket.sent.map(payload => JSON.parse(payload)).find(message => message.type === 'tool_result')
    expect(toolResult(desktop).content[0].source.data).toBe(data)
    const phoneFrame = phone.sent.find(payload => payload.includes('"tool_result"'))!
    expect(phoneFrame.length).toBeLessThan(2048)
    expect(toolResult(phone).content[0].source).toMatchObject({ type: 'ref', url: `/api/sessions/${sessionId}/tool-images/toolu_live/0`, width: 900, height: 600 })

    // No transcript exists for this session; the reference still resolves.
    const full = await media.loadRenderedToolImage(sessionId, 'toolu_live', 0, 'full', async () => null)
    expect(full?.bytes.equals(png)).toBe(true)

    ws.handleWebSocket.close(desktop, 1000, '')
    ws.handleWebSocket.close(phone, 1000, '')
  })
})
