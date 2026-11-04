import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WechatMediaActions } from '../media-actions.js'
import type { WechatOutboundMedia } from '../outbound-media.js'
import { WechatMediaPreferenceStore } from '../media-preferences.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-actions-'))
  roots.push(root)
  const file = path.join(root, 'report.txt')
  await fs.writeFile(file, 'report contents')
  const frame = path.join(root, 'frame.jpg')
  await fs.writeFile(frame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  const audio = path.join(root, 'reply.wav')
  await fs.writeFile(audio, 'audio fixture')
  const sent: WechatOutboundMedia[] = []
  const notices: string[] = []
  let allowed = true
  let sessionId = 'session-1'
  let cleanups = 0
  const deps = {
    session: () => ({ sessionId, workDir: root }),
    allowed: () => allowed,
    send: async (_chat: string, media: WechatOutboundMedia) => { sent.push(media) },
    notice: async (_chat: string, text: string) => { notices.push(text) },
    transcribe: async () => 'hello from the audio track',
    synthesize: async () => ({ path: audio, mimeType: 'audio/wav' as const, fileName: 'reply.wav', cleanup: async () => { cleanups++ } }),
    processVideo: async () => ({ frames: [{ path: frame, timestampMs: 500 }], audioPath: audio, durationMs: 1000, coverageNote: '采样 1 帧', cleanup: async () => { cleanups++ } }),
  }
  return { root, file, deps, sent, notices, revoke: () => { allowed = false }, switchSession: () => { sessionId = 'session-2' }, cleanups: () => cleanups }
}

