/**
 * CLI `ComputerExecutor` implementation — platform-routed helper variant.
 *
 * Every command goes through `helperBridge.callHelper`, which routes by
 * platform: macOS reaches the signed native `cu-helper` daemon, Windows
 * reaches the Python helper (`runtime/win_helper.py`, pyautogui + mss).
 * This module is deliberately platform-agnostic — the routing decision, and
 * the very different guarantees each side offers, live in `helperBridge.ts`.
 */

import type {
  AppStateResult,
  AppTarget,
  CodexComputerEngine,
  CodexMouseButton,
  ComputerExecutor,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvedAppTarget,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
  SetValueResult,
} from '../../vendor/computer-use-mcp/index.js'
import { API_RESIZE_PARAMS, targetImageSize } from '../../vendor/computer-use-mcp/index.js'
import { formatNativeAppList, type NativeAppInfo } from '../../vendor/computer-use-mcp/executor.js'
import { sleep } from '../sleep.js'
import {
  CLI_HOST_BUNDLE_ID,
  getCliComputerUseCapabilities,
  isComputerUseSupportedPlatform,
} from './common.js'
// Platform-routed helper: macOS → native cu-helper (no cursor steal),
// Windows → Python helper (pyautogui, which does move the real cursor).
import { callHelper } from './helperBridge.js'

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
  return callHelper<string>('read_clipboard', {})
}

async function writeClipboardViaPbcopy(text: string): Promise<void> {
  await callHelper('write_clipboard', { text })
}

async function readClipboard(): Promise<string> {
  if (process.platform === 'win32') {
    return callHelper<string>('read_clipboard', {})
  }

  return readClipboardViaPbpaste()
}

async function writeClipboard(text: string): Promise<void> {
  if (process.platform === 'win32') {
    await callHelper('write_clipboard', { text })
    return
  }

  await writeClipboardViaPbcopy(text)
}

// ----------------------------------------------------------------------------
// Codex semantic engine (blueprint §4–§7)
//
// Maps the Codex-compatible `CodexComputerEngine` methods onto `callHelper(<cmd>, payload)`
// round-trips against the native daemon's `CommandRouter`. Each command's
// payload key names mirror what `CommandRouter` decodes (see CommandRouter.swift):
//   - target: `pid` | `bundleId` | `app`  (resolveTargetPid precedence)
//   - click:  `index` (string|int), `x`, `y`, `click_count`, `button`
//   - set_value: `index`, `value`        → returns `{before, after}`
//   - perform_secondary_action: `index`, `action`
//   - scroll: `index?`, `x?`, `y?`, `direction`, `pages`
//   - drag:   `from{x,y}`, `to{x,y}`, `button`
//   - press_key: `key` ; type_text: `text`
//
// Preserve structured list_apps rows for the JavaScript client. Older helpers
// returned only running AppRef rows; normalize those during a host upgrade.
// ----------------------------------------------------------------------------

/** A daemon `list_apps` row — `Apps.AppRef` (Geometry.swift). */
interface DaemonAppRef {
  bundleId: string
  displayName: string
}

/**
 * Spread an `AppTarget` into the daemon payload keys `CommandRouter` resolves
 * (pid → bundleId → app → frontmost). Exactly one of the three is set by the
 * tool face; an empty target ({}) means "frontmost", so we send no keys.
 */
function appTargetPayload(target: AppTarget): Record<string, unknown> {
  // The lifetime identity rides along with whichever selector is used: the
  // daemon re-checks it before acting, so a pid that was recycled since we
  // resolved it is rejected rather than acted on.
  const identity =
    target.expectedProcessIdentity === undefined
      ? {}
      : { expectedProcessIdentity: target.expectedProcessIdentity }
  if (target.pid !== undefined) return { pid: target.pid, ...identity }
  if (target.bundleId !== undefined) return { bundleId: target.bundleId, ...identity }
  if (target.app !== undefined) return { app: target.app, ...identity }
  return { ...identity }
}

