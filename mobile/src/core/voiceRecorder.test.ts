import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('web voice capture handles native browser boundaries without a real microphone', () => {
  const script = `
    import assert from 'node:assert/strict'
    const calls = []
    let latestRecorder, latestTrack, denied = false, delayedPermission
    let decoded = new Float32Array([0.1, 0.2, 0.3, -0.5])
    let decodeWait
    class Track extends EventTarget { stop() { calls.push('track-stop') } }
    class Recorder extends EventTarget {
      static isTypeSupported() { return true }
      state = 'inactive'
      mimeType = 'audio/webm'
      constructor() { super(); latestRecorder = this }
      start() { this.state = 'recording'; calls.push('start') }
      stop() {
        this.state = 'inactive'
        queueMicrotask(() => {
          const event = new Event('dataavailable')
          event.data = new Blob(['native encoded audio'])
          this.dispatchEvent(event)
          this.dispatchEvent(new Event('stop'))
        })
      }
    }
    class Context {
      createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: samples => samples.fill(0.1) } }
      createMediaStreamSource() { return { connect() {} } }
      async resume() {}
      async close() { calls.push('context-close') }
    }
    class Offline {
      async decodeAudioData() {
        calls.push('decode')
        if (decodeWait) await decodeWait
        return { numberOfChannels: 1, sampleRate: 16000, duration: decoded.length / 16000, getChannelData: () => decoded }
      }
    }
    globalThis.window = { isSecureContext: true }
    globalThis.navigator = { mediaDevices: { async getUserMedia() {
      calls.push('permission')
      if (denied) { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error }
      if (delayedPermission) return delayedPermission
      latestTrack = new Track()
      return { getTracks: () => [latestTrack] }
    } } }
    globalThis.MediaRecorder = Recorder
    globalThis.AudioContext = Context
    globalThis.OfflineAudioContext = Offline
    const { startVoiceRecording, isVoiceCaptureSupported } = await import(${JSON.stringify(import.meta.resolve('./voiceRecorder'))})
    assert.equal(isVoiceCaptureSupported(), true)
    const recording = await startVoiceRecording({ maxSeconds: 120 })
    assert.ok(Math.abs(recording.getLevel() - 0.5) < 0.001)
    const ending = recording.stop()
    assert.equal(recording.stop(), ending)
    const result = await ending
    assert.equal(result.seconds, 4 / 16000)
    assert.equal(new DataView(result.wav.buffer).getInt16(50, true), -16384)
    assert.ok(calls.indexOf('track-stop') < calls.indexOf('decode'))
    assert.equal(recording.getLevel(), 0)
    denied = true
    await assert.rejects(startVoiceRecording({ maxSeconds: 120 }), { code: 'permission' })
    denied = false
    let grant
    delayedPermission = new Promise(resolve => { grant = resolve })
    const controller = new AbortController()
    const opening = startVoiceRecording({ maxSeconds: 120, signal: controller.signal })
    controller.abort()
    const delayedTrack = new Track()
    const before = calls.filter(value => value === 'track-stop').length
    grant({ getTracks: () => [delayedTrack] })
    await assert.rejects(opening, { name: 'AbortError' })
    assert.equal(calls.filter(value => value === 'track-stop').length, before + 1)
    delayedPermission = undefined
    let interruptions = 0
    const interrupted = await startVoiceRecording({ maxSeconds: 120, onInterrupted: () => interruptions++ })
    latestTrack.dispatchEvent(new Event('ended'))
    latestTrack.dispatchEvent(new Event('ended'))
    await assert.rejects(interrupted.stop(), { code: 'interrupted' })
    assert.equal(interruptions, 1)
    let limit
    const reached = new Promise(resolve => { limit = resolve })
    const bounded = await startVoiceRecording({ maxSeconds: 0.005, onLimitReached: limit })
    await reached
    assert.equal(latestRecorder.state, 'inactive')
    await bounded.stop()
    let decodeDone
    decodeWait = new Promise(resolve => { decodeDone = resolve })
    const decodeController = new AbortController()
    const cancelled = await startVoiceRecording({ maxSeconds: 120, signal: decodeController.signal })
    const cancellation = cancelled.stop()
    await Promise.resolve()
    await Promise.resolve()
    decodeController.abort()
    decodeDone()
    await assert.rejects(cancellation, { name: 'AbortError' })
    window.isSecureContext = false
    assert.equal(isVoiceCaptureSupported(), false)
    await assert.rejects(startVoiceRecording({ maxSeconds: 120 }), { code: 'unavailable' })
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
