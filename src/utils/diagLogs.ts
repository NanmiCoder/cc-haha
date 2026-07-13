import { basename, dirname } from 'path'
import { getFsImplementation } from './fsOperations.js'
import { jsonStringify } from './slowOperations.js'

type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error'

type DiagnosticLogEntry = {
  timestamp: string
  level: DiagnosticLogLevel
  event: string
  data: Record<string, unknown>
}

const MAX_SEGMENT_BYTES = 1024 * 1024
const MAX_COMPLETED_SEGMENTS = 4
let segmentSequence = 0

/**
 * Logs diagnostic information to a logfile. This information is sent
 * via the environment manager to session-ingress to monitor issues from
 * within the container.
 *
 * *Important* - this function MUST NOT be called with any PII, including
 * file paths, project names, repo names, prompts, etc.
 *
 * @param level    Log level. Only used for information, not filtering
 * @param event    A specific event: "started", "mcp_connected", etc.
 * @param data     Optional additional data to log
 */
// sync IO: called from sync context
export function logForDiagnosticsNoPII(
  level: DiagnosticLogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  const baseLogFile = getDiagnosticLogFile()
  if (!baseLogFile) {
    return
  }

  const entry: DiagnosticLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    data: data ?? {},
  }

  const fs = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  const logFile = `${baseLogFile}.${process.pid}.current.jsonl`
  try {
    rotateOwnedSegmentIfNeeded(fs, baseLogFile, logFile, Buffer.byteLength(line))
    fs.appendFileSync(logFile, line)
  } catch {
    // If append fails, try creating the directory first
    try {
      fs.mkdirSync(dirname(logFile))
      rotateOwnedSegmentIfNeeded(fs, baseLogFile, logFile, Buffer.byteLength(line))
      fs.appendFileSync(logFile, line)
    } catch {
      // Silently fail if logging is not possible
    }
  }
}

function rotateOwnedSegmentIfNeeded(
  fs: ReturnType<typeof getFsImplementation>,
  baseLogFile: string,
  activeLogFile: string,
  incomingBytes: number,
): void {
  if (!fs.existsSync(activeLogFile)) return
  if (fs.statSync(activeLogFile).size + incomingBytes <= MAX_SEGMENT_BYTES) return
  segmentSequence += 1
  const completedPath = `${baseLogFile}.${process.pid}.${Date.now()}-${segmentSequence}.jsonl`
  fs.renameSync(activeLogFile, completedPath)
  const prefix = `${basename(baseLogFile)}.${process.pid}.`
  const completed = fs.readdirStringSync(dirname(baseLogFile))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl') && !name.endsWith('.current.jsonl'))
    .sort()
  for (const staleName of completed.slice(0, -MAX_COMPLETED_SEGMENTS)) {
    fs.unlinkSync(`${dirname(baseLogFile)}/${staleName}`)
  }
}

function getDiagnosticLogFile(): string | undefined {
  return process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
}

/**
 * Wraps an async function with diagnostic timing logs.
 * Logs `{event}_started` before execution and `{event}_completed` after with duration_ms.
 *
 * @param event   Event name prefix (e.g., "git_status" -> logs "git_status_started" and "git_status_completed")
 * @param fn      Async function to execute and time
 * @param getData Optional function to extract additional data from the result for the completion log
 * @returns       The result of the wrapped function
 */
export async function withDiagnosticsTiming<T>(
  event: string,
  fn: () => Promise<T>,
  getData?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const startTime = Date.now()
  logForDiagnosticsNoPII('info', `${event}_started`)

  try {
    const result = await fn()
    const additionalData = getData ? getData(result) : {}
    logForDiagnosticsNoPII('info', `${event}_completed`, {
      duration_ms: Date.now() - startTime,
      ...additionalData,
    })
    return result
  } catch (error) {
    logForDiagnosticsNoPII('error', `${event}_failed`, {
      duration_ms: Date.now() - startTime,
    })
    throw error
  }
}
