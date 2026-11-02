import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('the native production entry configures real PCM file capture, normalizes the actual rate and removes its cache file', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { encodeVoiceWav } from ${JSON.stringify(import.meta.resolve('./voiceWav'))}
    const calls = []
    let outputOptions, callbackOptions, callback
    let sourceRate, destinationRate, sourceLength, outputLength
    const wav = encodeVoiceWav(new Float32Array(480).fill(0.25))
    new DataView(wav.buffer).setUint32(24, 48000, true)
    const lowPreset = { sampleRate:22050, bitDepth:0, bitRate:48000, iosQuality:1, flacCompressionLevel:0 }
    class Recorder {
      enableFileOutput(options) { outputOptions = options; return { status:'success' } }
      onAudioReady(options, handler) { callbackOptions = options; callback = handler; return { status:'success' } }
      clearOnAudioReady() { calls.push('clear-pcm') }
      onError() {}
      clearOnError() { calls.push('clear-error') }
      async start() { calls.push('start'); return { status:'success' } }
      async stop() { calls.push('stop'); return { status:'success',paths:['file:///fixture/voice.wav'] } }
    }
    class Offline {
      constructor(channels,length,rate) { outputLength = length; destinationRate = rate; this.destination = {} }
      createBuffer(channels,length,rate) { sourceLength = length; sourceRate = rate; return { copyToChannel(samples) { assert.equal(samples.length,length) } } }
      createBufferSource() { return { connect() {}, start() {} } }
      async startRendering() { return { getChannelData: () => new Float32Array(outputLength).fill(0.25) } }
    }
    const manager = {
      async checkRecordingPermissions() { return 'Granted' },
      async requestRecordingPermissions() { calls.push('permission'); return 'Granted' },
      setAudioSessionOptions(options) { assert.equal(options.iosCategory,'record') },
      async setAudioSessionActivity(value) { calls.push(value ? 'activate' : 'deactivate') },
      observeAudioInterruptions() {},
      addSystemEventListener() { return { remove() { calls.push('unsubscribe') } } },
    }
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Platform: { OS: 'ios' }, AppState: { currentState: 'active' },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-audio-api'))}, () => ({
      AudioManager:manager, AudioRecorder:Recorder, OfflineAudioContext:Offline,
      FileFormat:{Wav:0}, FilePreset:{Low:lowPreset}, BitDepth:{Bit16:0},
    }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-file-system'))}, () => ({
      File:class {
        exists = true
        size = wav.length
        constructor(path) { assert.equal(path,'file:///fixture/voice.wav') }
        async bytes() { calls.push('read'); return wav }
        delete() { calls.push('delete'); this.exists = false }
      },
    }))
    const {startVoiceRecording} = await import(${JSON.stringify(import.meta.resolve('./voiceRecorder.native'))})
    const capture = await startVoiceRecording({maxSeconds:120})
    assert.deepEqual(outputOptions,{format:0,channelCount:1,preset:{...lowPreset,sampleRate:16000,bitDepth:0}})
    assert.deepEqual(callbackOptions,{sampleRate:16000,bufferLength:1600,channelCount:1})
    callback({buffer:{numberOfChannels:1,sampleRate:16000,length:2,getChannelData:()=>new Float32Array([0.1,-0.1])},numFrames:2})
    assert.ok(Math.abs(capture.getLevel()-0.5)<0.001)
    const result = await capture.stop()
    assert.equal(sourceRate,48000)
    assert.equal(destinationRate,16000)
    assert.equal(sourceLength,480)
    assert.equal(result.seconds,0.01)
    assert.equal(result.wav.length,44+160*2)
    assert.equal(new DataView(result.wav.buffer).getUint32(24,true),16000)
    assert.ok(calls.indexOf('stop')<calls.indexOf('read'))
    assert.ok(calls.indexOf('deactivate')<calls.indexOf('read'))
    assert.equal(calls.filter(value=>value==='delete').length,1)
    assert.equal(calls.filter(value=>value==='unsubscribe').length,2)
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})