async function listNativeApps(): Promise<NativeAppInfo[]> {
  const apps = await callHelper<Array<NativeAppInfo | DaemonAppRef>>('list_apps', {})
  return apps.map(app => 'id' in app ? app : {
    id: app.bundleId,
    displayName: app.displayName,
    isRunning: true,
  })
}

/**
 * The Codex semantic engine over the native daemon.
 *
 * Exported so the tool face can be exercised against a mocked `helperBridge`
 * without standing up a full executor (which refuses to construct on
 * unsupported platforms).
 */
export function createCodexEngine(): CodexComputerEngine {
  return {
    async listApps(): Promise<string> {
      return formatNativeAppList(await listNativeApps())
    },

    listAppsInfo: listNativeApps,

    async resolveTarget(target: AppTarget): Promise<ResolvedAppTarget> {
      // Sent as-is: the daemon owns the selector→process mapping, and it must
      // never launch anything to satisfy a match.
      return callHelper<ResolvedAppTarget>('resolve_app_target', target)
    },

    async getAppState(
      target: AppTarget,
      opts?: { disableDiff?: boolean },
    ): Promise<AppStateResult> {
      return callHelper<AppStateResult>('get_app_state', {
        ...appTargetPayload(target),
        ...(opts?.disableDiff === undefined ? {} : { disableDiff: opts.disableDiff }),
      })
    },

    async click(args: {
      target: AppTarget
      index?: string
      x?: number
      y?: number
      clickCount?: number
      button?: CodexMouseButton
    }): Promise<void> {
      await callHelper('click', {
        ...appTargetPayload(args.target),
        index: args.index,
        x: args.x,
        y: args.y,
        click_count: args.clickCount,
        button: args.button,
      })
    },

    async setValue(args: {
      target: AppTarget
      index: string
      value: string
    }): Promise<SetValueResult> {
      return callHelper<SetValueResult>('set_value', {
        ...appTargetPayload(args.target),
        index: args.index,
        value: args.value,
      })
    },

    async selectText(args: {
      target: AppTarget
      index: string
      text: string
      prefix?: string
      suffix?: string
      selection?: 'text' | 'cursor_before' | 'cursor_after'
    }): Promise<void> {
      await callHelper('select_text', {
        ...appTargetPayload(args.target),
        index: args.index,
        text: args.text,
        prefix: args.prefix,
        suffix: args.suffix,
        selection: args.selection,
      })
    },

    async performSecondaryAction(args: {
      target: AppTarget
      index: string
      action: string
    }): Promise<void> {
      await callHelper('perform_secondary_action', {
        ...appTargetPayload(args.target),
        index: args.index,
        action: args.action,
      })
    },

    async scroll(args: {
      target: AppTarget
      index?: string
      x?: number
      y?: number
      direction: 'up' | 'down' | 'left' | 'right'
      pages?: number
    }): Promise<void> {
      await callHelper('scroll', {
        ...appTargetPayload(args.target),
        index: args.index,
        x: args.x,
        y: args.y,
        direction: args.direction,
        pages: args.pages,
      })
    },

    async drag(args: {
      target: AppTarget
      from: { x: number; y: number }
      to: { x: number; y: number }
      button?: CodexMouseButton
    }): Promise<void> {
      await callHelper('drag', {
        ...appTargetPayload(args.target),
        from: args.from,
        to: args.to,
        button: args.button,
      })
    },

    async pressKey(args: {
      target: AppTarget
      key: string
      systemKeyCombos: boolean
    }): Promise<void> {
      await callHelper('press_key', {
        ...appTargetPayload(args.target),
        key: args.key,
        systemKeyCombos: args.systemKeyCombos,
      })
    },

    async typeText(args: { target: AppTarget; text: string }): Promise<void> {
      await callHelper('type_text', {
        ...appTargetPayload(args.target),
        text: args.text,
      })
    },

    async paste(args: {
      target: AppTarget
      text: string
      format: 'text' | 'md' | 'html'
    }): Promise<void> {
      await callHelper('paste', {
        ...appTargetPayload(args.target),
        text: args.text,
        format: args.format,
      })
    },
  }
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
      await callHelper('paste_clipboard', {})
      await sleep(180)
    } else {
      await callHelper('key', {
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

export function createCliExecutor(opts: {
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

    // The Codex semantic AX engine is the native macOS path (cu-helper daemon →
    // AXTree/AXAction). On Windows the Python helper has no get_app_state/click-
    // by-index surface, so we leave `engine` undefined there and the ten Codex
    // tools cleanly return `feature_unavailable` (toolCalls.ts gate 5).
    engine: process.platform === 'darwin' ? createCodexEngine() : undefined,

    async prepareForAction(_allowlistBundleIds, _displayId): Promise<string[]> {
      return callHelper('prepare_for_action', {})
    },

    async previewHideSet(_allowlistBundleIds, _displayId) {
      return callHelper('preview_hide_set', {})
    },

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      return normalizeDisplayGeometry(await callHelper('get_display_size', { displayId }))
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      const displays = await callHelper<PythonDisplayGeometry[]>('list_displays', {})
      return displays.map(display => normalizeDisplayGeometry(display))
    },

    async findWindowDisplays(bundleIds: string[]) {
      return callHelper('find_window_displays', { bundleIds })
    },

    async resolvePrepareCapture(opts): Promise<ResolvePrepareCaptureResult> {
      const display = await this.getDisplaySize(opts.preferredDisplayId)
      const [targetW, targetH] = computeTargetDims(display.width, display.height, display.scaleFactor)
      const result = await callHelper<PythonResolvePrepareCaptureResult>('resolve_prepare_capture', {
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
      const result = await callHelper<ScreenshotResult>('screenshot', {
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
      return callHelper('zoom', {
        x: regionLogical.x,
        y: regionLogical.y,
        width: regionLogical.w,
        height: regionLogical.h,
        targetWidth: outW,
        targetHeight: outH,
      })
    },

    async key(keySequence: string, repeat?: number): Promise<void> {
      await callHelper('key', { keySequence, repeat: repeat ?? 1 })
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      await callHelper('hold_key', { keyNames, durationMs })
    },

    async type(text: string, opts2: { viaClipboard: boolean }): Promise<void> {
      if (opts2.viaClipboard) {
        await typeViaClipboard(text)
        return
      }
      await callHelper('type', { text })
    },

    readClipboard,
    writeClipboard,

    async click(x, y, button, count, modifiers): Promise<void> {
      await callHelper('click', {
        x,
        y,
        button,
        count,
        modifiers,
        animate: opts.getMouseAnimationEnabled(),
      })
      await sleep(MOVE_SETTLE_MS)
    },

    async mouseDown(): Promise<void> {
      await callHelper('mouse_down', {})
    },

    async mouseUp(): Promise<void> {
      await callHelper('mouse_up', {})
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return callHelper('cursor_position', {})
    },

    async drag(from, to): Promise<void> {
      await callHelper('drag', {
        from,
        to,
        animate: opts.getMouseAnimationEnabled(),
      })
      await sleep(MOVE_SETTLE_MS)
    },

    async moveMouse(x, y): Promise<void> {
      await callHelper('move_mouse', {
        x,
        y,
        animate: opts.getMouseAnimationEnabled(),
      })
      await sleep(MOVE_SETTLE_MS)
    },

    async scroll(x, y, dx, dy): Promise<void> {
      await callHelper('scroll', {
        x,
        y,
        deltaX: dx,
        deltaY: dy,
        animate: opts.getMouseAnimationEnabled(),
      })
    },

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      return callHelper('frontmost_app', {})
    },

    async appUnderPoint(x, y) {
      return callHelper('app_under_point', { x, y })
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      return callHelper('list_installed_apps', {})
    },

    async listRunningApps(): Promise<RunningApp[]> {
      return callHelper('list_running_apps', {})
    },

    async openApp(bundleId: string): Promise<void> {
      await callHelper('open_app', { bundleId })
    },
  }
}

export async function unhideComputerUseApps(_bundleIds: readonly string[]): Promise<void> {
  return
}
