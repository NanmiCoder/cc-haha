import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AttachmentRef } from '../common/ws-bridge.js'
import { extractWechatDeliverables, loadWechatOutboundMedia, type WechatOutboundMedia } from './outbound-media.js'
import { processWechatVideo } from './video-processing.js'
import { listWechatSpeechVoices, synthesizeWechatSpeech, type WechatSpeechVoice } from './speech-synthesis.js'
import { transcodeWechatVideo } from './video-transcode.js'
import type { WechatMediaPreference, WechatMediaPreferences } from './media-preferences.js'

export const WECHAT_MEDIA_HELP = '\n\n媒体命令：\n/send <项目内路径> — 回传图片、视频或文件（文件 30 MiB，图片 10 MiB）\n/transcode <项目内视频路径> — 转为兼容 MP4 后回传（120 秒以内）\n/voice on|off — 开关后续答案的音频文件回复\n/voice list — 列出系统音色\n/voice select <编号|auto> — 选择音色或恢复自动\n/speak <文字> — 合成为音频文件（Windows，最多 2000 字）\n/stop — 取消媒体任务和当前生成\n助手回复中的本地图片及 file: 下载链接会自动回传，普通代码引用不会。视频分析和转码需要 ffmpeg/ffprobe；音轨转写使用桌面语音识别配置。'

type Binding = { sessionId: string; workDir: string }
type Dependencies = {
  session: (chatId: string) => Binding | null
  allowed: (chatId: string) => boolean
  send: (chatId: string, media: WechatOutboundMedia, signal: AbortSignal, current: () => boolean) => Promise<void>
  notice: (chatId: string, text: string) => Promise<void>
  transcribe: (audio: Buffer, signal: AbortSignal) => Promise<string>
  processVideo?: typeof processWechatVideo
  synthesize?: typeof synthesizeWechatSpeech
  listVoices?: typeof listWechatSpeechVoices
  transcode?: typeof transcodeWechatVideo
  preferences?: WechatMediaPreferences
}

/** One cancellable media operation per chat. Session identity is checked again
 * before delivery, so a completed job cannot leak into a replacement session. */
export class WechatMediaActions {
  private readonly jobs = new Map<string, AbortController>()
  private readonly answers = new Map<string, string>()
  private readonly voice = new Set<string>()
  private readonly selectedVoices = new Map<string, string>()
  private readonly voiceLists = new Map<string, WechatSpeechVoice[]>()

  constructor(private readonly deps: Dependencies) {}

  append(chatId: string, text: string): void {
    this.answers.set(chatId, ((this.answers.get(chatId) ?? '') + text).slice(0, 128 * 1024))
  }

  cancel(chatId: string): void {
    this.jobs.get(chatId)?.abort()
    this.answers.delete(chatId)
  }

  reset(chatId: string): void {
    this.cancel(chatId)
    this.voice.delete(chatId)
    this.selectedVoices.delete(chatId)
    this.voiceLists.delete(chatId)
  }

  dispose(): void {
    for (const controller of this.jobs.values()) controller.abort()
    this.answers.clear()
    this.voice.clear()
    this.selectedVoices.clear()
    this.voiceLists.clear()
  }

  private preference(chatId: string): WechatMediaPreference {
    return this.deps.preferences?.get(chatId) ?? { enabled: this.voice.has(chatId), voiceId: this.selectedVoices.get(chatId) }
  }

  private savePreference(chatId: string, preference: WechatMediaPreference): void {
    if (this.deps.preferences) this.deps.preferences.set(chatId, preference)
    else {
      if (preference.enabled) this.voice.add(chatId)
      else this.voice.delete(chatId)
      if (preference.voiceId) this.selectedVoices.set(chatId, preference.voiceId)
      else this.selectedVoices.delete(chatId)
    }
  }