test('Android permission Activities preserve grant and denial, wait for foreground and remain cancellable', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const deferred = () => {
      let resolve, reject
      const promise = new Promise((done, fail) => { resolve = done; reject = fail })
      return { promise, resolve, reject }
    }
    const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
    const listeners = new Set()
    const app = {
      currentState: 'active',
      addEventListener(kind, listener) {
        assert.equal(kind, 'change')
        listeners.add(listener)
        return { remove: () => listeners.delete(listener) }
      },
    }
    const change = state => { app.currentState = state; for (const listener of [...listeners]) listener(state) }
    const calls = []
    let decision, requested, permission = 'Undetermined'
    const manager = {
      async checkRecordingPermissions() { calls.push('check'); return permission },
      requestRecordingPermissions() { calls.push('request'); requested.resolve(); return decision.promise },
      setAudioSessionOptions() {},
      async setAudioSessionActivity(active) { calls.push(active ? 'activate' : 'deactivate') },
      observeAudioInterruptions() {},
      addSystemEventListener() { return { remove() {} } },
    }
    class Recorder {
      constructor() { calls.push('create') }
      enableFileOutput() { return { status: 'success' } }
      onAudioReady() { return { status: 'success' } }
      onError() {}
      clearOnAudioReady() {}
      clearOnError() {}
      async start() { calls.push('start'); return { status: 'success' } }
      async stop() { calls.push('stop'); return { status: 'success', paths: [] } }
    }
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Platform: { OS: 'android' }, AppState: app }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-audio-api'))}, () => ({
      AudioManager: manager, AudioRecorder: Recorder,
      FileFormat: { Wav: 0 }, FilePreset: { Low: {} }, BitDepth: { Bit16: 0 },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-file-system'))}, () => ({ File: class {} }))
    const { startVoiceRecording } = await import(${JSON.stringify(import.meta.resolve('./voiceRecorder.native'))})
    for (const outcome of ['grant', 'grant-active-first', 'deny', 'request-error', 'cancel-prompt', 'cancel-foreground']) {
      calls.length = 0
      decision = deferred()
      requested = deferred()
      const abort = new AbortController()
      const prompts = []
      const started = startVoiceRecording({ maxSeconds: 120, signal: abort.signal, onPermissionRequest: pending => prompts.push(pending) })
      const settled = started.then(recording => ({ recording }), error => ({ error }))
      await requested.promise
      assert.deepEqual(prompts, [true], 'only an actual Android permission request defers background cancellation')
      change('background')
      if (outcome === 'cancel-prompt') abort.abort()
      if (outcome === 'grant-active-first') change('active')
      if (outcome === 'request-error') decision.reject(new Error('native permission request failed'))
      else decision.resolve(outcome === 'deny' ? 'Denied' : 'Granted')
      await tick()
      assert.deepEqual(prompts, [true, false])
      if (outcome !== 'grant-active-first') assert.equal(calls.includes('create'), false, 'the microphone cannot start behind the permission Activity')
      if (outcome === 'cancel-foreground') abort.abort()
      if (outcome.startsWith('cancel')) {
        assert.equal((await settled).error?.name, 'AbortError')
        assert.equal(listeners.size, 0, 'cancellation removes foreground observers')
        change('active')
        await tick()
        assert.equal(calls.includes('create'), false, 'returning cannot revive a cancelled recording')
      } else {
        change('active')
        const result = await settled
        if (outcome === 'deny' || outcome === 'request-error') {
          assert.equal(result.error?.code, outcome === 'deny' ? 'permission' : 'failed')
          if (outcome === 'request-error') assert.equal(result.error.message, 'native permission request failed')
          assert.equal(calls.includes('activate'), false)
        } else {
          assert.ok(result.recording)
          assert.equal(calls.filter(call => call === 'start').length, 1)
          assert.equal(listeners.size, 0)
          result.recording.cancel()
          await tick()
        }
      }
      assert.equal(listeners.size, 0)
    }
    permission = 'Granted'
    calls.length = 0
    const alreadyGranted = await startVoiceRecording({ maxSeconds: 120, onPermissionRequest() { throw new Error('Unexpected permission Activity') } })
    assert.equal(calls.includes('request'), false, 'an existing grant must not open another Android Activity')
    alreadyGranted.cancel()
    await tick()
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
