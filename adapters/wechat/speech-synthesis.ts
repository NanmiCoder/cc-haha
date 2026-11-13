import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export const WECHAT_SPEECH_MAX_CHARACTERS = 2000
export const WECHAT_SPEECH_MAX_BYTES = 10 * 1024 * 1024

/** Fixed program: message text and the generated path are data on stdin, never code. */
const SPEECH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$speechFailureCode = 'ENGINE_FAILED'
try {
  $speechRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Speech
  $voiceSynthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $availableVoices = @($voiceSynthesizer.GetInstalledVoices() | Where-Object { $_.Enabled })
    if ($availableVoices.Count -eq 0) { $speechFailureCode = 'NO_VOICE'; throw 'No Windows speech voice is installed.' }
    if ($speechRequest.text -match '[\u3400-\u9fff]') {
      $chineseVoice = $availableVoices | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
      if (-not $chineseVoice) { $speechFailureCode = 'NO_CHINESE_VOICE'; throw 'No Chinese voice.' }
      $voiceSynthesizer.SelectVoice($chineseVoice.VoiceInfo.Name)
    }
    $waveFormat = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $voiceSynthesizer.SetOutputToWaveFile([string]$speechRequest.outputPath, $waveFormat)
    $voiceSynthesizer.Speak([string]$speechRequest.text)
    $voiceSynthesizer.SetOutputToNull()
  } finally { $voiceSynthesizer.Dispose() }
} catch {
  [Console]::Error.WriteLine('CC_HAHA_SPEECH_ERROR:' + $speechFailureCode)
  exit 1
}
`

// Windows' modern Chinese voices are often exposed through WinRT but absent
// from System.Speech. WinRT interop needs Windows PowerShell (.NET Framework).
const WINRT_SPEECH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$speechFailureCode = 'ENGINE_FAILED'
$voiceSynthesizer = $null
$speechStream = $null
$inputStream = $null
$fileStream = $null
try {
  $speechRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  $voiceSynthesizer = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  if ($speechRequest.voiceId) {
    $selectedVoice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Id -eq [string]$speechRequest.voiceId } | Select-Object -First 1
    if (-not $selectedVoice) { $speechFailureCode = 'VOICE_NOT_FOUND'; throw 'Selected voice is unavailable.' }
  } else {
    $selectedVoice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Language -like 'zh-*' } | Select-Object -First 1
    if (-not $selectedVoice) { $speechFailureCode = 'NO_CHINESE_VOICE'; throw 'No Chinese voice.' }
  }
  $voiceSynthesizer.Voice = $selectedVoice
  $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1' } | Select-Object -First 1
  $speechOperation = $voiceSynthesizer.SynthesizeTextToStreamAsync([string]$speechRequest.text)
  $speechTask = $asTaskMethod.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($speechOperation))
  $speechTask.Wait()
  $speechStream = $speechTask.Result
  if ($speechStream.Size -gt 10485760) { $speechFailureCode = 'TOO_LARGE'; throw 'Audio exceeds limit.' }
  $inputStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($speechStream.GetInputStreamAt(0))
  $fileStream = [System.IO.File]::Create([string]$speechRequest.outputPath)
  $inputStream.CopyTo($fileStream)
} catch {
  [Console]::Error.WriteLine('CC_HAHA_SPEECH_ERROR:' + $speechFailureCode)
  exit 1
} finally {
  if ($fileStream) { $fileStream.Dispose() }
  if ($inputStream) { $inputStream.Dispose() }
  if ($speechStream) { $speechStream.Dispose() }
  if ($voiceSynthesizer) { $voiceSynthesizer.Dispose() }
}
`