  private async run<T>(chatId: string, operation: (signal: AbortSignal, current: () => boolean, binding: Binding) => Promise<T>): Promise<T> {
    const binding = this.deps.session(chatId)
    if (!binding || !this.deps.allowed(chatId)) throw new Error('请先配对并选择项目会话')
    if (this.jobs.has(chatId)) throw new Error('已有媒体任务正在处理，请等待或发送 /stop')
    const controller = new AbortController()
    this.jobs.set(chatId, controller)
    const current = () => !controller.signal.aborted && this.deps.allowed(chatId) && this.deps.session(chatId)?.sessionId === binding.sessionId
    try {
      return await operation(controller.signal, current, binding)
    } finally {
      if (this.jobs.get(chatId) === controller) this.jobs.delete(chatId)
    }
  }

  async command(chatId: string, text: string): Promise<boolean> {
    if (!this.deps.allowed(chatId)) throw new Error('请先配对并选择项目会话')
    if (/^\/voice(?:\s|$)/.test(text)) {
      const mode = text.slice(6).trim()
      if (mode === 'list') {
        await this.run(chatId, async (signal, current) => {
          const voices = await (this.deps.listVoices ?? listWechatSpeechVoices)({ signal })
          if (!current()) return
          this.voiceLists.set(chatId, voices)
          await this.deps.notice(chatId, voices.length ? `可用音色：\n${voices.map((voice, index) => `${index + 1}. ${voice.name} (${voice.language})`).join('\n')}\n发送 /voice select 编号 选择，或 /voice select auto 恢复自动。` : '未安装可用的 Windows 系统音色。')
        })
        return true
      }
      if (mode.startsWith('select ')) {
        const value = mode.slice(7).trim()
        const selected = /^\d+$/.test(value) ? this.voiceLists.get(chatId)?.[Number(value) - 1] : undefined
        if (value !== 'auto' && !selected) { await this.deps.notice(chatId, '请先发送 /voice list，再选择列表中的音色编号。'); return true }
        this.savePreference(chatId, { ...this.preference(chatId), voiceId: selected?.id })
        await this.deps.notice(chatId, selected ? `音色已设为 ${selected.name}。` : '已恢复自动选择音色。')
        return true
      }
      if (mode === 'on' || mode === 'off') {
        this.savePreference(chatId, { ...this.preference(chatId), enabled: mode === 'on' })
        if (mode === 'off') this.cancel(chatId)
      } else { await this.deps.notice(chatId, '用法：/voice on|off、/voice list、/voice select <编号|auto>（音频文件回复，非原生语音气泡）'); return true }
      await this.deps.notice(chatId, mode === 'on' ? `已开启音频文件回复；需要 Windows 可用语音引擎。${this.deps.preferences ? '偏好已保存，重启后继续生效。' : '本次运行有效，清空或切换会话后需重新开启。'}` : '已关闭音频文件回复。')
      return true
    }
    const match = /^\/(send|speak|transcode)(?:\s+([\s\S]+))?$/.exec(text)
    if (!match) return false
    if (!match[2]?.trim()) { await this.deps.notice(chatId, `用法：/${match[1]} ${match[1] === 'speak' ? '<要朗读的文字>' : '<项目内文件路径>'}`); return true }
    await this.run(chatId, async (signal, current, binding) => {
      if (match[1] === 'speak') await this.speak(chatId, match[2]!, signal, current)
      else {
        const media = await loadWechatOutboundMedia(match[2]!, binding.workDir, signal)
        if (match[1] === 'transcode') {
          const converted = await (this.deps.transcode ?? transcodeWechatVideo)(media.buffer, { signal })
          try {
            if (current()) {
              const output = await loadWechatOutboundMedia(converted.path, path.dirname(converted.path), signal)
              if (current()) await this.deps.send(chatId, { ...output, fileName: converted.fileName }, signal, current)
            }
          } finally { await converted.cleanup() }
        } else if (current()) await this.deps.send(chatId, media, signal, current)
      }
    })
    return true
  }

