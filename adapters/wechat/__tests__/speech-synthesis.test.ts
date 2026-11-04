import { afterEach, describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  prepareWechatSpeechText,
  listWechatSpeechVoices,
  runWechatSpeechProcess,
  synthesizeWechatSpeech,
  WECHAT_SPEECH_MAX_BYTES,
  type SpeechProcessRequest,
} from '../speech-synthesis.js'

const dirs: string[] = []
const windowsOptions = { platform: 'win32' as const, resolvePowerShell: async () => 'fixture-powershell.exe' }
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-speech-test-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

function wav() {
  const data = Buffer.alloc(46)
  data.write('RIFF', 0)
  data.writeUInt32LE(38, 4)
  data.write('WAVE', 8)
  data.write('fmt ', 12)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(16000, 24)
  data.writeUInt32LE(32000, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(2, 40)
  return data
}

describe('WeChat local speech synthesis', () => {
  it('lists installed voices through bounded JSON output and removes its staging file', async () => {
    const dir = await tempDir()
    const voices = [{ id: 'voice-1', name: 'Fixture voice', language: 'en-US' }]
    expect(await listWechatSpeechVoices({ ...windowsOptions, outputDir: dir, runner: async request => {
      expect(request.input).not.toContain('text')
      await fs.writeFile(request.outputPath, JSON.stringify(voices))
    } })).toEqual(voices)
    expect(await fs.readdir(dir)).toEqual([])
    await expect(listWechatSpeechVoices({ ...windowsOptions, outputDir: dir, runner: async request => {
      await fs.writeFile(request.outputPath, '{"id":"invalid"}')
    } })).rejects.toThrow('音色列表无效')
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('passes selected voice as data and chooses WinRT even for English text', async () => {
    const voiceId = 'voice $(never execute)'
    const result = await synthesizeWechatSpeech('Hello', { ...windowsOptions, voiceId, outputDir: await tempDir(), runner: async request => {
      expect(JSON.parse(request.input).voiceId).toBe(voiceId)
      expect(request.args.join(' ')).not.toContain('never execute')
      expect(Buffer.from(request.args.at(-1)!, 'base64').toString('utf16le')).toContain('VOICE_NOT_FOUND')
      await fs.writeFile(request.outputPath, wav())
    } })
    await result.cleanup()
  })
  it('speaks prose without code blocks, inline code, images or link destinations', () => {
    expect(prepareWechatSpeechText('# 结果\n**完成** [报告](https://example.invalid/report)\n```ts\nrm -rf /\n```\n`secret()`\n![图](file.png)\n结束')).toBe('结果 完成 报告 结束')
    expect(prepareWechatSpeechText('摘要\n~~~sh\nnever speak this')).toBe('摘要')
  })

  it('keeps shell-looking text in stdin JSON and returns an owned WAV with cleanup', async () => {
    const dir = await tempDir()
    let request: SpeechProcessRequest | undefined
    const text = '你好 $(Write-Output malicious); "quoted"'
    const result = await synthesizeWechatSpeech(text, {
      ...windowsOptions, outputDir: dir,
      runner: async input => { request = input; await fs.writeFile(input.outputPath, wav()) },
    })
    expect(result.mimeType).toBe('audio/wav')
    expect(JSON.parse(request!.input).text).toBe(text)
    expect(request!.args.join(' ')).not.toContain('malicious')
    expect(Buffer.from(request!.args.at(-1)!, 'base64').toString('utf16le')).toContain('[Console]::In.ReadToEnd()')
    expect(Buffer.from(request!.args.at(-1)!, 'base64').toString('utf16le')).toContain('Windows.Media.SpeechSynthesis')
    expect((await fs.stat(result.path)).size).toBe(46)
    await result.cleanup()
    await result.cleanup()
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('rejects empty/oversized text and unsupported hosts without starting a process', async () => {
    let called = false
    const runner = async () => { called = true }
    await expect(synthesizeWechatSpeech('```js\nx()\n```', { platform: 'win32', runner })).rejects.toThrow('没有可朗读')
    await expect(synthesizeWechatSpeech('中'.repeat(2001), { platform: 'win32', runner })).rejects.toThrow('2000')
    await expect(synthesizeWechatSpeech('Hello', { platform: 'linux', runner })).rejects.toThrow('仅支持 Windows')
    expect(called).toBe(false)
  })

  it('accepts 2000 Unicode characters without counting surrogate pairs twice', async () => {
    const result = await synthesizeWechatSpeech('😀'.repeat(2000), {
      ...windowsOptions, outputDir: await tempDir(),
      runner: async input => { await fs.writeFile(input.outputPath, wav()) },
    })
    await result.cleanup()
  })

  it('cleans up partial output on synthesis failure', async () => {
    const dir = await tempDir()
    await expect(synthesizeWechatSpeech('Hello', {
      ...windowsOptions, outputDir: dir,
      runner: async input => { await fs.writeFile(input.outputPath, 'partial'); throw new Error('missing voice') },
    })).rejects.toThrow('missing voice')
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('rejects corrupt and oversized WAV output and cleans both', async () => {
    const dir = await tempDir()
    for (const oversized of [false, true]) {
      await expect(synthesizeWechatSpeech('Hello', {
        ...windowsOptions, outputDir: dir,
        runner: async input => {
          if (!oversized) await fs.writeFile(input.outputPath, Buffer.alloc(100))
          else {
            await fs.writeFile(input.outputPath, wav())
            await fs.truncate(input.outputPath, WECHAT_SPEECH_MAX_BYTES + 1)
          }
        },
      })).rejects.toThrow(oversized ? '10 MiB' : '无效的 WAV')
      expect(await fs.readdir(dir)).toEqual([])
    }
  })

  it('rejects a pre-cancelled request without running the engine', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(synthesizeWechatSpeech('Hello', { signal: controller.signal, platform: 'win32' })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses an injected PowerShell resolver for System.Speech on non-Chinese text', async () => {
    const result = await synthesizeWechatSpeech('English reply', {
      ...windowsOptions, outputDir: await tempDir(),
      runner: async request => {
        expect(request.command).toBe('fixture-powershell.exe')
        expect(Buffer.from(request.args.at(-1)!, 'base64').toString('utf16le')).toContain('System.Speech.Synthesis.SpeechSynthesizer')
        await fs.writeFile(request.outputPath, wav())
      },
    })
    await result.cleanup()
  })

  it('defaults to the Windows .NET Framework host without a CLI shell resolver', async () => {
    const result = await synthesizeWechatSpeech('English reply', {
      platform: 'win32', outputDir: await tempDir(),
      runner: async request => {
        expect(request.command).toBe(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
        expect(Buffer.from(request.args.at(-1)!, 'base64').toString('utf16le')).toContain('System.Speech.Synthesis.SpeechSynthesizer')
        await fs.writeFile(request.outputPath, wav())
      },
    })
    await result.cleanup()
  })

  it('reports missing Chinese voices without leaking child stderr or input', async () => {
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: () => void }; stderr: EventEmitter; kill: () => boolean }
    child.stderr = new EventEmitter()
    child.stdin = Object.assign(new EventEmitter(), { end: () => {
      child.stderr.emit('data', Buffer.from('private input CC_HAHA_SPEECH_ERROR:NO_CHINESE_VOICE'))
      child.emit('close', 1)
    } })
    child.kill = () => true
    const promise = runWechatSpeechProcess({
      command: 'fixture.exe', args: [], input: '{}', outputPath: path.join(await tempDir(), 'reply.wav'), timeoutMs: 1000,
    }, (() => child) as unknown as typeof spawn)
    await expect(promise).rejects.toThrow('未安装中文语音包')
    await expect(promise).rejects.not.toThrow('private input')
  })

  for (const reason of ['abort', 'timeout'] as const) {
    it(`kills the process and waits for its exit on ${reason}`, async () => {
      const controller = new AbortController()
      const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: () => void }; stderr: EventEmitter; kill: () => boolean }
      child.stdin = Object.assign(new EventEmitter(), { end: () => {} })
      child.stderr = new EventEmitter()
      let killed = false
      child.kill = () => { killed = true; setTimeout(() => child.emit('close', null), 5); return true }
      const promise = runWechatSpeechProcess({
        command: 'fixture.exe', args: [], input: '{}', outputPath: path.join(await tempDir(), 'reply.wav'),
        timeoutMs: reason === 'timeout' ? 5 : 1000, signal: controller.signal,
      }, ((command: string, args: string[], options: Record<string, unknown>) => {
        expect(options.windowsHide).toBe(true)
        expect(options.shell).toBe(false)
        return child
      }) as unknown as typeof spawn)
      if (reason === 'abort') controller.abort()
      await expect(promise).rejects.toThrow(reason === 'abort' ? '取消' : '超时')
      expect(killed).toBe(true)
    })
  }
})
