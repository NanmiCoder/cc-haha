/**
 * CLI `ComputerExecutor` implementation — Python bridge variant.
 *
 * Replaces the native Swift/Rust modules with a Python subprocess bridge
 * (pyautogui + mss + platform helpers). See `pythonBridge.ts` and
 * `runtime/{mac,win}_helper.py`.
 */

import type {
  ComputerExecutor,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from '../../vendor/computer-use-mcp/index.js'
import { API_RESIZE_PARAMS, targetImageSize } from '../../vendor/computer-use-mcp/index.js'
import { sleep } from '../sleep.js'
import {
  CLI_HOST_BUNDLE_ID,
  getCliComputerUseCapabilities,
  isComputerUseSupportedPlatform,
} from './common.js'
import { callPythonHelper } from './pythonBridge.js'

const SCREENSHOT_JPEG_QUALITY = 0.75
const MOVE_SETTLE_MS = 50
const hostBundleId =
  process.env.CC_HAHA_COMPUTER_USE_HOST_BUNDLE_ID || CLI_HOST_BUNDLE_ID

type PythonDisplayGeometry = DisplayGeometry

type PythonResolvePrepareCaptureResult = ResolvePrepareCaptureResult & {
  displayId?: number
}

function computeTargetDims(
  logicalW: number,
  logicalH: number,
  scaleFactor: number,
): [number, number] {
  const physW = Math.round(logicalW * scaleFactor)
  const physH = Math.round(logicalH * scaleFactor)
  return targetImageSize(physW, physH, API_RESIZE_PARAMS)
}

function normalizeDisplayGeometry(display: PythonDisplayGeometry): DisplayGeometry {
  return {
    ...display,
    displayId: display.displayId ?? display.id,
    label: display.label ?? display.name,
  }
}

async function readClipboardViaPbpaste(): Promise<string> {
  return callPythonHelper<string>('read_clipboard', {})
}

async function writeClipboardViaPbcopy(text: string): Promise<void> {
  await callPythonHelper('write_clipboard', { text })
}

async function readClipboard(): Promise<string> {
  if (process.platform === 'win32') {
    return callPythonHelper<string>('read_clipboard', {})
  }

  return readClipboardViaPbpaste()
}

async function writeClipboard(text: string): Promise<void> {
  if (process.platform === 'win32') {
    await callPythonHelper('write_clipboard', { text })
    return
  }

  await writeClipboardViaPbcopy(text)
}

async function typeViaClipboard(text: string): Promise<void> {
  let saved: string | undefined
  try {
    saved = await readClipboard()
  } catch {}

  try {
    await writeClipboard(text)
    if (process.platform === 'darwin') {
      // Give NSPasteboard a beat before paste, then keep the new contents
      // resident long enough for Electron/WebView fields to consume them.
      await sleep(40)
      await callPythonHelper('paste_clipboard', {})
      await sleep(180)
    } else {
      await callPythonHelper('key', {
        keySequence: 'ctrl+v',
        repeat: 1,
      })
      await sleep(100)
    }
  } finally {
    if (typeof saved === 'string') {
      try {
        await writeClipboard(saved)
      } catch {}
    }
  }
}

export function createCliExecutor(_opts: {
  getMouseAnimationEnabled: () => boolean
  getHideBeforeActionEnabled: () => boolean
}): ComputerExecutor {
  if (!isComputerUseSupportedPlatform()) {
    throw new Error(
      `createCliExecutor called on ${process.platform}. Computer control is only supported on macOS and Windows.`,
    )
  }

  return {
    capabilities: {
      ...getCliComputerUseCapabilities(),
      hostBundleId,
    },

    async prepareForAction(_allowlistBundleIds, _displayId): Promise<string[]> {
      return callPythonHelper('prepare_for_action', {})
    },

    async previewHideSet(_allowlistBundleIds, _displayId) {
      return callPythonHelper('preview_hide_set', {})
    },

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      return normalizeDisplayGeometry(await callPythonHelper('get_display_size', { displayId }))
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      const displays = await callPythonHelper<PythonDisplayGeometry[]>('list_displays', {})
      return displays.map(display => normalizeDisplayGeometry(display))
    },

    async findWindowDisplays(bundleIds: string[]) {
      return callPythonHelper('find_window_displays', { bundleIds })
    },

    async resolvePrepareCapture(opts): Promise<ResolvePrepareCaptureResult> {
      const display = await this.getDisplaySize(opts.preferredDisplayId)
      const [targetW, targetH] = computeTargetDims(display.width, display.height, display.scaleFactor)
      const result = await callPythonHelper<PythonResolvePrepareCaptureResult>('resolve_prepare_capture', {
        preferredDisplayId: opts.preferredDisplayId,
        targetWidth: targetW,
        targetHeight: targetH,
        jpegQuality: SCREENSHOT_JPEG_QUALITY,
      })
      return {
        ...result,
        display: normalizeDisplayGeometry(result.display),
        resolvedDisplayId: result.resolvedDisplayId ?? result.displayId,
      }
    },

    async screenshot(opts): Promise<ScreenshotResult> {
      const display = await this.getDisplaySize(opts.displayId)
      const [targetW, targetH] = computeTargetDims(display.width, display.height, display.scaleFactor)
      const result = await callPythonHelper<ScreenshotResult>('screenshot', {
        displayId: opts.displayId,
        targetWidth: targetW,
        targetHeight: targetH,
        jpegQuality: SCREENSHOT_JPEG_QUALITY,
      })
      return result
    },

    async zoom(regionLogical, _allowedBundleIds, displayId) {
      const display = await this.getDisplaySize(displayId)
      const [outW, outH] = computeTargetDims(regionLogical.w, regionLogical.h, display.scaleFactor)
      return callPythonHelper('zoom', {
        x: regionLogical.x,
        y: regionLogical.y,
        width: regionLogical.w,
        height: regionLogical.h,
        targetWidth: outW,
        targetHeight: outH,
      })
    },

    async key(keySequence: string, repeat?: number): Promise<void> {
      await callPythonHelper('key', { keySequence, repeat: repeat ?? 1 })
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      await callPythonHelper('hold_key', { keyNames, durationMs })
    },

    async type(text: string, opts2: { viaClipboard: boolean }): Promise<void> {
      if (opts2.viaClipboard) {
        await typeViaClipboard(text)
        return
      }
      await callPythonHelper('type', { text })
    },

    readClipboard,
    writeClipboard,

    async click(x, y, button, count, modifiers): Promise<void> {
      await callPythonHelper('click', { x, y, button, count, modifiers })
      await sleep(MOVE_SETTLE_MS)
    },

    async mouseDown(): Promise<void> {
      await callPythonHelper('mouse_down', {})
    },

    async mouseUp(): Promise<void> {
      await callPythonHelper('mouse_up', {})
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return callPythonHelper('cursor_position', {})
    },

    async drag(from, to): Promise<void> {
      await callPythonHelper('drag', { from, to })
      await sleep(MOVE_SETTLE_MS)
    },

    async moveMouse(x, y): Promise<void> {
      await callPythonHelper('move_mouse', { x, y })
      await sleep(MOVE_SETTLE_MS)
    },

    async scroll(x, y, dx, dy): Promise<void> {
      await callPythonHelper('scroll', { x, y, deltaX: dx, deltaY: dy })
    },

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      return callPythonHelper('frontmost_app', {})
    },

    async appUnderPoint(x, y) {
      return callPythonHelper('app_under_point', { x, y })
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      return callPythonHelper('list_installed_apps', {})
    },

    async listRunningApps(): Promise<RunningApp[]> {
      return callPythonHelper('list_running_apps', {})
    },

    async openApp(bundleId: string): Promise<void> {
      await callPythonHelper('open_app', { bundleId })
    },
  }
}

export async function unhideComputerUseApps(_bundleIds: readonly string[]): Promise<void> {
  return
}
