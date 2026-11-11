/**
 * `verified.json`: proof that installed files passed their digest check.
 *
 * Readiness never re-hashes the 240 MB model. A file counts as installed while
 * it exists with the size recorded right after verification. mtime is ignored on
 * purpose: backups, copies and sync tools rewrite it on intact files.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface VerifiedFile {
  /** Forward-slash path relative to the provider base directory. */
  name: string
  bytes: number
  sha256: string
}

interface Manifest {
  version: 1
  files: VerifiedFile[]
}

export async function readManifest(path: string): Promise<VerifiedFile[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Manifest>
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) return []
    return parsed.files.filter((file): file is VerifiedFile =>
      typeof file?.name === 'string'
      && Number.isFinite(file.bytes)
      && typeof file.sha256 === 'string')
  } catch {
    return []
  }
}

/** Replaces entries by name; other entries survive. Written atomically. */
export async function recordVerified(path: string, entries: VerifiedFile[]): Promise<void> {
  const names = new Set(entries.map(entry => entry.name))
  const kept = (await readManifest(path)).filter(file => !names.has(file.name))
  const manifest: Manifest = { version: 1, files: [...kept, ...entries] }
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(temp, path)
}

export async function forgetVerified(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** True when the recorded entry still describes the file on disk. */
export async function matchesRecord(
  entry: VerifiedFile | undefined,
  filePath: string,
  expectedBytes?: number,
): Promise<boolean> {
  if (!entry) return false
  if (expectedBytes !== undefined && entry.bytes !== expectedBytes) return false
  try {
    const info = await stat(filePath)
    return info.isFile() && info.size === entry.bytes
  } catch {
    return false
  }
}

export async function describeFile(name: string, filePath: string, sha256?: string): Promise<VerifiedFile> {
  const info = await stat(filePath)
  return {
    name,
    bytes: info.size,
    sha256: sha256 ?? await hashFile(filePath),
  }
}

export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}
