import { describe, expect, test } from 'bun:test'
import { createVoiceDictation, insertVoiceText, type VoiceDraft } from './voiceDictation'
import type { VoiceCatalog } from './voiceApi'
import type { VoiceRecording } from './voiceRecorderTypes'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  let draft: VoiceDraft = { key: 'host:chat', text: '已有草稿', revision: 0, selection: { start: 2, end: 2 }, blocked: false, canSend: true }
  const catalog = {
    supported: true,
    preferences: { enabled: true, providerId: 'sensevoice-local', language: 'zh', downloadSource: 'auto' },
    providers: [{ info: { id: 'sensevoice-local' }, preparation: { phase: 'ready' } }],
    limits: { maxAudioSeconds: 120, maxAudioBytes: 4 * 1024 * 1024 },
  } as VoiceCatalog
  let permission: ReturnType<typeof deferred<VoiceRecording>> | undefined
  let recognition: ReturnType<typeof deferred<{ text: string, audioSeconds: number, inferenceSeconds: number }>> | undefined
  let catalogWait: ReturnType<typeof deferred<VoiceCatalog>> | undefined
  let recordOptions!: Parameters<Parameters<typeof createVoiceDictation>[0]['record']>[0]
  let catalogCalls = 0
  let recordCalls = 0
  let stopCalls = 0
  let cancelCalls = 0
  let transcribeCalls = 0
  let transcript = '语音内容'
  let duration = 0.5
  let bytes = new Uint8Array(16_044)
  let error: unknown
  let lastSignal: AbortSignal | undefined
  const writes: { text: string, cursor: number }[] = []
  const sends: string[] = []
  const recording: VoiceRecording = {
    getLevel: () => 0.6,
    cancel: () => { cancelCalls++ },
    stop: async () => { stopCalls++; return { wav: bytes, seconds: duration } },
  }
  const voice = createVoiceDictation({
    read: () => draft,
    write: (text, cursor) => { writes.push({ text, cursor }); draft = { ...draft, text, revision: draft.revision + 1 } },
    submitAfterWrite: text => { sends.push(text) },
    focus: () => {},
    changed: () => {},
    now: () => 12345,
    catalog: async () => { catalogCalls++; return catalogWait ? catalogWait.promise : catalog },
    record: async options => { recordCalls++; recordOptions = options; return permission ? permission.promise : recording },
    transcribe: async (_wav, options) => {
      transcribeCalls++
      lastSignal = options.signal
      expect(options.providerId).toBe('sensevoice-local')
      expect(options.language).toBe('zh')
      if (error) throw error
      return recognition ? recognition.promise : { text: transcript, audioSeconds: duration, inferenceSeconds: 0.1 }
    },
  })
  return {
    voice, catalog, recording, writes, sends,
    state: () => ({ draft, catalogCalls, recordCalls, stopCalls, cancelCalls, transcribeCalls, recordOptions, lastSignal }),
    edit(text: string, revision = draft.revision + 1) { draft = { ...draft, text, revision } },
    block() { draft = { ...draft, blocked: true, canSend: false } },
    unblock() { draft = { ...draft, blocked: false, canSend: true } },
    navigate() { draft = { ...draft, key: 'host:other', text: '另一个会话', revision: 0 } },
    permission() { permission = deferred<VoiceRecording>(); return permission },
    recognition() { recognition = deferred(); return recognition },
    catalogWait() { catalogWait = deferred<VoiceCatalog>(); return catalogWait },
    audio(seconds: number, size = 16_044) { duration = seconds; bytes = new Uint8Array(size) },
    text(text: string) { transcript = text },
    fail(value: unknown) { error = value },
  }
}

