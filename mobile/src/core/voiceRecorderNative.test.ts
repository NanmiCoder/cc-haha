import { describe, expect, test } from 'bun:test'
import { createNativeVoiceRecording, type NativeVoiceRuntime } from './voiceRecorderNative'
import { encodeVoiceWav } from './voiceWav'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const calls: string[] = []
  let samples: Float32Array = new Float32Array([0.25, -0.5])
  let permission: Promise<boolean> = Promise.resolve(true)
  let nativeStop: Promise<{ status: 'success', paths: string[] }> | undefined
  let startFails = false
  let onPcm: Parameters<ReturnType<NativeVoiceRuntime['createRecorder']>['onAudioReady']>[0] | undefined
  let onInterrupted: (() => void) | undefined
  const runtime: NativeVoiceRuntime = {
    requestPermission: () => { calls.push('permission'); return permission },
    activate: async () => { calls.push('activate') },
    deactivate: async () => { calls.push('deactivate') },
    createRecorder: () => {
      calls.push('create')
      return {
        enableFileOutput: () => { calls.push('file-output'); return { status: 'success' } },
        onAudioReady: callback => { onPcm = callback; return { status: 'success' } },
        onError: () => {},
        start: async () => { calls.push('start'); return startFails ? { status: 'error', message: 'busy' } : { status: 'success' } },
        stop: async () => { calls.push('stop'); return nativeStop ? nativeStop : { status: 'success', paths: ['file:///fixture/voice.wav'] } },
        clearOnAudioReady: () => { calls.push('clear-pcm') },
        clearOnError: () => { calls.push('clear-error') },
      }
    },
    observeInterruptions: callback => {
      onInterrupted = callback
      return () => { calls.push('remove-interruptions') }
    },
    readRecording: async () => { calls.push('read'); return encodeVoiceWav(samples) },
    deleteRecording: () => { calls.push('delete') },
    resample: async () => { throw new Error('Unexpected resampling') },
  }
  return {
    calls, runtime,
    permission(value: Promise<boolean>) { permission = value },
    stopWith(value: NonNullable<typeof nativeStop>) { nativeStop = value },
    failStart() { startFails = true },
    samples(value: Float32Array) { samples = value },
    interrupt() { onInterrupted?.() },
    emit(values: Float32Array, sampleRate = 16000) {
      onPcm?.({ numberOfChannels: 1, sampleRate, length: values.length, getChannelData: () => values }, values.length)
    },
  }
}

