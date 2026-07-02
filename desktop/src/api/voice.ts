/**
 * Voice input (speech-to-text) REST API client.
 *
 * 注意：不能用通用的 `api.post`（它强制 JSON.stringify + Content-Type: application/json，
 * 见 ./client.ts），这里要上传二进制音频，所以直接用原生 fetch + FormData。
 */

import { getApiUrl, getAuthToken, ApiError } from './client'

export type TranscribeResult = {
  text: string
}

export const voiceApi = {
  /**
   * 把一段音频（默认 WAV）POST 到本地 server 的 /api/voice/transcribe，
   * 由 server 读取设置中的 Key/endpoint/model 转发给语音识别 provider。
   */
  async transcribe(audio: Blob, mimeType = 'audio/wav'): Promise<TranscribeResult> {
    const form = new FormData()
    const file = new File([audio], 'audio.wav', { type: mimeType })
    form.append('audio', file)

    const headers: Record<string, string> = {}
    const token = getAuthToken()
    if (token) headers.Authorization = `Bearer ${token}`

    const res = await fetch(getApiUrl('/api/voice/transcribe'), {
      method: 'POST',
      headers,
      body: form,
    })

    if (!res.ok) {
      const errorBody = await res.json().catch(() => res.text())
      throw new ApiError(res.status, errorBody)
    }

    const data = (await res.json().catch(() => ({ text: '' }))) as TranscribeResult
    return { text: typeof data.text === 'string' ? data.text : '' }
  },
}