  async finish(chatId: string): Promise<void> {
    const answer = this.answers.get(chatId) ?? ''
    this.answers.delete(chatId)
    const files = extractWechatDeliverables(answer)
    if (!files.length && !this.preference(chatId).enabled) return
    await this.run(chatId, async (signal, current, binding) => {
      let totalBytes = 0
      for (const file of files) {
        signal.throwIfAborted()
        if (!current()) return
        try {
          const media = await loadWechatOutboundMedia(file, binding.workDir, signal)
          totalBytes += media.buffer.length
          if (totalBytes > 30 * 1024 * 1024) throw new Error('本轮回传总量超过 30 MiB，请用 /send 分别获取')
          if (current()) await this.deps.send(chatId, media, signal, current)
        } catch (error) {
          if (signal.aborted) throw error
          if (current()) await this.deps.notice(chatId, `附件未完成发送（不会自动重发）：${error instanceof Error ? error.message : '未知错误'}。可在桌面核对结果后使用 /send。`)
        }
      }
      if (this.preference(chatId).enabled && current() && answer.trim()) await this.speak(chatId, answer, signal, current)
    })
  }

  private async speak(chatId: string, text: string, signal: AbortSignal, current: () => boolean): Promise<void> {
    const result = await (this.deps.synthesize ?? synthesizeWechatSpeech)(text, { signal, voiceId: this.preference(chatId).voiceId })
    try {
      // The only extra root accepted here is a freshly created, trusted TTS job.
      const media = await loadWechatOutboundMedia(result.path, path.dirname(result.path), signal)
      if (media.buffer.length > 10 * 1024 * 1024) throw new Error('合成音频超过 10 MiB')
      if (current()) await this.deps.send(chatId, { ...media, kind: 'file', mimeType: result.mimeType, fileName: result.fileName }, signal, current)
    } finally {
      await result.cleanup()
    }
  }

  async analyzeVideo(chatId: string, filePath: string): Promise<{ attachments: AttachmentRef[]; context: string }> {
    return this.run(chatId, async (signal, current) => {
      const result = await (this.deps.processVideo ?? processWechatVideo)(filePath, { signal,
        ffmpegPath: process.env.WECHAT_FFMPEG_PATH, ffprobePath: process.env.WECHAT_FFPROBE_PATH })
      try {
        const attachments: AttachmentRef[] = []
        for (const frame of result.frames) {
          signal.throwIfAborted()
          if (!current()) throw new Error('媒体任务已取消或会话已变更')
          const image = await loadWechatOutboundMedia(frame.path, path.dirname(frame.path), signal)
          attachments.push({ type: 'image', name: `video-${frame.timestampMs}ms.jpg`, data: image.buffer.toString('base64'), mimeType: 'image/jpeg' })
        }
        let context = `微信上传的原始视频已保存在本机：${JSON.stringify(filePath)}。用户随后说“这个视频”时应使用该附件，不要用仓库内的示例视频代替。\n`
          + `本次视频处理使用的工具：ffmpeg=${JSON.stringify(process.env.WECHAT_FFMPEG_PATH || 'ffmpeg')}，ffprobe=${JSON.stringify(process.env.WECHAT_FFPROBE_PATH || 'ffprobe')}。配置的绝对路径可能不在终端 PATH 中。\n`
          + '音轨和采样图的临时处理文件会清理；需要提取音频文件时，请从原视频生成到当前项目目录，并用 [下载音频](file:///绝对路径) 返回产物以触发微信回传。只输出普通电脑路径不会上传附件；路径含空格等字符时应使用正确编码的 file: URL。\n'
          + `${result.coverageNote}\n画面采样时间：${result.frames.map(frame => `${(frame.timestampMs / 1000).toFixed(2)}s`).join(', ')}。请说明采样限制，不要声称逐帧看过整段视频。`
        if (result.audioPath) {
          try {
            const wav = await fs.readFile(result.audioPath)
            signal.throwIfAborted()
            const text = await this.deps.transcribe(wav, signal)
            context += text.trim() ? `\n音轨转写（整段识别，无逐词时间戳）：\n${text.slice(0, 16000)}` : '\n音轨未识别到文字。'
          } catch (error) {
            if (signal.aborted) throw error
            context += `\n音轨未能转写，仅分析采样画面：${error instanceof Error ? error.message : '识别不可用'}`
          }
        } else context += '\n视频没有音轨。'
        if (!current()) throw new Error('媒体任务已取消或会话已变更')
        return { attachments, context }
      } finally {
        await result.cleanup()
      }
    })
  }
}