describe('native mobile dictation capture', () => {
  test('permission rejection and an aborted late permission never activate the microphone', async () => {
    const denied = fixture()
    denied.permission(Promise.resolve(false))
    await expect(createNativeVoiceRecording({ maxSeconds: 120 }, denied.runtime)).rejects.toMatchObject({ code: 'permission' })
    expect(denied.calls).toEqual(['permission'])
    const late = fixture()
    const decision = deferred<boolean>()
    const controller = new AbortController()
    late.permission(decision.promise)
    const start = createNativeVoiceRecording({ maxSeconds: 120, signal: controller.signal }, late.runtime)
    await Promise.resolve()
    controller.abort()
    decision.resolve(true)
    await expect(start).rejects.toMatchObject({ name: 'AbortError' })
    expect(late.calls).toEqual(['permission'])
  })

  test('retry after cancellation waits for the previous system permission request to finish', async () => {
    const first = fixture()
    const decision = deferred<boolean>()
    const abort = new AbortController()
    first.permission(decision.promise)
    const starting = createNativeVoiceRecording({ maxSeconds: 120, signal: abort.signal }, first.runtime)
    const cancelled = starting.then(() => undefined, error => error as Error)
    await Promise.resolve()
    abort.abort()
    const second = fixture()
    const retry = createNativeVoiceRecording({ maxSeconds: 120 }, second.runtime)
    await Promise.resolve()
    expect(second.calls).toEqual([])
    decision.resolve(true)
    expect(await cancelled).toMatchObject({ name: 'AbortError' })
    const recording = await retry
    expect(first.calls).toEqual(['permission'])
    expect(second.calls.filter(call => call === 'permission')).toHaveLength(1)
    await recording.stop()
  })

  test('stop waits for the complete file flush, releases the microphone, preserves tail samples and shares one result', async () => {
    const f = fixture()
    const flushed = deferred<{ status: 'success', paths: string[] }>()
    f.stopWith(flushed.promise)
    const recording = await createNativeVoiceRecording({ maxSeconds: 120 }, f.runtime)
    f.emit(new Float32Array([0.1, -0.1]))
    expect(recording.getLevel()).toBeCloseTo(0.5)
    const stop = recording.stop()
    expect(recording.stop()).toBe(stop)
    await Promise.resolve()
    expect(f.calls).not.toContain('read')
    f.samples(new Float32Array([0.25, -0.5, 1]))
    flushed.resolve({ status: 'success', paths: ['file:///fixture/voice.wav'] })
    const result = await stop
    expect(result.seconds).toBe(3 / 16000)
    expect(new DataView(result.wav.buffer).getInt16(48, true)).toBe(32767)
    expect(f.calls.filter(call => call === 'stop')).toHaveLength(1)
    expect(f.calls.filter(call => call === 'delete')).toHaveLength(1)
    expect(f.calls.indexOf('deactivate')).toBeLessThan(f.calls.indexOf('read'))
    expect(recording.getLevel()).toBe(0)
  })

  test('cancel during native stop discards the file and releases the session before another recording', async () => {
    const f = fixture()
    const flushed = deferred<{ status: 'success', paths: string[] }>()
    const controller = new AbortController()
    f.stopWith(flushed.promise)
    const recording = await createNativeVoiceRecording({ maxSeconds: 120, signal: controller.signal }, f.runtime)
    const stop = recording.stop()
    controller.abort()
    const nextFixture = fixture()
    const next = createNativeVoiceRecording({ maxSeconds: 120 }, nextFixture.runtime)
    await Promise.resolve()
    expect(nextFixture.calls).toEqual([])
    flushed.resolve({ status: 'success', paths: ['file:///fixture/voice.wav'] })
    await expect(stop).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.calls).not.toContain('read')
    expect(f.calls.filter(call => call === 'delete')).toHaveLength(1)
    const nextRecording = await next
    await nextRecording.stop()
  })

  test('interruptions notify once, release resources and never return interrupted text', async () => {
    const f = fixture()
    let interruptions = 0
    const recording = await createNativeVoiceRecording({ maxSeconds: 120, onInterrupted: () => interruptions++ }, f.runtime)
    f.interrupt()
    f.interrupt()
    await expect(recording.stop()).rejects.toMatchObject({ code: 'interrupted' })
    expect(interruptions).toBe(1)
    expect(f.calls).not.toContain('read')
    expect(f.calls).toContain('deactivate')
    expect(f.calls).toContain('delete')
  })

  test('time limits use the actual callback rate, stop once and keep the result available', async () => {
    const f = fixture()
    let limits = 0
    const recording = await createNativeVoiceRecording({ maxSeconds: 1, onLimitReached: () => limits++ }, f.runtime)
    const thirdSecond = new Float32Array(16000)
    f.emit(thirdSecond, 48000)
    expect(limits).toBe(0)
    f.emit(thirdSecond, 48000)
    expect(limits).toBe(0)
    f.emit(thirdSecond, 48000)
    expect(limits).toBe(1)
    f.emit(thirdSecond, 48000)
    expect(limits).toBe(1)
    await recording.stop()
    expect(f.calls.filter(call => call === 'stop')).toHaveLength(1)
  })

  test('failed startup cleans up and a later request can record successfully', async () => {
    const failed = fixture()
    failed.failStart()
    await expect(createNativeVoiceRecording({ maxSeconds: 120 }, failed.runtime)).rejects.toMatchObject({ code: 'failed' })
    expect(failed.calls).toContain('deactivate')
    expect(failed.calls).toContain('delete')
    const f = fixture()
    const recording = await createNativeVoiceRecording({ maxSeconds: 120 }, f.runtime)
    await recording.stop()
  })
})
