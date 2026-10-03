/**
 * Keeps the native window background in step with the theme the renderer
 * settled on.
 *
 * A BrowserWindow paints `backgroundColor` before the renderer has produced a
 * frame, so a dark-theme user gets a white flash on every launch unless we
 * know the theme up front. The renderer's choice lives in its own
 * localStorage, which the main process cannot read, so the last applied
 * appearance is cached in a small file next to window-state and used to seed
 * the next launch.
 *
 * ── Why this deliberately does NOT touch `nativeTheme.themeSource` ──
 *
 * Pinning it to the user's fixed theme is tempting: it would make context
 * menus, devtools and the macOS window frame agree with the app. It was tried
 * and reverted, because `themeSource` is a process-wide override with two
 * consequences that outweigh that polish:
 *
 * 1. It overrides `prefers-color-scheme` in every renderer — which is exactly
 *    the signal "follow the system" is built on. Pinned to `'light'`, the
 *    moment a user switches the toggle back on, the renderer resolves against
 *    the *pinned* value rather than the real OS setting and lands on the wrong
 *    theme until an async IPC round-trip unpins it.
 * 2. It leaks out of the app: the preview WebContentsView loads arbitrary
 *    third-party sites, and a user on a fixed light theme would force every
 *    previewed page light too.
 *
 * Leaving it at Electron's `'system'` default keeps `prefers-color-scheme`
 * truthful everywhere and matches the behaviour that shipped before this
 * feature. Do not reintroduce the pin without solving both points above.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { areStorageWritesFrozen } from './storageMaintenance'
import type { App, BrowserWindow } from 'electron'

export const APPEARANCE_STATE_FILE = 'appearance-state.json'

/**
 * Grounds used before the renderer has reported anything — the defaults of
 * each half. Pinned to THEME_BACKGROUNDS by nativeAppearance.test.ts.
 */
export const LIGHT_WINDOW_BACKGROUND = '#FFFFFF'
export const DARK_WINDOW_BACKGROUND = '#201D17'

export type AppliedAppearance = {
  isDark: boolean
  background: string
  /**
   * Background of the light theme the user picked, so a launch that follows
   * the system into its light half repaints the theme they actually use
   * rather than defaulting to pure white.
   */
  lightBackground: string
  followSystem: boolean
}

type StoredAppearance = AppliedAppearance

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

// Matches windows.ts / petWindow.ts, the other two writers into ~/.claude: on a
// read-only or full disk this is written on every theme change, and an
// undeduplicated error would repeat forever.
const failedAppearanceWritePaths = new Set<string>()

export function appearanceStatePath(app: App, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(
    env.CLAUDE_CONFIG_DIR || path.join(app.getPath('home'), '.claude'),
    APPEARANCE_STATE_FILE,
  )
}

export function isAppliedAppearance(value: unknown): value is AppliedAppearance {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.isDark === 'boolean'
    && typeof candidate.followSystem === 'boolean'
    && typeof candidate.background === 'string'
    && HEX_COLOR.test(candidate.background)
    && typeof candidate.lightBackground === 'string'
    && HEX_COLOR.test(candidate.lightBackground)
}

export function readAppearanceState(app: App, env: NodeJS.ProcessEnv = process.env): StoredAppearance | null {
  const statePath = appearanceStatePath(app, env)
  if (!existsSync(statePath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf-8'))
    return isAppliedAppearance(parsed) ? parsed : null
  } catch (error) {
    console.error(`[desktop] failed to read appearance state ${statePath}:`, error)
    return null
  }
}

export function writeAppearanceState(
  app: App,
  state: AppliedAppearance,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (areStorageWritesFrozen() || !isAppliedAppearance(state)) return
  const statePath = appearanceStatePath(app, env)
  try {
    mkdirSync(path.dirname(statePath), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
    failedAppearanceWritePaths.delete(statePath)
  } catch (error) {
    if (!failedAppearanceWritePaths.has(statePath)) {
      failedAppearanceWritePaths.add(statePath)
      console.error(`[desktop] failed to write appearance state ${statePath}:`, error)
    }
  }
}

/**
 * Background to paint a window with before the renderer has drawn anything.
 *
 * A cached state that follows the system is re-resolved against the OS as it
 * is *now* — the user may have flipped appearance while the app was closed —
 * while a fixed pick is replayed verbatim.
 */
export function startupWindowBackground(
  cached: StoredAppearance | null,
  systemPrefersDark: boolean,
): string {
  if (!cached) return systemPrefersDark ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND
  if (!cached.followSystem) return cached.background
  if (systemPrefersDark) return DARK_WINDOW_BACKGROUND
  // Light half of a follow-the-system setup. `background` is whatever was on
  // screen when the cache was written — dark, if the app was closed at night —
  // so the light theme is carried separately rather than falling back to white.
  return cached.lightBackground
}

export type AppearanceSyncDeps = {
  app: App
  windows: () => BrowserWindow[]
  env?: NodeJS.ProcessEnv
}

/**
 * Apply a renderer-reported appearance to the native windows and cache it for
 * the next launch. Deliberately does not touch `nativeTheme.themeSource` —
 * see the note at the top of this file.
 */
export function applyAppliedAppearance(
  state: AppliedAppearance,
  { app, windows, env = process.env }: AppearanceSyncDeps,
): void {
  for (const window of windows()) {
    if (window.isDestroyed()) continue
    window.setBackgroundColor(state.background)
  }
  writeAppearanceState(app, state, env)
}
