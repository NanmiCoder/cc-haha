import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Writes a sherpa-onnx-node stand-in at the path the worker loads it from
 * (`<root>/node_modules/sherpa-onnx-node/sherpa-onnx.js`). SenseVoice transcripts
 * read `<language>:<sample count>`; the LLM engines prefix the engine section
 * they were configured with (`qwen3Asr/auto:16000`).
 */
export async function installFakeSherpa(root: string): Promise<void> {
  const packageDir = join(root, 'node_modules', 'sherpa-onnx-node')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'sherpa-onnx.js'), `
    let language = 'auto'
    let engine = 'senseVoice'
    class OfflineRecognizer {
      constructor(config) {
        this.config = config
        engine = ['senseVoice', 'funasrNano', 'qwen3Asr'].find(key => config.modelConfig[key])
      }
      createStream() { return { samples: 0, acceptWaveform(a) { this.samples += a.samples.length } } }
      setConfig(config) { language = config.modelConfig.senseVoice.language }
      decode() {}
      getResult(stream) { return { text: (engine === 'senseVoice' ? '' : engine + '/') + language + ':' + stream.samples } }
    }
    class Vad {
      constructor() { this.parts = []; this.ready = [] }
      acceptWaveform(samples) { this.parts.push(samples.length) }
      isEmpty() { return this.ready.length === 0 }
      front() { return { samples: new Float32Array(this.ready[0]) } }
      pop() { this.ready.shift() }
      reset() { this.parts = []; this.ready = [] }
      flush() { this.ready.push(this.parts.reduce((a, b) => a + b, 0)) }
    }
    module.exports = { OfflineRecognizer, Vad }
  `)
}
