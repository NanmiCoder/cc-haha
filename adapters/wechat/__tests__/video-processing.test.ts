import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { processWechatVideo, runVideoCommand, WECHAT_VIDEO_MAX_BYTES, type VideoCommandRunner } from '../video-processing.js'
import { validateVoiceWav } from '../../../src/server/services/voice/wav.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture cleanup path')
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-video-test-'))
  roots.push(root)
  const source = path.join(root, 'input with spaces.mp4')
  await fs.writeFile(source, Buffer.from('fake video fixture'))
  return { root, source }
}

function fakeRunner(options: { duration?: number; audio?: boolean; corruptFrame?: boolean } = {}) {
  const calls: Array<{ executable: string; args: string[] }> = []
  const run: VideoCommandRunner = async (executable, args) => {
    calls.push({ executable, args })
    if (args.includes('-show_entries')) {
      return JSON.stringify({
        format: { duration: String(options.duration ?? 25) },
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }, ...(options.audio ? [{ codec_type: 'audio' }] : [])],
      })
    }
    const target = args.at(-1)!
    if (target.endsWith('.jpg')) await fs.writeFile(target, options.corruptFrame ? 'broken' : Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    else {
      await fs.writeFile(target, Buffer.alloc(320))
    }
    return ''
  }
  return { calls, run }
}

describe('WeChat bounded video processing', () => {
  it('extracts timestamped frames and a separate mono audio track, then cleans only its stage', async () => {
    const { root, source } = await fixture()
    const fake = fakeRunner({ audio: true })
    const result = await processWechatVideo(source, { outputDir: root, run: fake.run })
    expect(result.durationMs).toBe(25_000)
    expect(result.frames.map(frame => frame.timestampMs)).toEqual([4166, 12500, 20833])
    expect(result.audioPath).toEndWith('audio.wav')
    expect(validateVoiceWav(await fs.readFile(result.audioPath!))).toEqual({ audioSeconds: 0.01 })
    expect(result.coverageNote).toContain('未逐帧观看')
    expect(result.coverageNote).toContain('需另行转写')
    expect(fake.calls.every(call => call.args.includes('file,pipe'))).toBe(true)
    const audio = fake.calls.at(-1)!.args
    expect(audio).toContain('16000')
    expect(audio).toContain('pcm_s16le')
    expect(audio[audio.indexOf('-i') + 1]).toBe(await fs.realpath(source))
    await result.cleanup()
    expect(await fs.readdir(root)).toEqual([path.basename(source)])
  })

  it('caps sampling at 12 frames and does not invent an audio track', async () => {
    const { root, source } = await fixture()
    const result = await processWechatVideo(source, { outputDir: root, run: fakeRunner({ duration: 120 }).run })
    expect(result.frames.length).toBe(12)
    expect(result.frames[11]!.timestampMs).toBe(115000)
    expect(result.audioPath).toBeUndefined()
    await result.cleanup()
  })

  it('rejects oversized input before launching tools', async () => {
    const { root, source } = await fixture()
    await fs.truncate(source, WECHAT_VIDEO_MAX_BYTES + 1)
    const fake = fakeRunner()
    await expect(processWechatVideo(source, { outputDir: root, run: fake.run })).rejects.toThrow('30 MiB')
    expect(fake.calls).toHaveLength(0)
  })

  it('rejects long videos explicitly and cleans partial staging', async () => {
    const { root, source } = await fixture()
    const fake = fakeRunner({ duration: 121 })
    await expect(processWechatVideo(source, { outputDir: root, run: fake.run })).rejects.toThrow('未被完整分析')
    expect(fake.calls).toHaveLength(1)
    expect(await fs.readdir(root)).toEqual([path.basename(source)])
  })

  it('rejects malformed metadata and incomplete frame output', async () => {
    const { root, source } = await fixture()
    await expect(processWechatVideo(source, { outputDir: root, run: async () => 'null' })).rejects.toThrow('元数据')
    await expect(processWechatVideo(source, { outputDir: root, run: fakeRunner({ corruptFrame: true }).run })).rejects.toThrow('抽帧')
    expect(await fs.readdir(root)).toEqual([path.basename(source)])
  })

  it('cancels between processing steps without leaving files or invoking more tools', async () => {
    const { root, source } = await fixture()
    const controller = new AbortController()
    const fake = fakeRunner()
    const run: VideoCommandRunner = async (...args) => {
      const output = await fake.run(...args)
      controller.abort()
      return output
    }
    await expect(processWechatVideo(source, { outputDir: root, signal: controller.signal, run })).rejects.toThrow('取消')
    expect(fake.calls).toHaveLength(1)
    expect(await fs.readdir(root)).toEqual([path.basename(source)])
  })

  it('rejects concurrent processing and releases the job slot after failure', async () => {
    const { root, source } = await fixture()
    let unblock!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const first = processWechatVideo(source, { outputDir: root, run: async () => {
      started()
      await new Promise<void>(resolve => { unblock = resolve })
      throw new Error('fixture failure')
    } })
    await ready
    await expect(processWechatVideo(source, { outputDir: root })).rejects.toThrow('另一个视频')
    unblock()
    await expect(first).rejects.toThrow('fixture failure')
    const result = await processWechatVideo(source, { outputDir: root, run: fakeRunner().run })
    await result.cleanup()
  })
})

