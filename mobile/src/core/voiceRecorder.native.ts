import { AppState, Platform } from 'react-native'
import { createNativeVoiceRecording, type NativeVoiceRuntime } from './voiceRecorderNative'
import { MAX_CAPTURE_FILE_BYTES, VOICE_SAMPLE_RATE } from './voiceWav'
import { voiceAbortError, VoiceRecorderError, type StartVoiceRecordingOptions } from './voiceRecorderTypes'

export * from './voiceRecorderTypes'

export function isVoiceCaptureSupported(): boolean {
  return true
}

function waitForForeground(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(voiceAbortError())
  if (AppState.currentState === 'active') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      listener.remove()
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(voiceAbortError())
    }
    const listener = AppState.addEventListener('change', next => {
      if (next === 'active') {
        cleanup()
        resolve()
      }
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    else if (AppState.currentState === 'active') {
      cleanup()
      resolve()
    }
  })
}

async function loadRuntime(options: StartVoiceRecordingOptions): Promise<NativeVoiceRuntime> {
  let audio: typeof import('react-native-audio-api')
  try {
    audio = await import('react-native-audio-api')
  } catch {
    throw new VoiceRecorderError('unavailable', '请更新手机 App 以使用语音输入')
  }
  const { File } = await import('expo-file-system')
  const { AudioManager } = audio
  return {
    requestPermission: async () => {
      let status = await AudioManager.checkRecordingPermissions()
      if (options.signal?.aborted) throw voiceAbortError()
      if (status !== 'Granted') {
        const android = Platform.OS === 'android'
        if (android) options.onPermissionRequest?.(true)
        try {
          status = await AudioManager.requestRecordingPermissions()
        } finally {
          if (android) options.onPermissionRequest?.(false)
        }
      }
      if (status === 'Granted' && Platform.OS === 'android') await waitForForeground(options.signal)
      return status === 'Granted'
    },
    activate: async () => {
      AudioManager.setAudioSessionOptions({ iosCategory: 'record', iosMode: 'measurement', iosOptions: ['allowBluetoothHFP'] })
      await AudioManager.setAudioSessionActivity(true)
    },
    deactivate: () => AudioManager.setAudioSessionActivity(false),
    createRecorder: () => {
      const recorder = new audio.AudioRecorder()
      return {
        enableFileOutput: () => recorder.enableFileOutput({
          format: audio.FileFormat.Wav,
          channelCount: 1,
          preset: { ...audio.FilePreset.Low, sampleRate: VOICE_SAMPLE_RATE, bitDepth: audio.BitDepth.Bit16 },
        }),
        start: () => recorder.start(),
        stop: () => recorder.stop(),
        onAudioReady: callback => recorder.onAudioReady({ sampleRate: VOICE_SAMPLE_RATE, bufferLength: 1600, channelCount: 1 }, event => callback(event.buffer, event.numFrames)),
        clearOnAudioReady: () => recorder.clearOnAudioReady(),
        onError: callback => recorder.onError(callback),
        clearOnError: () => recorder.clearOnError(),
      }
    },
    observeInterruptions: callback => {
      AudioManager.observeAudioInterruptions(true)
      const interruption = AudioManager.addSystemEventListener('interruption', event => { if (event.type === 'began') callback() })
      const route = AudioManager.addSystemEventListener('routeChange', event => {
        if (event.reason === 'OldDeviceUnavailable' || event.reason === 'NoSuitableRouteForCategory') callback()
      })
      return () => {
        interruption?.remove()
        route?.remove()
        AudioManager.observeAudioInterruptions(false)
      }
    },
    readRecording: async path => {
      const file = new File(path)
      if (file.size > MAX_CAPTURE_FILE_BYTES) throw new VoiceRecorderError('failed', 'Recorded audio is too large')
      return file.bytes()
    },
    deleteRecording: path => {
      const file = new File(path)
      if (file.exists) file.delete()
    },
    resample: async (samples, sourceRate, targetRate) => {
      const context = new audio.OfflineAudioContext(1, Math.max(1, Math.ceil(samples.length * targetRate / sourceRate)), targetRate)
      const buffer = context.createBuffer(1, samples.length, sourceRate)
      buffer.copyToChannel(Float32Array.from(samples), 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.start(0)
      const converted = await context.startRendering()
      return converted.getChannelData(0).slice()
    },
  }
}

export async function startVoiceRecording(options: StartVoiceRecordingOptions) {
  if (options.signal?.aborted) {
    const error = new Error('Recording cancelled')
    error.name = 'AbortError'
    throw error
  }
  return createNativeVoiceRecording(options, await loadRuntime(options))
}
