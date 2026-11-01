/** Development entry for the local speech worker; packaged builds use `claude-sidecar --voice-worker`. */
import { runVoiceWorker } from './worker.js'

try {
  await runVoiceWorker()
  process.exit(0)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
}