const VOICE_LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $speechRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  $voices = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { @{ id = $_.Id; name = $_.DisplayName; language = $_.Language } })
  $json = ConvertTo-Json -InputObject $voices -Compress
  [System.IO.File]::WriteAllText([string]$speechRequest.outputPath, $json, [System.Text.UTF8Encoding]::new($false))
} catch { [Console]::Error.WriteLine('CC_HAHA_SPEECH_ERROR:ENGINE_FAILED'); exit 1 }
`

export type WechatSpeechVoice = { id: string; name: string; language: string }

export type SpeechProcessRequest = {
  command: string
  args: string[]
  input: string
  outputPath: string
  signal?: AbortSignal
  timeoutMs: number
}

export type SpeechProcessRunner = (request: SpeechProcessRequest) => Promise<void>

export type WechatSpeechOptions = {
  voiceId?: string
  signal?: AbortSignal
  outputDir?: string
  /** Dependency seams for offline tests; callers normally leave these unset. */
  runner?: SpeechProcessRunner
  platform?: NodeJS.Platform
  resolvePowerShell?: () => Promise<string | null>
  timeoutMs?: number
}

export type WechatSpeechResult = {
  path: string
  mimeType: 'audio/wav'
  fileName: string
  cleanup: () => Promise<void>
}

/** Speak prose, not fenced/inline code, hidden HTML or link destinations. */
export function prepareWechatSpeechText(text: string): string {
  let fence: { marker: string; length: number } | null = null
  const prose: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length) fence = null
      continue
    }
    if (!fence && !/^(?: {4}|\t)/.test(line)) prose.push(line)
  }
  return prose.join('\n')
    .replace(/`+[^`\n]*`+/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function aborted(): Error {
  const error = new Error('语音合成已取消。')
  error.name = 'AbortError'
  return error
}

/** Wait for close after killing so cleanup never races an open WAV handle. */
export function runWechatSpeechProcess(
  request: SpeechProcessRequest,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  if (request.signal?.aborted) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    const child = spawnProcess(request.command, request.args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let failure: Error | undefined
    let settled = false
    let outputBytes = 0
    let diagnostic = ''
    const stop = (error: Error) => {
      if (settled || failure) return
      failure = error
      child.kill()
    }
    const onAbort = () => stop(aborted())
    const timeout = setTimeout(() => stop(new Error('语音合成超时，请缩短回复后重试。')), request.timeoutMs)
    const sizeCheck = setInterval(() => {
      void fs.stat(request.outputPath).then(stat => {
        if (stat.size > WECHAT_SPEECH_MAX_BYTES) stop(new Error('生成的音频超过 10 MiB 限制。'))
      }).catch(() => {})
    }, 250)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(sizeCheck)
      request.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    child.on('error', () => finish(failure ?? new Error('无法启动 Windows 语音合成，请检查系统 PowerShell 和语音组件。')))
    child.stderr?.on('data', (chunk: Buffer) => {
      // Do not expose child diagnostics: some engines include the input text.
      outputBytes += chunk.length
      if (outputBytes <= 16 * 1024) diagnostic += chunk.toString('utf8')
      if (outputBytes > 16 * 1024) stop(new Error('语音合成进程输出异常。'))
    })
    child.on('close', code => {
      const message = diagnostic.includes('CC_HAHA_SPEECH_ERROR:VOICE_NOT_FOUND')
        ? '所选音色已不可用，请发送 /voice list 重新选择，或 /voice select auto 恢复自动。'
        : diagnostic.includes('CC_HAHA_SPEECH_ERROR:NO_CHINESE_VOICE')
        ? '未安装中文语音包，请在 Windows 的语言和语音设置中安装中文语音后重试。'
        : diagnostic.includes('CC_HAHA_SPEECH_ERROR:NO_VOICE')
          ? '未安装可用的 Windows 语音包，请在系统语言和语音设置中安装语音包。'
          : diagnostic.includes('CC_HAHA_SPEECH_ERROR:TOO_LARGE')
            ? '生成的音频超过 10 MiB 限制。'
            : 'Windows 语音合成失败，请检查系统语音组件或配置可用的 PowerShell 7。'
      finish(failure ?? (code === 0 ? undefined : new Error(message)))
    })
    child.stdin?.on('error', () => stop(new Error('无法向语音合成进程传递文本。')))
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) onAbort()
    child.stdin?.end(request.input, 'utf8')
  })
}

