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
    reject(new Error('视频处理已取消。'))
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
  const onAbort = () => stop('视频处理已取消。')
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => stop('视频处理超时，请使用更短的视频。'), options.timeoutMs)
  const consume = (chunk: Buffer, save: boolean) => {
    outputBytes += chunk.length
    if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) stop('视频工具输出超出限制。')
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
      ? new Error('视频分析需要 ffmpeg 和 ffprobe。请安装后加入 PATH，或配置 WECHAT_FFMPEG_PATH / WECHAT_FFPROBE_PATH。')
      : new Error('无法启动本地视频处理工具。'))
  })
  child.once('close', code => {
    cleanup()
    if (failure) reject(failure)
    else if (code !== 0) reject(new Error('视频工具无法处理此文件，请确认视频完整且格式受支持。'))
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
  if (options.signal?.aborted) throw new Error('视频处理已取消。')
  if (activeVideoJob) throw new Error('另一个视频正在分析，请稍后重试。')
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
    if (!stat.isFile() || stat.size === 0) throw new Error('视频文件为空或不是普通文件。')
    if (stat.size > WECHAT_VIDEO_MAX_BYTES) throw new Error('视频过大，请发送 30 MiB 以内的视频。')
    const run = options.run ?? runVideoCommand
    const ffprobe = options.ffprobePath || process.env.WECHAT_FFPROBE_PATH || 'ffprobe'
    const ffmpeg = options.ffmpegPath || process.env.WECHAT_FFMPEG_PATH || 'ffmpeg'
    stageRoot = path.resolve(options.outputDir ?? os.tmpdir())
    await fs.mkdir(stageRoot, { recursive: true })
    stageRoot = await fs.realpath(stageRoot)
    jobDir = await fs.mkdtemp(path.join(stageRoot, 'cc-haha-wechat-video-'))
    const execute = async (tool: string, args: string[], timeoutMs: number) => {
      if (options.signal?.aborted) throw new Error('视频处理已取消。')
      const output = await run(tool, args, { signal: options.signal, timeoutMs })
      if (options.signal?.aborted) throw new Error('视频处理已取消。')
      return output
    }
    const probe = await execute(ffprobe, [
      '-v', 'error', '-max_alloc', '134217728', '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', FORMAT_WHITELIST, '-show_entries',
      'format=duration:stream=codec_type,width,height,duration', '-of', 'json', source,
    ], 15_000)
    let metadata: { streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>; format?: { duration?: string } }
    try { metadata = JSON.parse(probe) } catch { throw new Error('无法读取视频元数据。') }
    if (!metadata || typeof metadata !== 'object' || !Array.isArray(metadata.streams)) throw new Error('无法读取视频元数据。')
    const video = metadata.streams.find(stream => stream?.codec_type === 'video')
    if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height)
      || video.width! <= 0 || video.height! <= 0 || video.width! * video.height! > 16_777_216) {
      throw new Error('未找到有效视频画面，或视频分辨率超出分析限制。')
    }
    const durationMs = Math.ceil(Math.max(Number(metadata.format?.duration) || 0, Number(video.duration) || 0) * 1000)
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('无法确定视频时长。')
    if (durationMs > WECHAT_VIDEO_MAX_DURATION_MS) throw new Error('视频超过 120 秒分析上限，请截取需要分析的片段后重发；原视频未被完整分析。')
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
        throw new Error('视频抽帧失败或输出超出限制。')
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
        throw new Error('视频音轨提取失败或输出超出限制。')
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
      coverageNote: `视频时长 ${(durationMs / 1000).toFixed(1)} 秒，均匀抽取 ${frameCount} 帧（附时间戳），未逐帧观看。${audioPath ? '已提取音轨，语音内容需另行转写后才能分析。' : '未检测到音轨。'}`,
    }
  } catch (error) {
    await cleanup()
    throw error
  } finally {
    activeVideoJob = false
  }
}
