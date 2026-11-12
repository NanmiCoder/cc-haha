import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AttachmentRef } from '../common/ws-bridge.js'
import { extractWechatDeliverables, loadWechatOutboundMedia, type WechatOutboundMedia } from './outbound-media.js'
import { processWechatVideo } from './video-processing.js'
import { listWechatSpeechVoices, synthesizeWechatSpeech, type WechatSpeechVoice } from './speech-synthesis.js'
import { transcodeWechatVideo } from './video-transcode.js'
import type { WechatMediaPreference, WechatMediaPreferences } from './media-preferences.js'

export const WECHAT_MEDIA_HELP = '\n\nMedia commands:\n/send <path in project> — Send back an image, video or file (files 30 MiB, images 10 MiB)\n/transcode <video path in project> — Convert to compatible MP4 and send back (up to 120 seconds)\n/voice on|off — Turn audio-file replies for later answers on or off\n/voice list — List system voices\n/voice select <number|auto> — Choose a voice or restore automatic\n/speak <text> — Synthesize to an audio file (Windows, up to 2000 characters)\n/stop — Cancel media tasks and the current generation\nLocal images and file: download links in assistant replies are sent back automatically; ordinary code references are not. Video analysis and transcoding need ffmpeg/ffprobe; audio transcription uses the desktop speech recognition settings.'

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
    if (!binding || !this.deps.allowed(chatId)) throw new Error('Pair first and select a project session')
    if (this.jobs.has(chatId)) throw new Error('A media task is already in progress; wait or send /stop')
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
    if (!this.deps.allowed(chatId)) throw new Error('Pair first and select a project session')
    if (/^\/voice(?:\s|$)/.test(text)) {
      const mode = text.slice(6).trim()
      if (mode === 'list') {
        await this.run(chatId, async (signal, current) => {
          const voices = await (this.deps.listVoices ?? listWechatSpeechVoices)({ signal })
          if (!current()) return
          this.voiceLists.set(chatId, voices)
          await this.deps.notice(chatId, voices.length ? `Available voices:\n${voices.map((voice, index) => `${index + 1}. ${voice.name} (${voice.language})`).join('\n')}\nSend /voice select <number> to choose, or /voice select auto to restore automatic.` : 'No usable Windows system voices installed.')
        })
        return true
      }
      if (mode.startsWith('select ')) {
        const value = mode.slice(7).trim()
        const selected = /^\d+$/.test(value) ? this.voiceLists.get(chatId)?.[Number(value) - 1] : undefined
        if (value !== 'auto' && !selected) { await this.deps.notice(chatId, 'Send /voice list first, then pick a voice number from the list.'); return true }
        this.savePreference(chatId, { ...this.preference(chatId), voiceId: selected?.id })
        await this.deps.notice(chatId, selected ? `Voice set to ${selected.name}.` : 'Restored automatic voice selection.')
        return true
      }
      if (mode === 'on' || mode === 'off') {
        this.savePreference(chatId, { ...this.preference(chatId), enabled: mode === 'on' })
        if (mode === 'off') this.cancel(chatId)
      } else { await this.deps.notice(chatId, 'Usage: /voice on|off, /voice list, /voice select <number|auto> (audio file replies, not native voice bubbles)'); return true }
      await this.deps.notice(chatId, mode === 'on' ? `Audio file replies enabled; requires an available Windows speech engine. ${this.deps.preferences ? 'Preference saved and kept after restart.' : 'Valid for this run only; enable again after clearing or switching sessions.'}` : 'Audio file replies disabled.')
      return true
    }
    const match = /^\/(send|speak|transcode)(?:\s+([\s\S]+))?$/.exec(text)
    if (!match) return false
    if (!match[2]?.trim()) { await this.deps.notice(chatId, `Usage: /${match[1]} ${match[1] === 'speak' ? '<text to read aloud>' : '<file path in project>'}`); return true }
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
          if (totalBytes > 30 * 1024 * 1024) throw new Error('Total size sent back this turn exceeds 30 MiB; use /send to fetch files individually')
          if (current()) await this.deps.send(chatId, media, signal, current)
        } catch (error) {
          if (signal.aborted) throw error
          if (current()) await this.deps.notice(chatId, `Attachment was not fully sent (will not be resent automatically): ${error instanceof Error ? error.message : 'Unknown error'}. Check the result on the desktop, then use /send.`)
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
      if (media.buffer.length > 10 * 1024 * 1024) throw new Error('Synthesized audio exceeds 10 MiB')
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
          if (!current()) throw new Error('Media task was cancelled or the session changed')
          const image = await loadWechatOutboundMedia(frame.path, path.dirname(frame.path), signal)
          attachments.push({ type: 'image', name: `video-${frame.timestampMs}ms.jpg`, data: image.buffer.toString('base64'), mimeType: 'image/jpeg' })
        }
        let context = `The original video uploaded via WeChat is saved locally: ${JSON.stringify(filePath)}. When the user later says "this video", use this attachment; do not substitute a sample video from the repository.\n`
          + `Tools used for this video processing: ffmpeg=${JSON.stringify(process.env.WECHAT_FFMPEG_PATH || 'ffmpeg')}, ffprobe=${JSON.stringify(process.env.WECHAT_FFPROBE_PATH || 'ffprobe')}. Configured absolute paths may not be on the terminal PATH.\n`
          + 'Temporary audio-track and sampled-frame files are cleaned up; if an audio file needs to be extracted, generate it from the original video into the current project directory and return the artifact as [Download audio](file:///absolute/path) to trigger sending it back via WeChat. Printing a plain computer path will not upload the attachment; paths containing spaces or similar characters must use a correctly encoded file: URL.\n'
          + `${result.coverageNote}\nFrame sample times: ${result.frames.map(frame => `${(frame.timestampMs / 1000).toFixed(2)}s`).join(', ')}. Explain the sampling limitation; do not claim to have watched the whole video frame by frame.`
        if (result.audioPath) {
          try {
            const wav = await fs.readFile(result.audioPath)
            signal.throwIfAborted()
            const text = await this.deps.transcribe(wav, signal)
            context += text.trim() ? `\nAudio transcript (whole-track recognition, no per-word timestamps):\n${text.slice(0, 16000)}` : '\nNo speech recognized in the audio track.'
          } catch (error) {
            if (signal.aborted) throw error
            context += `\nAudio track could not be transcribed; only sampled frames are analyzed: ${error instanceof Error ? error.message : 'recognition unavailable'}`
          }
        } else context += '\nThe video has no audio track.'
        if (!current()) throw new Error('Media task was cancelled or the session changed')
        return { attachments, context }
      } finally {
        await result.cleanup()
      }
    })
  }
}