describe('WeChat media conversation boundary', () => {
  it('uploads a streamed bracket file marker once after completion', async () => {
    const f = await fixture()
    const audioPath = path.join(f.root, 'extracted audio.mp3')
    await fs.writeFile(audioPath, 'ID3fixture audio')
    const actions = new WechatMediaActions(f.deps)
    actions.append('chat', '[fi')
    actions.append('chat', `le:${audioPath}]`)
    expect(f.sent).toHaveLength(0)
    await actions.finish('chat')
    await actions.finish('chat')
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].fileName).toBe('extracted audio.mp3')
    expect(f.sent[0].buffer.toString()).toBe('ID3fixture audio')
    expect(f.notices).toEqual([])
  })
  it('persists voice selection and opt-in across restarts while not silently choosing invalid numbers', async () => {
    const f = await fixture()
    const preferences = new WechatMediaPreferenceStore(path.join(f.root, 'preferences.json'), 'binding-1')
    let selected: string | undefined
    const deps = { ...f.deps, preferences,
      listVoices: async () => [{ id: 'voice-a', name: 'Voice A', language: 'zh-CN' }],
      synthesize: async (_text: string, options?: { voiceId?: string }) => { selected = options?.voiceId; return f.deps.synthesize() },
    }
    const actions = new WechatMediaActions(deps)
    await actions.command('chat', '/voice select 1')
    expect(preferences.get('chat')).toEqual({ enabled: false })
    await actions.command('chat', '/voice list')
    await actions.command('chat', '/voice select 1')
    await actions.command('chat', '/voice on')
    actions.dispose()
    const restarted = new WechatMediaActions(deps)
    restarted.append('chat', 'hello')
    await restarted.finish('chat')
    expect(selected).toBe('voice-a')
    expect(f.sent).toHaveLength(1)
    await restarted.command('chat', '/voice select auto')
    expect(preferences.get('chat').voiceId).toBeUndefined()
    await restarted.command('chat', '/voice off')
    expect(preferences.get('chat').enabled).toBe(false)
  })

  it('transcodes only an authorized snapshot and cleans the result after sending', async () => {
    const f = await fixture()
    const mp4 = path.join(f.root, 'converted.mp4')
    const content = Buffer.alloc(24)
    content.write('ftypisom', 4)
    await fs.writeFile(mp4, content)
    let cleanup = false
    const actions = new WechatMediaActions({ ...f.deps, transcode: async snapshot => {
      expect(snapshot.toString()).toBe('report contents')
      return { path: mp4, fileName: 'converted.mp4', cleanup: async () => { cleanup = true } }
    } })
    await actions.command('chat', '/transcode report.txt')
    expect(f.sent[0].kind).toBe('video')
    expect(cleanup).toBe(true)
    f.revoke()
    await expect(actions.command('chat', '/transcode report.txt')).rejects.toThrow('配对')
  })
  it('sends explicit project files and completed deliverables without uploading source citations', async () => {
    const f = await fixture()
    const actions = new WechatMediaActions(f.deps)
    expect(await actions.command('chat', '/send report.txt')).toBe(true)
    actions.append('chat', '[source](/project/code.ts) [report](')
    actions.append('chat', `${pathToFileURL(f.file).href})`)
    await actions.finish('chat')
    await actions.finish('chat')
    expect(f.sent.map(item => item.buffer.toString())).toEqual(['report contents', 'report contents'])
  })
  it('synthesizes only completed text after opt-in and cleans generated files', async () => {
    const f = await fixture()
    const actions = new WechatMediaActions(f.deps)
    actions.append('chat', 'text only')
    await actions.finish('chat')
    expect(f.sent).toHaveLength(0)
    await actions.command('chat', '/voice on')
    actions.append('chat', 'answer')
    expect(f.sent).toHaveLength(0)
    await actions.finish('chat')
    expect(f.sent[0].mimeType).toBe('audio/wav')
    expect(f.sent[0].kind).toBe('file')
    expect(f.cleanups()).toBe(1)
    actions.reset('chat')
    actions.append('chat', 'new session text')
    await actions.finish('chat')
    expect(f.sent).toHaveLength(1)
  })
  it('does not deliver speech after cancellation or a session switch', async () => {
    for (const cancel of [true, false]) {
      const f = await fixture()
      let release!: () => void
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const original = f.deps.synthesize
      const actions = new WechatMediaActions({ ...f.deps, synthesize: async () => { entered(); await new Promise<void>(resolve => { release = resolve }); return original() } })
      const pending = actions.command('chat', '/speak test').catch(() => false)
      await started
      if (cancel) actions.cancel('chat')
      else f.switchSession()
      release()
      await pending
      expect(f.sent).toHaveLength(0)
      expect(f.cleanups()).toBe(1)
    }
  })
  it('rejects unauthorized file sends and out-of-project paths', async () => {
    const f = await fixture()
    const actions = new WechatMediaActions(f.deps)
    await expect(actions.command('chat', '/send ../not-a-project-file')).rejects.toThrow()
    f.revoke()
    await expect(actions.command('chat', '/send report.txt')).rejects.toThrow('配对')
    expect(f.sent).toHaveLength(0)
  })
  it('reports uncertain upload failure once and never regenerates or retries it', async () => {
    const f = await fixture()
    let attempts = 0
    const actions = new WechatMediaActions({ ...f.deps, send: async () => { attempts++; throw new Error('timeout, delivery unknown') } })
    actions.append('chat', `[report](${pathToFileURL(f.file).href})`)
    await actions.finish('chat')
    await actions.finish('chat')
    expect(attempts).toBe(1)
    expect(f.notices.join(' ')).toContain('不会自动重发')
  })
  it('prepares sampled images and actual audio transcript, cleaning intermediate files', async () => {
    const f = await fixture()
    const actions = new WechatMediaActions(f.deps)
    const result = await actions.analyzeVideo('chat', 'video.mp4')
    expect(result.attachments[0]).toMatchObject({ type: 'image', name: 'video-500ms.jpg', mimeType: 'image/jpeg' })
    expect(result.context).toContain('0.50s')
    expect(result.context).toContain('hello from the audio track')
    expect(result.context).toContain('采样限制')
    expect(result.context).toContain('video.mp4')
    expect(result.context).toContain('ffmpeg')
    expect(result.context).toContain('file:')
    expect(f.cleanups()).toBe(1)
  })
  it('keeps visual analysis usable and labels an unavailable recognizer', async () => {
    const f = await fixture()
    const actions = new WechatMediaActions({ ...f.deps, transcribe: async () => { throw new Error('not ready') } })
    const result = await actions.analyzeVideo('chat', 'video.mp4')
    expect(result.attachments).toHaveLength(1)
    expect(result.context).toContain('仅分析采样画面')
    expect(result.context).toContain('not ready')
  })
  it('exposes configured portable tools to the model even when they are outside PATH', async () => {
    const f = await fixture()
    const originalFfmpeg = process.env.WECHAT_FFMPEG_PATH
    const originalFfprobe = process.env.WECHAT_FFPROBE_PATH
    const ffmpeg = path.join(f.root, 'portable tools', 'ffmpeg.exe')
    const ffprobe = path.join(f.root, 'portable tools', 'ffprobe.exe')
    process.env.WECHAT_FFMPEG_PATH = ffmpeg
    process.env.WECHAT_FFPROBE_PATH = ffprobe
    try {
      const result = await new WechatMediaActions(f.deps).analyzeVideo('chat', 'uploaded.mp4')
      expect(result.context).toContain(JSON.stringify(ffmpeg))
      expect(result.context).toContain(JSON.stringify(ffprobe))
      expect(result.context).toContain('uploaded.mp4')
      expect(result.context).toContain('临时处理文件会清理')
    } finally {
      if (originalFfmpeg === undefined) delete process.env.WECHAT_FFMPEG_PATH
      else process.env.WECHAT_FFMPEG_PATH = originalFfmpeg
      if (originalFfprobe === undefined) delete process.env.WECHAT_FFPROBE_PATH
      else process.env.WECHAT_FFPROBE_PATH = originalFfprobe
    }
  })
})
