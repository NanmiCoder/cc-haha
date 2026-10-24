import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'

const placeholderTypes = new Set(['session-meta', 'custom-title', 'ai-title', 'file-history-snapshot'])
const sessionUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type PlaceholderOptions = {
  configDir: string
  sessionId: string
  workDir: string
  filePath?: string
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function readPlaceholder(file: string): Promise<Buffer | null> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try { stat = await fs.lstat(file) } catch (error) {
    if (missing(error)) return null
    throw error
  }
  if (!stat.isFile()) throw new Error('Agent SDK startup requires a regular placeholder file')
  const contents = await fs.readFile(file)
  for (const line of contents.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch {
      throw new Error('Agent SDK startup cannot move a malformed session placeholder')
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !placeholderTypes.has((entry as { type?: string }).type ?? '') ||
      (entry as { message?: unknown }).message !== undefined) {
      throw new Error('Agent SDK startup cannot move a session containing conversation or unsupported records')
    }
  }
  return contents
}

async function sameFile(first: string, second: string): Promise<boolean> {
  const [left, right] = await Promise.all([fs.lstat(first), fs.lstat(second)])
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
}

/**
 * The native SDK reserves --session-id by checking the project's JSONL path.
 * Keep the desktop's metadata-only placeholder discoverable in another project
 * directory until native initialization has completed. It remains ordinary
 * JSONL so an interrupted launch can recover through the normal session reader.
 */
export async function prepareOfficialAgentSdkPlaceholder(
  options: PlaceholderOptions,
): Promise<() => Promise<void>> {
  if (!sessionUuid.test(options.sessionId)) throw new Error('Invalid Agent SDK session identifier')
  const projects = path.resolve(options.configDir, 'projects')
  const canonical = path.join(projects, sanitizePath(options.workDir), `${options.sessionId}.jsonl`)
  const staged = path.join(projects, 'cc-haha-sdk-startup', `${options.sessionId}.jsonl`)
  const source = path.resolve(options.filePath ?? canonical)
  const relative = path.relative(projects, source).split(path.sep)
  if (relative.length !== 2 || relative[0] === '..' || relative[1] !== `${options.sessionId}.jsonl`) {
    throw new Error('Agent SDK placeholder is outside the session projects directory')
  }

  const contents = await readPlaceholder(source)
  const pending = source === staged ? contents : await readPlaceholder(staged)
  if (contents === null && pending === null) return async () => {}
  if (source !== staged && contents !== null) {
    await fs.mkdir(path.dirname(staged), { recursive: true })
    if (pending !== null && !await sameFile(source, staged)) {
      throw new Error('Agent SDK startup found two different pending placeholders; both were preserved')
    }
    if (pending === null) {
      // link/unlink is a no-clobber move on the same config filesystem. A
      // rename could silently overwrite another launch's recoverable metadata.
      await fs.link(source, staged)
    }
    await fs.unlink(source)
  }

  let restored = false
  let appended = false
  let inFlight: Promise<void> | undefined
  async function restoreOnce(): Promise<void> {
    await fs.mkdir(path.dirname(canonical), { recursive: true })
    if (!appended) {
      // Read after initialization, not at prepare time: title/runtime updates
      // written through the normal reader while staged must survive too.
      const latest = await readPlaceholder(staged)
      if (latest === null) throw new Error('The staged Agent SDK placeholder disappeared before restoration')
      try {
        await fs.link(staged, canonical)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!await sameFile(staged, canonical)) {
          const target = await fs.lstat(canonical)
          if (!target.isFile()) throw new Error('Agent SDK transcript is not a regular file')
          // A native runtime may already have written messages. Append metadata
          // without replacing that transcript or keeping only a stale snapshot.
          const handle = await fs.open(canonical, 'a+')
          try {
            const { size } = await handle.stat()
            const last = Buffer.alloc(1)
            if (size > 0) await handle.read(last, 0, 1, size - 1)
            const prefix = size > 0 && last[0] !== 10 ? '\n' : ''
            const suffix = latest.length > 0 && latest[latest.length - 1] !== 10 ? '\n' : ''
            await handle.writeFile(Buffer.concat([Buffer.from(prefix), latest, Buffer.from(suffix)]))
          } finally { await handle.close() }
        }
      }
      appended = true
    }
    // If unlink fails, a retry removes the staging link without appending twice.
    await fs.unlink(staged)
    restored = true
  }

  return () => {
    if (restored) return Promise.resolve()
    if (!inFlight) {
      inFlight = restoreOnce().finally(() => { inFlight = undefined })
    }
    return inFlight
  }
}