describe('mobile dictation lifecycle', () => {
  test('inserts at the captured selection; send waits for the new controlled draft', async () => {
    const f = setup()
    await f.voice.start()
    expect(f.voice.state()).toMatchObject({ phase: 'recording', startedAt: 12345, limitSeconds: 120 })
    expect(f.voice.getLevel()).toBe(0.6)
    await f.voice.stop(true)
    expect(f.writes).toEqual([{ text: '已有语音内容草稿', cursor: 6 }])
    expect(f.sends).toEqual(['已有语音内容草稿'])
    expect(f.voice.state().phase).toBe('idle')
  })

  test('does not open the microphone until the computer model is ready and voice is enabled', async () => {
    const f = setup()
    f.catalog.providers[0]!.preparation.phase = 'unprepared'
    await f.voice.start()
    expect(f.state().recordCalls).toBe(0)
    expect(f.voice.state().issue?.code).toBe('voice/not-ready')
    f.catalog.preferences.enabled = false
    await f.voice.start()
    expect(f.state().recordCalls).toBe(0)
    expect(f.voice.state().issue?.code).toBe('disabled')
  })

  test('a slow catalog lookup cannot start a second run or survive cancellation', async () => {
    const f = setup()
    const gate = f.catalogWait()
    const starting = f.voice.start()
    await f.voice.start()
    expect(f.state().catalogCalls).toBe(1)
    f.voice.cancel()
    gate.resolve(f.catalog)
    await starting
    expect(f.state().recordCalls).toBe(0)
    expect(f.voice.state().phase).toBe('idle')
  })

  test('cancel releases a microphone which arrives after the permission prompt', async () => {
    const f = setup()
    const gate = f.permission()
    const starting = f.voice.start()
    await Promise.resolve()
    await Promise.resolve()
    f.voice.cancel()
    gate.resolve(f.recording)
    await starting
    expect(f.state().cancelCalls).toBe(1)
    expect(f.state().recordOptions.signal.aborted).toBe(true)
    expect(f.state().transcribeCalls).toBe(0)
  })

  test('stop before microphone startup and the duration limit each finalize once', async () => {
    const f = setup()
    const gate = f.permission()
    const starting = f.voice.start()
    await f.voice.stop()
    gate.resolve(f.recording)
    await starting
    await Promise.resolve()
    await Promise.resolve()
    expect(f.state().stopCalls).toBe(1)
    expect(f.state().transcribeCalls).toBe(1)
    const limited = setup()
    await limited.voice.start()
    limited.state().recordOptions.onLimitReached()
    await limited.voice.stop()
    await Promise.resolve()
    expect(limited.state().stopCalls).toBe(1)
  })

  test('a send requested during transcription does not upload or submit twice', async () => {
    const f = setup()
    const result = f.recognition()
    await f.voice.start()
    const finishing = f.voice.stop()
    await Promise.resolve()
    await f.voice.stop(true)
    expect(f.voice.state().sendRequested).toBe(true)
    result.resolve({ text: '好了', audioSeconds: 0.5, inferenceSeconds: 0.1 })
    await finishing
    expect(f.state().transcribeCalls).toBe(1)
    expect(f.sends).toEqual(['已有好了草稿'])
  })

  test('draft revisions including type-and-delete retain text for explicit insertion', async () => {
    const f = setup()
    const result = f.recognition()
    await f.voice.start()
    const finishing = f.voice.stop(true)
    await Promise.resolve()
    f.edit('已有草稿X')
    f.edit('已有草稿')
    result.resolve({ text: '新文字', audioSeconds: 0.5, inferenceSeconds: 0.1 })
    await finishing
    expect(f.writes).toEqual([])
    expect(f.sends).toEqual([])
    expect(f.voice.state().pendingText).toBe('新文字')
    f.voice.insertPending()
    expect(f.writes).toEqual([{ text: '已有新文字草稿', cursor: 5 }])
    expect(f.voice.state().pendingText).toBeNull()
  })

  test('disconnect retains a transcript without sending and inserts only when unblocked', async () => {
    const f = setup()
    const result = f.recognition()
    await f.voice.start()
    const finishing = f.voice.stop(true)
    await Promise.resolve()
    f.block()
    result.resolve({ text: '保留', audioSeconds: 0.5, inferenceSeconds: 0.1 })
    await finishing
    f.voice.insertPending()
    expect(f.writes).toEqual([])
    f.unblock()
    f.voice.insertPending()
    expect(f.writes[0]?.text).toBe('已有保留草稿')
    expect(f.sends).toEqual([])
  })

  test('navigation and cancellation ignore late results and abort the request', async () => {
    for (const navigation of [false, true]) {
      const f = setup()
      const result = f.recognition()
      await f.voice.start()
      const finishing = f.voice.stop(true)
      await Promise.resolve()
      if (navigation) f.navigate()
      f.voice.abandon()
      result.resolve({ text: '不能写入', audioSeconds: 0.5, inferenceSeconds: 0.1 })
      await finishing
      expect(f.state().lastSignal?.aborted).toBe(true)
      expect(f.writes).toEqual([])
      expect(f.sends).toEqual([])
      expect(f.voice.state().pendingText).toBeNull()
    }
  })

  test('microphone interruption and upload errors can be retried', async () => {
    const f = setup()
    await f.voice.start()
    f.state().recordOptions.onInterrupted({ code: 'interrupted' })
    expect(f.state().cancelCalls).toBe(1)
    expect(f.voice.state().issue?.code).toBe('interrupted')
    f.fail({ code: 'NETWORK_ERROR' })
    await f.voice.start()
    await f.voice.stop()
    expect(f.voice.state().issue?.code).toBe('NETWORK_ERROR')
    f.fail(undefined)
    await f.voice.start()
    await f.voice.stop()
    expect(f.writes).toHaveLength(1)
  })

  test('empty, too-short and over-limit recordings never send a message', async () => {
    const f = setup()
    f.audio(0.1)
    await f.voice.start()
    await f.voice.stop(true)
    expect(f.state().transcribeCalls).toBe(0)
    expect(f.voice.state().issue?.code).toBe('too-short')
    f.audio(121)
    await f.voice.start()
    await f.voice.stop(true)
    expect(f.state().transcribeCalls).toBe(0)
    f.audio(0.5)
    f.text(' \n ')
    await f.voice.start()
    await f.voice.stop(true)
    expect(f.voice.state().issue?.code).toBe('no-speech')
    expect(f.writes).toEqual([])
    expect(f.sends).toEqual([])
  })
})

test('voice text insertion replaces a selection and joins Latin words without adding CJK spaces', () => {
  expect(insertVoiceText('HelloWorld', { start: 5, end: 5 }, ' new\n words ')).toEqual({ text: 'Hello new words World', cursor: 16 })
  expect(insertVoiceText('替换这段文字', { start: 2, end: 4 }, '识别')).toEqual({ text: '替换识别文字', cursor: 4 })
})
