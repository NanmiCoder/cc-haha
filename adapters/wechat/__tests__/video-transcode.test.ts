import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { transcodeWechatVideo } from '../video-transcode.js'
import { runVideoCommand, type VideoCommandRunner } from '../video-processing.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function root() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-transcode-test-')); roots.push(dir); return dir }
const meta = (duration = '2', codec = 'h264') => JSON.stringify({ format: { duration }, streams: [
  { codec_type: 'video', codec_name: codec, width: 640, height: 480 }, { codec_type: 'audio', codec_name: 'aac' },
] })

test('transcodes a snapshot with bounded local protocols and validates resulting codecs and duration', async () => {
  const outputDir = await root()
  let calls = 0
  const run: VideoCommandRunner = async (_tool, args, options) => {
    calls++
    expect(args).toContain('file,pipe')
    expect(options.timeoutMs).toBeLessThanOrEqual(180_000)
    if (args.includes('-show_entries')) return meta()
    expect(args).toContain('libx264')
    expect(args).toContain('+faststart')
    expect(args).toContain('-fs')
    expect(await fs.readFile(args[args.indexOf('-i') + 1], 'utf8')).toBe('input snapshot')
    await fs.writeFile(args.at(-1)!, 'converted fixture')
    return ''
  }
  const result = await transcodeWechatVideo(Buffer.from('input snapshot'), { outputDir, run })
  expect(calls).toBe(3)
  expect(result.fileName).toBe('converted.mp4')
  await result.cleanup()
  expect(await fs.readdir(outputDir)).toEqual([])
})

test('rejects oversize or truncated conversion without leaving staging files', async () => {
  const outputDir = await root()
  let probes = 0
  await expect(transcodeWechatVideo(Buffer.from('input'), { outputDir, run: async (_tool, args) => {
    if (args.includes('-show_entries')) return meta(++probes === 1 ? '10' : '2')
    await fs.writeFile(args.at(-1)!, 'truncated')
    return ''
  } })).rejects.toThrow('完整时长')
  expect(await fs.readdir(outputDir)).toEqual([])
})

test('rejects overlong input before conversion and propagates cancellation', async () => {
  const outputDir = await root()
  await expect(transcodeWechatVideo(Buffer.from('input'), { outputDir, run: async () => meta('121') })).rejects.toThrow('120 秒')
  const controller = new AbortController()
  await expect(transcodeWechatVideo(Buffer.from('input'), { outputDir, signal: controller.signal, run: async () => { controller.abort(); return meta() } })).rejects.toThrow()
  expect(await fs.readdir(outputDir)).toEqual([])
})

const ffmpeg = process.env.WECHAT_TEST_FFMPEG_PATH || Bun.which('ffmpeg')
const ffprobe = process.env.WECHAT_TEST_FFPROBE_PATH || Bun.which('ffprobe')
test.skipIf(!ffmpeg || !ffprobe)('converts a real MPEG4 fixture to playable H264/AAC without network or models', async () => {
  const outputDir = await root()
  const input = path.join(outputDir, 'source.avi')
  await runVideoCommand(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', input], { timeoutMs: 15_000 })
  const result = await transcodeWechatVideo(await fs.readFile(input), { outputDir, ffmpegPath: ffmpeg!, ffprobePath: ffprobe! })
  try {
    const metadata = JSON.parse(await runVideoCommand(ffprobe!, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', result.path], { timeoutMs: 15_000 }))
    expect(metadata.streams.map((stream: { codec_name: string }) => stream.codec_name)).toEqual(['h264', 'aac'])
    await runVideoCommand(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-i', result.path, '-f', 'null', '-'], { timeoutMs: 15_000 })
  } finally { await result.cleanup() }
}, 30_000)
