import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const ALLOWED_SYSTEM_SETTINGS_URLS = new Set([
  'ms-settings:notifications',
  'x-apple.systempreferences:com.apple.preference.notifications',
])
const BLOCKED_EXECUTABLE_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.exe',
  '.msi',
  '.ps1',
  '.scr',
  '.sh',
])

export function normalizeExternalUrl(target: string): string {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error('External shell targets must be absolute URLs')
  }

  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Unsupported external URL scheme: ${url.protocol}`)
  }
  return url.toString()
}

/**
 * Expands a leading tilde to the home directory. `~\` is only a tilde path on
 * Windows — on POSIX the backslash is a valid filename character.
 */
export function expandTildePath(target: string, platform: NodeJS.Platform = process.platform): string {
  if (
    target === '~' ||
    target.startsWith('~/') ||
    (platform === 'win32' && target.startsWith('~\\'))
  ) {
    return homedir() + target.slice(1)
  }
  return target
}

export function normalizeOpenPath(target: string): string {
  const filePath = expandTildePath(
    target.startsWith('file://') ? fileURLToPath(target) : target,
  )
  if (!path.isAbsolute(filePath)) {
    throw new Error('System file paths must be absolute')
  }
  const realPath = realpathSync(filePath)
  const stat = statSync(realPath)
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error('System file paths must point to a file or directory')
  }
  if (isBlockedExecutablePath(realPath, stat.isDirectory())) {
    throw new Error('System file paths must not point to executable apps or scripts')
  }
  return realPath
}

function isBlockedExecutablePath(realPath: string, isDirectory: boolean) {
  const ext = path.extname(realPath).toLowerCase()
  if (BLOCKED_EXECUTABLE_EXTENSIONS.has(ext)) return true
  if (isDirectory) return false
  if (process.platform === 'win32') return false
  return (statSync(realPath).mode & 0o111) !== 0
}

export async function openExternalUrl(target: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(normalizeExternalUrl(target))
}

export function normalizeSystemSettingsUrl(target: string): string {
  if (!ALLOWED_SYSTEM_SETTINGS_URLS.has(target)) {
    throw new Error(`Unsupported system settings URL: ${target}`)
  }
  return target
}

export async function openSystemSettingsUrl(target: string): Promise<boolean> {
  const { shell } = await import('electron')
  await shell.openExternal(normalizeSystemSettingsUrl(target))
  return true
}

export async function openSystemPath(target: string): Promise<void> {
  const { shell } = await import('electron')
  const error = await shell.openPath(normalizeOpenPath(target))
  if (error) throw new Error(error)
}
