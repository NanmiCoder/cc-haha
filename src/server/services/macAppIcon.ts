import { readdir, rm, mkdtemp, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LRUCache } from 'lru-cache'

/**
 * Render a macOS application's bundle icon as PNG bytes.
 *
 * This is the same extraction macOS itself performs for a Finder listing:
 * `Info.plist` names the icon in `CFBundleIconFile`, the file lives in
 * `Contents/Resources`, and `sips` rasterises the multi-resolution `.icns` to a
 * single PNG. `openTargetService` does this too, but only for its fixed table of
 * IDE targets — its resolver is keyed on a `TargetDefinition` (it also tries
 * `<label>.icns` / `<icon>.icns`), so it cannot answer for an arbitrary
 * installed app. This module takes only a bundle path.
 *
 * Everything is injectable because the real implementation shells out to
 * `plutil` and `sips`; tests drive the resolution order without either.
 */

export type MacAppIconDeps = {
  /** `CFBundleIconFile` from the bundle's Info.plist, or null when absent. */
  readIconFileName?: (appPath: string) => Promise<string | null>
  /** File names directly inside `Contents/Resources`. */
  listResourceFiles?: (resourcesPath: string) => Promise<string[]>
  pathExists?: (candidate: string) => Promise<boolean>
  convertToPng?: (iconPath: string, size: number) => Promise<Uint8Array>
}

/** Icons are a few KB each; the cap bounds a machine with many applications. */
const iconCache = new LRUCache<string, Uint8Array>({ max: 512 })

export const MIN_ICON_SIZE = 16
export const MAX_ICON_SIZE = 256
export const DEFAULT_ICON_SIZE = 64

export function normalizeIconSize(raw: unknown): number {
  // `searchParams.get` yields null when the caller omits `size`, and `Number`
  // maps both null and '' to 0 — clamping that would silently serve a 16px
  // icon instead of the default. Absent means default, not smallest.
  if (raw === null || raw === undefined || raw === '') return DEFAULT_ICON_SIZE
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_ICON_SIZE
  return Math.min(MAX_ICON_SIZE, Math.max(MIN_ICON_SIZE, Math.round(parsed)))
}

/**
 * `CFBundleIconFile` is allowed to omit the extension ("AppIcon" means
 * "AppIcon.icns"), and some bundles store it with one. Both spellings appear in
 * the wild, so normalise before probing the filesystem.
 */
export function normalizeIconFileName(iconFile: string): string {
  const trimmed = iconFile.trim()
  if (!trimmed) return ''
  return path.posix.extname(trimmed) ? trimmed : `${trimmed}.icns`
}

async function defaultPathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

async function defaultReadIconFileName(appPath: string): Promise<string | null> {
  const plistPath = path.posix.join(appPath, 'Contents', 'Info.plist')
  try {
    const proc = Bun.spawn(
      ['/usr/bin/plutil', '-extract', 'CFBundleIconFile', 'raw', '-o', '-', plistPath],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const stdout = await new Response(proc.stdout).text()
    if (await proc.exited !== 0) return null
    const value = stdout.trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

async function defaultListResourceFiles(resourcesPath: string): Promise<string[]> {
  try {
    return await readdir(resourcesPath)
  } catch {
    return []
  }
}

async function defaultConvertToPng(iconPath: string, size: number): Promise<Uint8Array> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cc-haha-cu-app-icon-'))
  const outputPath = path.join(tmpRoot, 'icon.png')
  try {
    const proc = Bun.spawn(
      [
        '/usr/bin/sips',
        '-z', String(size), String(size),
        '-s', 'format', 'png',
        iconPath,
        '--out', outputPath,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    if (await proc.exited !== 0) {
      throw new Error(`sips failed for ${iconPath}`)
    }
    return new Uint8Array(await readFile(outputPath))
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

/**
 * Locate the bundle's icon file. Returns null rather than throwing when a
 * bundle simply has no icon — the caller renders a letter placeholder then.
 */
export async function resolveAppIconPath(
  appPath: string,
  deps: MacAppIconDeps = {},
): Promise<string | null> {
  const readIconFileName = deps.readIconFileName ?? defaultReadIconFileName
  const listResourceFiles = deps.listResourceFiles ?? defaultListResourceFiles
  const pathExists = deps.pathExists ?? defaultPathExists

  const resourcesPath = path.posix.join(appPath, 'Contents', 'Resources')

  const declared = await readIconFileName(appPath)
  if (declared) {
    const candidate = path.posix.join(resourcesPath, normalizeIconFileName(declared))
    if (await pathExists(candidate)) return candidate
  }

  // Bundles that declare no icon (or declare a missing one) usually still ship
  // exactly one .icns. Document-type icons are excluded: picking one would show
  // a file badge where the app's own mark belongs.
  const resourceFiles = await listResourceFiles(resourcesPath)
  const fallback = resourceFiles
    .filter(name => name.toLowerCase().endsWith('.icns'))
    .find(name => !/document/i.test(name))
  if (!fallback) return null

  const fallbackPath = path.posix.join(resourcesPath, fallback)
  return await pathExists(fallbackPath) ? fallbackPath : null
}

/**
 * PNG bytes for an application's icon, or null when the bundle has none.
 * Results are cached per (bundle path, size) — rasterising is a subprocess, and
 * the picker asks for hundreds of icons while the user scrolls.
 */
export async function readAppIconPng(
  appPath: string,
  size: number,
  deps: MacAppIconDeps = {},
): Promise<Uint8Array | null> {
  const normalizedSize = normalizeIconSize(size)
  const cacheKey = `${appPath}:${normalizedSize}`
  const cached = iconCache.get(cacheKey)
  if (cached) return cached

  const iconPath = await resolveAppIconPath(appPath, deps)
  if (!iconPath) return null

  const convertToPng = deps.convertToPng ?? defaultConvertToPng
  try {
    const png = await convertToPng(iconPath, normalizedSize)
    iconCache.set(cacheKey, png)
    return png
  } catch {
    // A malformed or unreadable .icns is not an error worth surfacing: the row
    // falls back to its letter placeholder exactly as if there were no icon.
    return null
  }
}

/** Test hook: drop cached icons so a test cannot observe another test's bytes. */
export function __resetMacAppIconCacheForTests(): void {
  iconCache.clear()
}
