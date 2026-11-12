import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export const WECHAT_VIDEO_MAX_BYTES = 30 * 1024 * 1024
export const WECHAT_VIDEO_MAX_DURATION_MS = 120_000
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_AUDIO_BYTES = 4 * 1024 * 1024
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024
const FORMAT_WHITELIST = 'mov,matroska,webm,avi,mpegts,mpegvideo'
let activeVideoJob = false

export type VideoCommandOptions = { signal?: AbortSignal; timeoutMs: number }
export type VideoCommandRunner = (
  executable: string,
  args: string[],
  options: VideoCommandOptions,
) => Promise<string>

/** No shell, network protocols or unbounded child output are needed for local video processing. */
export const runVideoCommand: VideoCommandRunner = (executable, args, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) {
    reject(new Error('Video processing was cancelled.'))
    return
  }
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []
  let outputBytes = 0
  let failure: Error | undefined
  const stop = (reason: string) => {
    failure ??= new Error(reason)
    child.kill('SIGKILL')
  }
  const onAbort = () => stop('Video processing was cancelled.')
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => stop('Video processing timed out; please use a shorter video.'), options.timeoutMs)
  const consume = (chunk: Buffer, save: boolean) => {
    outputBytes += chunk.length
    if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) stop('Video tool output exceeded the limit.')
    else if (save) stdout.push(chunk)
  }
  child.stdout.on('data', chunk => consume(Buffer.from(chunk), true))
  child.stderr.on('data', chunk => consume(Buffer.from(chunk), false))
  const cleanup = () => {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
  }
  child.once('error', error => {
    cleanup()
    reject((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? new Error('Video analysis requires ffmpeg and ffprobe. Install them and add them to PATH, or configure WECHAT_FFMPEG_PATH / WECHAT_FFPROBE_PATH.')
      : new Error('Could not start the local video processing tool.'))
  })
  child.once('close', code => {
    cleanup()
    if (failure) reject(failure)
    else if (code !== 0) reject(new Error('The video tool could not process this file; make sure the video is complete and in a supported format.'))
    else resolve(Buffer.concat(stdout).toString('utf8'))
  })
  // Abort can race with listener installation.
  if (options.signal?.aborted) onAbort()
})

export type WechatVideoResult = {
  frames: Array<{ path: string; timestampMs: number }>
  audioPath?: string
  durationMs: number
  coverageNote: string
  cleanup: () => Promise<void>
}

export type WechatVideoOptions = {
  signal?: AbortSignal
  ffmpegPath?: string
  ffprobePath?: string
  /** Parent of a newly-created private job directory, never a directory to overwrite. */
  outputDir?: string
  run?: VideoCommandRunner
}

