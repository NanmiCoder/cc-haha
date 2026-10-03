/** Exercises the production relaunch path without a real model or user state. */
import { readFile } from 'node:fs/promises'
import { SenseVoiceRecognizer } from '../recognizer.js'
import type { WorkerConfig } from '../protocol.js'
import { runVoiceWorker } from '../worker.js'
import { makeWav } from './wav.js'

if (process.argv[2] === '--voice-worker') {
  await runVoiceWorker()
} else {
  const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as WorkerConfig
  const recognizer = new SenseVoiceRecognizer({
    workerConfig: () => config,
    cwd: config.runtimeRoot,
    startupTimeoutMs: 2000,
  })
  try {
    console.log(JSON.stringify(await recognizer.transcribe(makeWav(1), 'zh', new AbortController().signal)))
    console.log(JSON.stringify(await recognizer.transcribe(makeWav(0.5), 'en', new AbortController().signal)))
  } finally {
    await recognizer.dispose()
  }
}
