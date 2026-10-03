import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'

export type StorageRelocations = {
  version: 1
  previousRoots: string[]
  [key: string]: unknown
}

export const MANAGED_ATTACHMENT_PREFIXES = [
  'uploads',
  'image-cache',
  'im-downloads',
  'cc-haha/generated-images',
] as const

export function activeStorageRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function readStorageRelocations(configDir = activeStorageRoot()): StorageRelocations {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(configDir, 'cc-haha', 'storage-relocations.json'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, previousRoots: [] }
    throw new Error('Cannot read storage relocation metadata', { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid storage relocation metadata')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.previousRoots) ||
    !record.previousRoots.every(root => typeof root === 'string' && root.length > 0 &&
      !root.includes('\0') && (process.platform === 'win32' ? win32 : posix).isAbsolute(root))) {
    throw new Error('Unsupported or invalid storage relocation metadata')
  }
  return record as StorageRelocations
}

/** Resolve only app-owned attachment locations. Project files and transcript text stay unchanged. */
export function mapRelocatedAttachmentPath(
  inputPath: string,
  configDir: string,
  previousRoots: readonly string[],
  platform: string = process.platform,
): string {
  const paths = platform === 'win32' ? win32 : posix
  if (!paths.isAbsolute(inputPath) || inputPath.includes('\0')) return inputPath
  const normalized = paths.normalize(inputPath).normalize('NFC')
  for (const root of previousRoots) {
    const relativePath = paths.relative(paths.normalize(root).normalize('NFC'), normalized)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${paths.sep}`) || paths.isAbsolute(relativePath)) continue
    const comparable = relativePath.replaceAll('\\', '/')
    const matchingPath = platform === 'win32' ? comparable.toLowerCase() : comparable
    if (MANAGED_ATTACHMENT_PREFIXES.some(prefix => matchingPath.startsWith(`${prefix}/`))) {
      return paths.join(configDir, relativePath).normalize('NFC')
    }
  }
  return inputPath
}

export function resolveRelocatedAttachmentPath(inputPath: string, configDir = activeStorageRoot()): string {
  return mapRelocatedAttachmentPath(inputPath, configDir, readStorageRelocations(configDir).previousRoots)
}