describe('Video process runner', () => {
  it('reports missing dependencies with install guidance', async () => {
    await expect(runVideoCommand('cc-haha-nonexistent-ffprobe-fixture', [], { timeoutMs: 1000 })).rejects.toThrow('WECHAT_FFPROBE_PATH')
  })

  it('terminates timed-out processes', async () => {
    await expect(runVideoCommand(process.execPath, ['--no-env-file', '-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 })).rejects.toThrow('超时')
  })

  it('terminates a child on cancellation', async () => {
    const controller = new AbortController()
    const job = runVideoCommand(process.execPath, ['--no-env-file', '-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 5000, signal: controller.signal })
    controller.abort()
    await expect(job).rejects.toThrow('取消')
  })

  it('bounds stdout and stderr instead of buffering untrusted tool output', async () => {
    await expect(runVideoCommand(process.execPath, ['--no-env-file', '-e', 'console.log("x".repeat(70000))'], { timeoutMs: 5000 })).rejects.toThrow('输出超出限制')
  })
})

const localFfmpeg = process.env.WECHAT_TEST_FFMPEG_PATH || Bun.which('ffmpeg')
const localFfprobe = process.env.WECHAT_TEST_FFPROBE_PATH || Bun.which('ffprobe')
it.skipIf(!localFfmpeg || !localFfprobe)('processes a real locally generated video fixture without network or models', async () => {
  const { root, source } = await fixture()
  await runVideoCommand(localFfmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'color=c=red:s=160x120:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-t', '1',
    '-c:v', 'mpeg4', '-c:a', 'aac', source], { timeoutMs: 15000 })
  const result = await processWechatVideo(source, { outputDir: root, ffmpegPath: localFfmpeg!, ffprobePath: localFfprobe! })
  expect(result.frames).toHaveLength(1)
  expect((await fs.stat(result.frames[0]!.path)).size).toBeGreaterThan(100)
  expect((await fs.stat(result.audioPath!)).size).toBeGreaterThan(100)
  expect(validateVoiceWav(await fs.readFile(result.audioPath!)).audioSeconds).toBeGreaterThan(0.9)
  await result.cleanup()
}, 30000)

// This covers real decoding, scaling, extraction and the server's WAV contract
// on machines that have an ffmpeg binary bundled with another application but
// no ffprobe. Only metadata for this known one-second generated fixture is fake;
// the full probe-to-extraction smoke above stays skipped without ffprobe.
it.skipIf(!localFfmpeg)('extracts real frames and canonical audio using ffmpeg with known fixture metadata', async () => {
  const { root, source } = await fixture()
  await runVideoCommand(localFfmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'color=c=red:s=160x120:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-t', '1',
    '-c:v', 'mpeg4', '-c:a', 'aac', source], { timeoutMs: 15000 })
  const run: VideoCommandRunner = (executable, args, options) => args.includes('-show_entries')
    ? Promise.resolve(JSON.stringify({ format: { duration: '1' }, streams: [
      { codec_type: 'video', width: 160, height: 120 }, { codec_type: 'audio' },
    ] })) : runVideoCommand(executable, args, options)
  const result = await processWechatVideo(source, { outputDir: root, ffmpegPath: localFfmpeg!, run })
  try {
    expect(result.frames).toHaveLength(1)
    expect((await fs.stat(result.frames[0]!.path)).size).toBeGreaterThan(100)
    expect(validateVoiceWav(await fs.readFile(result.audioPath!)).audioSeconds).toBeGreaterThan(0.9)
  } finally { await result.cleanup() }
}, 30000)
