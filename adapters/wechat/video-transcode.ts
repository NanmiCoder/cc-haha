import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { runVideoCommand, WECHAT_VIDEO_MAX_BYTES, WECHAT_VIDEO_MAX_DURATION_MS, type WechatVideoOptions } from './video-processing.js'

type Metadata = { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>; format?: { duration?: string } }
const formats = 'mov,matroska,webm,avi,mpegts,mpegvideo'
let activeTranscode = false
const probeFlags = ['-v', 'error', '-max_alloc', '134217728', '-protocol_whitelist', 'file,pipe',
  '-format_whitelist', formats, '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json']

function readMetadata(json: string): { data: Metadata; durationMs: number } {
  let data: Metadata
  try { data = JSON.parse(json) } catch { throw new Error('无法读取视频元数据。') }
  const video = data?.streams?.find(stream => stream.codec_type === 'video')
  const durationMs = Math.ceil(Number(data?.format?.duration) * 1000)
  if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height) ||
    video.width! < 1 || video.height! < 1 || video.width! * video.height! > 16_777_216 ||
    !Number.isFinite(durationMs) || durationMs <= 0) throw new Error('视频元数据无效或分辨率过大。')
  if (durationMs > WECHAT_VIDEO_MAX_DURATION_MS) throw new Error('转码上限为 120 秒，请先截取片段。')
  return { data, durationMs }
}

/** Receives an already authorized immutable snapshot, not a user-controlled path. */
export async function transcodeWechatVideo(buffer: Buffer, options: WechatVideoOptions = {}) {
  options.signal?.throwIfAborted()
  if (!buffer.length || buffer.length > WECHAT_VIDEO_MAX_BYTES) throw new Error('转码文件需在 30 MiB 以内。')
  if (activeTranscode) throw new Error('已有视频正在转码，请稍后重试。')
  activeTranscode = true
  const parent = path.resolve(options.outputDir ?? os.tmpdir())
  let directory: string
  try {
    await fs.mkdir(parent, { recursive: true })
    directory = await fs.mkdtemp(path.join(parent, 'cc-haha-wechat-transcode-'))
  } catch (error) { activeTranscode = false; throw error }
  const source = path.join(directory, 'input.media')
  const outputPath = path.join(directory, 'converted.mp4')
  const cleanup = async () => { await fs.rm(directory, { recursive: true, force: true }) }
  const run = options.run ?? runVideoCommand
  const ffprobe = options.ffprobePath || process.env.WECHAT_FFPROBE_PATH || 'ffprobe'
  const ffmpeg = options.ffmpegPath || process.env.WECHAT_FFMPEG_PATH || 'ffmpeg'
  const execute = async (tool: string, args: string[], timeoutMs: number) => {
    options.signal?.throwIfAborted()
    const result = await run(tool, args, { signal: options.signal, timeoutMs })
    options.signal?.throwIfAborted()
    return result
  }
  try {
    await fs.writeFile(source, buffer, { flag: 'wx' })
    const original = readMetadata(await execute(ffprobe, [...probeFlags, source], 15_000))
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '134217728',
      '-threads', '2', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats, '-i', source,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2',
      '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-threads', '2',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart',
      '-fs', String(WECHAT_VIDEO_MAX_BYTES), outputPath], 180_000)
    const stat = await fs.stat(outputPath)
    if (!stat.isFile() || stat.size === 0 || stat.size > WECHAT_VIDEO_MAX_BYTES) throw new Error('转码产物为空或超过 30 MiB。')
    const converted = readMetadata(await execute(ffprobe, [...probeFlags, outputPath], 15_000))
    if (Math.abs(converted.durationMs - original.durationMs) > 1000 ||
      converted.data.streams!.some(stream => stream.codec_type === 'video' && stream.codec_name !== 'h264') ||
      converted.data.streams!.some(stream => stream.codec_type === 'audio' && stream.codec_name !== 'aac') ||
      (original.data.streams!.some(stream => stream.codec_type === 'audio') && !converted.data.streams!.some(stream => stream.codec_type === 'audio'))) {
      throw new Error('转码未保留完整时长或音轨，未发送结果。')
    }
    return { path: outputPath, fileName: 'converted.mp4', cleanup }
  } catch (error) { await cleanup(); throw error }
  finally { activeTranscode = false }
}