export async function synthesizeWechatSpeech(text: string, options: WechatSpeechOptions = {}): Promise<WechatSpeechResult> {
  if (options.signal?.aborted) throw aborted()
  if ((options.platform ?? process.platform) !== 'win32') {
    throw new Error('当前本地语音合成仅支持 Windows；文字回复仍可正常使用。')
  }
  const cleaned = prepareWechatSpeechText(text)
  if (!cleaned) throw new Error('没有可朗读的文字；代码块不会转换为语音。')
  if (Array.from(cleaned).length > WECHAT_SPEECH_MAX_CHARACTERS) {
    throw new Error('语音回复最多支持 2000 字，请先生成较短的摘要。')
  }
  const windowsPowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const useWinRt = Boolean(options.voiceId) || /[\u3400-\u9fff]/u.test(cleaned)
  // The speech APIs use Windows' .NET Framework host. Keep the standalone
  // adapter independent of the CLI shell resolver and its root dependencies.
  const command = useWinRt ? windowsPowerShell : await options.resolvePowerShell?.() ?? windowsPowerShell
  if (options.signal?.aborted) throw aborted()
  const parentDir = path.resolve(options.outputDir ?? os.tmpdir())
  await fs.mkdir(parentDir, { recursive: true })
  const stageDir = await fs.mkdtemp(path.join(parentDir, 'cc-haha-wechat-speech-'))
  const outputPath = path.join(stageDir, 'reply.wav')
  const cleanup = async () => { await fs.rm(stageDir, { recursive: true, force: true }) }
  try {
    await (options.runner ?? runWechatSpeechProcess)({
      command,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(useWinRt ? WINRT_SPEECH_SCRIPT : SPEECH_SCRIPT, 'utf16le').toString('base64')],
      input: JSON.stringify({ text: cleaned, outputPath, voiceId: options.voiceId }),
      outputPath,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 120_000,
    })
    if (options.signal?.aborted) throw aborted()
    const file = await fs.open(outputPath, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size < 44) throw new Error('语音合成未生成有效音频。')
      if (stat.size > WECHAT_SPEECH_MAX_BYTES) throw new Error('生成的音频超过 10 MiB 限制。')
      const header = Buffer.alloc(12)
      await file.read(header, 0, header.length, 0)
      if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('语音合成返回了无效的 WAV 文件。')
      }
    } finally { await file.close() }
    return { path: outputPath, mimeType: 'audio/wav', fileName: 'reply.wav', cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export async function listWechatSpeechVoices(options: WechatSpeechOptions = {}): Promise<WechatSpeechVoice[]> {
  if (options.signal?.aborted) throw aborted()
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('音色选择目前仅支持 Windows。')
  const parent = path.resolve(options.outputDir ?? os.tmpdir())
  await fs.mkdir(parent, { recursive: true })
  const directory = await fs.mkdtemp(path.join(parent, 'cc-haha-wechat-voices-'))
  const outputPath = path.join(directory, 'voices.json')
  try {
    await (options.runner ?? runWechatSpeechProcess)({
      command: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(VOICE_LIST_SCRIPT, 'utf16le').toString('base64')],
      input: JSON.stringify({ outputPath }), outputPath, signal: options.signal, timeoutMs: 15_000,
    })
    if (options.signal?.aborted) throw aborted()
    if ((await fs.stat(outputPath)).size > 64 * 1024) throw new Error('系统音色列表超出限制。')
    const voices: unknown = JSON.parse(await fs.readFile(outputPath, 'utf8'))
    if (!Array.isArray(voices) || voices.length > 128 || voices.some(voice => !voice ||
      typeof voice.id !== 'string' || voice.id.length > 2048 || typeof voice.name !== 'string' ||
      voice.name.length > 200 || typeof voice.language !== 'string' || voice.language.length > 40)) {
      throw new Error('系统音色列表无效。')
    }
    return voices as WechatSpeechVoice[]
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