/** Download/authorization happen at the adapter boundary, before calling this service. */
export async function processWechatVideo(filePath: string, options: WechatVideoOptions = {}): Promise<WechatVideoResult> {
  if (options.signal?.aborted) throw new Error('Video processing was cancelled.')
  if (activeVideoJob) throw new Error('Another video is being analyzed; please try again later.')
  activeVideoJob = true
  let jobDir: string | undefined
  let stageRoot: string | undefined
  const cleanup = async () => {
    if (!jobDir || !stageRoot) return
    const relative = path.relative(stageRoot, jobDir)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid video staging directory')
    await fs.rm(jobDir, { recursive: true, force: true })
  }
  try {
    const source = await fs.realpath(filePath)
    const stat = await fs.stat(source)
    if (!stat.isFile() || stat.size === 0) throw new Error('Video file is empty or not a regular file.')
    if (stat.size > WECHAT_VIDEO_MAX_BYTES) throw new Error('Video is too large; please send a video under 30 MiB.')
    const run = options.run ?? runVideoCommand
    const ffprobe = options.ffprobePath || process.env.WECHAT_FFPROBE_PATH || 'ffprobe'
    const ffmpeg = options.ffmpegPath || process.env.WECHAT_FFMPEG_PATH || 'ffmpeg'
    stageRoot = path.resolve(options.outputDir ?? os.tmpdir())
    await fs.mkdir(stageRoot, { recursive: true })
    stageRoot = await fs.realpath(stageRoot)
    jobDir = await fs.mkdtemp(path.join(stageRoot, 'cc-haha-wechat-video-'))
    const execute = async (tool: string, args: string[], timeoutMs: number) => {
      if (options.signal?.aborted) throw new Error('Video processing was cancelled.')
      const output = await run(tool, args, { signal: options.signal, timeoutMs })
      if (options.signal?.aborted) throw new Error('Video processing was cancelled.')
      return output
    }
    const probe = await execute(ffprobe, [
      '-v', 'error', '-max_alloc', '134217728', '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', FORMAT_WHITELIST, '-show_entries',
      'format=duration:stream=codec_type,width,height,duration', '-of', 'json', source,
    ], 15_000)
    let metadata: { streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>; format?: { duration?: string } }
    try { metadata = JSON.parse(probe) } catch { throw new Error('Could not read video metadata.') }
    if (!metadata || typeof metadata !== 'object' || !Array.isArray(metadata.streams)) throw new Error('Could not read video metadata.')
    const video = metadata.streams.find(stream => stream?.codec_type === 'video')
    if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height)
      || video.width! <= 0 || video.height! <= 0 || video.width! * video.height! > 16_777_216) {
      throw new Error('No valid video frames found, or the video resolution exceeds the analysis limit.')
    }
    const durationMs = Math.ceil(Math.max(Number(metadata.format?.duration) || 0, Number(video.duration) || 0) * 1000)
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Could not determine the video duration.')
    if (durationMs > WECHAT_VIDEO_MAX_DURATION_MS) throw new Error('Video exceeds the 120-second analysis limit; trim the part you need analyzed and resend. The original video was not fully analyzed.')
    const frameCount = Math.min(12, Math.max(1, Math.ceil(durationMs / 10_000)))
    const frames: WechatVideoResult['frames'] = []
    const inputFlags = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '134217728',
      '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMAT_WHITELIST]
    for (let i = 0; i < frameCount; i++) {
      // Midpoints cover the whole timeline without seeking exactly to EOF.
      const timestampMs = Math.floor((i + 0.5) * durationMs / frameCount)
      const framePath = path.join(jobDir, `frame-${i}.jpg`)
      await execute(ffmpeg, [...inputFlags, '-ss', (timestampMs / 1000).toFixed(3), '-i', source,
        '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease",
        '-threads', '1', '-q:v', '3', '-fs', String(MAX_FRAME_BYTES), framePath], 15_000)
      const frame = await fs.readFile(framePath)
      if (frame.length === 0 || frame.length > MAX_FRAME_BYTES || frame[0] !== 0xff || frame[1] !== 0xd8
        || frame[frame.length - 2] !== 0xff || frame[frame.length - 1] !== 0xd9) {
        throw new Error('Video frame extraction failed or output exceeded the limit.')
      }
      frames.push({ path: framePath, timestampMs })
    }
    let audioPath: string | undefined
    if (metadata.streams.some(stream => stream?.codec_type === 'audio')) {
      const pcmPath = path.join(jobDir, 'audio.pcm')
      audioPath = path.join(jobDir, 'audio.wav')
      await execute(ffmpeg, [...inputFlags, '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-t', (durationMs / 1000).toFixed(3), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        '-threads', '1', '-f', 's16le', '-fs', String(MAX_AUDIO_BYTES), pcmPath], 30_000)
      const pcmStat = await fs.stat(pcmPath)
      if (!pcmStat.isFile() || pcmStat.size === 0 || pcmStat.size > 120 * 16000 * 2 || pcmStat.size % 2 !== 0) {
        throw new Error('Video audio extraction failed or output exceeded the limit.')
      }
      const pcm = await fs.readFile(pcmPath)
      // The desktop voice API accepts exactly a canonical 44-byte header.
      // ffmpeg's WAV muxer normally inserts a LIST/ISFT chunk, which that API
      // deliberately rejects, so wrap bounded raw PCM ourselves.
      const header = Buffer.alloc(44)
      header.write('RIFF', 0)
      header.writeUInt32LE(36 + pcm.length, 4)
      header.write('WAVEfmt ', 8)
      header.writeUInt32LE(16, 16)
      header.writeUInt16LE(1, 20)
      header.writeUInt16LE(1, 22)
      header.writeUInt32LE(16000, 24)
      header.writeUInt32LE(32000, 28)
      header.writeUInt16LE(2, 32)
      header.writeUInt16LE(16, 34)
      header.write('data', 36)
      header.writeUInt32LE(pcm.length, 40)
      await fs.writeFile(audioPath, Buffer.concat([header, pcm]))
      await fs.unlink(pcmPath)
    }
    return {
      frames, audioPath, durationMs, cleanup,
      coverageNote: `Video duration ${(durationMs / 1000).toFixed(1)} s; ${frameCount} frames sampled evenly (with timestamps), not watched frame by frame. ${audioPath ? 'Audio track extracted; speech content must be transcribed separately before it can be analyzed.' : 'No audio track detected.'}`,
    }
  } catch (error) {
    await cleanup()
    throw error
  } finally {
    activeVideoJob = false
  }
}
