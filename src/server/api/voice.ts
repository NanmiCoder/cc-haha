/**
 * Voice input REST API
 *
 * POST /api/voice/transcribe — 接收音频文件（multipart: audio），转发给配置好的
 * 语音识别（speech-to-text）provider（如智谱 GLM-ASR-2512），返回转写文本。
 *
 * Key/endpoint/model 全部存放在用户设置 settings.voiceInput 中，由 server 读取并发起
 * 外部调用（与 provider/Tavily key 一致：不在前端持有外部 Key，CSP 也只允许 localhost）。
 */

import { SettingsService } from '../services/settingsService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const settingsService = new SettingsService()

const TRANSCRIBE_TIMEOUT_MS = 60_000

export async function handleVoiceApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2] // 'transcribe' | undefined

    if (sub === 'transcribe') {
      return await handleTranscribe(req)
    }

    throw ApiError.notFound(`Unknown voice endpoint: ${sub}`)
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleTranscribe(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
  }

  // 1. 读取用户设置中的语音输入配置（getUserSettings 返回 Record<string, unknown>）
  const settings = await settingsService.getUserSettings()
  const voiceInput = (settings.voiceInput ?? {}) as Record<string, unknown>
  const endpoint = typeof voiceInput.endpoint === 'string' ? voiceInput.endpoint.trim() : ''
  const apiKey = typeof voiceInput.apiKey === 'string' ? voiceInput.apiKey.trim() : ''
  const model = typeof voiceInput.model === 'string' ? voiceInput.model.trim() : ''

  if (!endpoint || !apiKey || !model) {
    throw ApiError.badRequest(
      '语音输入未配置完整：请在「设置 - 供应商 - 语音输入」中填写接口地址、API Key 和模型名。',
    )
  }

  // 2. 解析前端上传的音频（multipart/form-data，字段名 audio）
  let audioFile: File | null = null
  try {
    const form = await req.formData()
    const value = form.get('audio')
    audioFile = value instanceof File ? value : null
  } catch {
    audioFile = null
  }
  if (!audioFile) {
    throw ApiError.badRequest('缺少音频文件（multipart 字段 audio）')
  }

  // 3. 组装 multipart 转发给 provider（智谱 OpenAI 兼容的 transcriptions 接口）
  const outgoing = new FormData()
  outgoing.append('model', model)
  outgoing.append('stream', 'false')
  outgoing.append('file', audioFile, 'audio.wav')

  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: outgoing,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  })

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    throw new ApiError(
      502,
      `语音识别服务返回错误 (${upstream.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      'VOICE_UPSTREAM_ERROR',
    )
  }

  // 4. 解析上游返回文本（兼容 text / result / transcript 等字段）
  const text = await extractTranscriptText(upstream)
  return Response.json({ text })
}

async function extractTranscriptText(upstream: Response): Promise<string> {
  const contentType = upstream.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    const raw = (await upstream.text()).trim()
    return raw
  }
  const json = (await upstream.json().catch(() => null)) as unknown
  if (typeof json === 'string') return json
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>
    for (const key of ['text', 'result', 'transcript', 'transcription']) {
      const value = obj[key]
      if (typeof value === 'string') return value
    }
  }
  return ''
}
