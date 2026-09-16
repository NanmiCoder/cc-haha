export interface DisplayGeometry {
  id?: number
  displayId?: number
  width: number
  height: number
  scaleFactor: number
  originX: number
  originY: number
  isPrimary?: boolean
  name?: string
  label?: string
}

export interface ScreenshotResult {
  base64: string
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  displayId?: number
  originX: number
  originY: number
}

export interface FrontmostApp {
  bundleId: string
  displayName: string
}

export interface RunningApp {
  bundleId: string
  displayName: string
}

/** Native macOS inventory, preserving optional usage and running metadata. */
export interface NativeAppInfo {
  id: string
  displayName?: string
  isRunning?: boolean
  lastUsedDate?: string
  useCount?: number
}

export function formatNativeAppList(apps: readonly NativeAppInfo[]): string {
  if (apps.length === 0) return 'No running applications are available to control.'
  return apps.map(app => `${app.displayName ?? app.id} — ${app.id}`).join('\n')
}

// ----------------------------------------------------------------------------
// Codex semantic engine — AX-tree-aware app state + element-indexed injection.
//
// These shapes mirror the native `cu-helper` daemon's NDJSON `result` payloads
// (CommandRouter → AXTree.Result / AXAction). The MCP tool face (toolCalls.ts)
// frames them into the Codex `<app_state>` envelope; the host executor
// implementation (src/utils/computerUse/executor.ts) maps each method 1:1 onto
// a `callHelper(<cmd>, payload)` round-trip over the AF_UNIX socket.
//
// `axText` is the COMPLETE inner accessibility tree text rendered by Swift
// (App=/Window:/tree/optional focus tail) — the MCP layer wraps it in the
// banner + <app_state> tags but never re-renders the tree itself (the renderer
// is the Swift format authority; see blueprint §1).
// ----------------------------------------------------------------------------

/** A captured window screenshot in capture-pixel space (left-top origin). */
export interface AppStateScreenshot {
  base64: string
  width: number
  height: number
  /** Older helpers omit this and return PNG. */
  mimeType?: 'image/png' | 'image/jpeg'
  /** Uniform capture scale before encoded pixel dimensions are rounded up. */
  pixelsPerPoint?: number
}

/**
 * One get_app_state result from the daemon. `axText` is the fully-rendered
 * inner tree; `appInstructions` is the per-app `<app_specific_instructions>`
 * body (non-empty only when the daemon has guidance for this bundle, and only
 * on the first session for that app — the daemon owns the "first session"
 * decision). `screenshot` is best-effort (`try?` on the Swift side): the result
 * is still valid with AX text only when capture failed or wedged.
 */
export interface AppStateResult {
  pid: number
  appName?: string
  bundleId?: string
  windowTitle?: string
  elementCount: number
  truncated: boolean
  durationMs: number
  /** Full rendered inner tree (App=/Window:/indented tree/focus tail). */
  axText: string
  /** Per-app instructions body, or undefined/empty when none apply. */
  appInstructions?: string
  /** Best-effort window-locked screenshot; absent when capture failed. */
  screenshot?: AppStateScreenshot
}

/** Result of a set_value injection — before/after `kAXValue` for the model. */
export interface SetValueResult {
  before?: string
  after?: string
}

/** Mouse button for click/drag, in Codex's numeric convention.
 *  1=left, 2=middle, 3=right, 4=back, 5=forward. */
export type CodexMouseButton =
  | 'left'
  | 'middle'
  | 'right'
  | 'back'
  | 'forward'

/**
 * A process's lifetime identity — what makes "pid 4321" mean the *same* process
 * it meant when we resolved it. A bare pid is not enough: pids are recycled, so
 * a target resolved against a dead process could land an action on whatever
 * inherited the number. `launchTime` is the discriminator; the daemon re-checks
 * this before every mutation and rejects a mismatch.
 */
export interface ProcessIdentity {
  pid: number
  bundleId?: string
  executablePath?: string
  launchTime?: number
}

/** How the model addressed an app: by name, bundle id, or pid. The daemon's
 *  CommandRouter resolves this to a concrete pid (pid → bundleId → name),
 *  excluding our own host process. Exactly one addressing field is set.
 *
 *  `expectedProcessIdentity` rides along after `resolveTarget` has proven the
 *  process: it pins the action to that exact process lifetime rather than to a
 *  recyclable pid. */
export interface AppTarget {
  app?: string
  bundleId?: string
  pid?: number
  expectedProcessIdentity?: ProcessIdentity
}

/**
 * A target resolved to a concrete, *running* process. `resolveTarget` is the
 * single seam through which every directed tool passes before it is authorized:
 * the model's loose selector (name / path / bundle id / pid) becomes one real
 * process plus the lifetime identity that proves it.
 *
 * `processIdentity` is what the authorization layer demands — a target without
 * it has no proven lifetime, and every mutating tool fails closed rather than
 * acting on an unproven process.
 */
export interface ResolvedAppTarget {
  pid: number
  bundleId?: string
  displayName?: string
  path?: string
  executablePath?: string
  launchTime?: number
  processIdentity?: ProcessIdentity
}

/**
 * Semantic Computer Use engine — the native AX path. Separate from the pixel
 * `ComputerExecutor` methods above so a host can wire one, the other, or both.
 * Every method is a thin pass-through to a daemon command; all the AX tree
 * building, staleness guards, and injection gradient live in Swift.
 */
export interface CodexComputerEngine {
  /** Enumerate running/recent apps as the `list_apps` text block expects. */
  listApps(): Promise<string>
  /** Structured inventory for JavaScript clients; legacy engines may omit it. */
  listAppsInfo?(): Promise<NativeAppInfo[]>
  /**
   * Resolve a loose selector to one running process plus its lifetime identity.
   * Never launches anything — a selector that matches nothing is an error, not
   * an invitation to start the app.
   */
  resolveTarget(target: AppTarget): Promise<ResolvedAppTarget>
  /**
   * Build (or refresh) the per-pid AX snapshot + return the rendered tree.
   * `disableDiff` forces a full tree instead of the cumulative diff the daemon
   * would otherwise send when the snapshot is a continuation of a prior one.
   */
  getAppState(target: AppTarget, opts?: { disableDiff?: boolean }): Promise<AppStateResult>
  /** Click an element by opaque handle, or a raw point. clickCount≥1; right button = context menu. */
  click(args: {
    target: AppTarget
    index?: string
    x?: number
    y?: number
    clickCount?: number
    button?: CodexMouseButton
  }): Promise<void>
  /** Set `kAXValue` on a settable element; returns before/after. */
  setValue(args: { target: AppTarget; index: string; value: string }): Promise<SetValueResult>
  /** Select a run of text in an element by handle, or place the caret before/
   *  after it. `prefix`/`suffix` disambiguate a repeated target; `selection`
   *  defaults to `text`. Lands via `SetAttributeValue(kAXSelectedTextRange)`. */
  selectText(args: {
    target: AppTarget
    index: string
    text: string
    prefix?: string
    suffix?: string
    selection?: 'text' | 'cursor_before' | 'cursor_after'
  }): Promise<void>
  /** Perform a (pretty-named or raw) secondary accessibility action. */
  performSecondaryAction(args: { target: AppTarget; index: string; action: string }): Promise<void>
  /** Scroll an element (or a point) by `pages` in a cardinal direction. */
  scroll(args: {
    target: AppTarget
    index?: string
    x?: number
    y?: number
    direction: 'up' | 'down' | 'left' | 'right'
    pages?: number
  }): Promise<void>
  /** Synthetic drag from one global point to another (coordinate-only). */
  drag(args: { target: AppTarget; from: { x: number; y: number }; to: { x: number; y: number }; button?: CodexMouseButton }): Promise<void>
  /**
   * Press a key / chord using the xdotool vocabulary (`super+c`, `Return`, …).
   * `systemKeyCombos` is the session's grant bit for cross-application and
   * termination chords — it comes from the user's grant, never from the model's
   * arguments, so the caller must state it explicitly on every press.
   */
  pressKey(args: { target: AppTarget; key: string; systemKeyCombos: boolean }): Promise<void>
  /** Type literal text (append to focused value; Unicode keyboard fallback). */
  typeText(args: { target: AppTarget; text: string }): Promise<void>; paste(args: { target: AppTarget; text: string; format: 'text' | 'md' | 'html' }): Promise<void>
}

export interface InstalledApp {
  bundleId: string
  displayName: string
  path: string
  iconDataUrl?: string
}

export interface ResolvePrepareCaptureResult extends ScreenshotResult {
  hidden: string[]
  display: DisplayGeometry
  resolvedDisplayId?: number
  captureError?: string
}

export interface ComputerExecutor {
  capabilities: {
    screenshotFiltering: 'native' | 'none'
    platform: 'darwin' | 'win32'
    hostBundleId: string
    teachMode?: boolean
  }
  /**
   * The semantic AX engine for the Codex 10-tool face. Present on macOS hosts
   * wired to the native `cu-helper` daemon. The Codex tool dispatch in
   * toolCalls.ts requires this; if a host leaves it undefined (e.g. a pixel-
   * only platform), the Codex tools return a `feature_unavailable` error
   * rather than throwing.
   */
  engine?: CodexComputerEngine
  prepareForAction(allowlistBundleIds: string[], displayId?: number): Promise<string[]>
  previewHideSet(allowlistBundleIds: string[], displayId?: number): Promise<Array<{ bundleId: string; displayName: string }>>
  getDisplaySize(displayId?: number): Promise<DisplayGeometry>
  listDisplays(): Promise<DisplayGeometry[]>
  findWindowDisplays(bundleIds: string[]): Promise<Array<{ bundleId: string; displayIds: number[] }>>
  resolvePrepareCapture(opts: {
    allowedBundleIds: string[]
    preferredDisplayId?: number
    autoResolve: boolean
    doHide?: boolean
  }): Promise<ResolvePrepareCaptureResult>
  screenshot(opts: { allowedBundleIds: string[]; displayId?: number }): Promise<ScreenshotResult>
  zoom(
    regionLogical: { x: number; y: number; w: number; h: number },
    allowedBundleIds: string[],
    displayId?: number,
  ): Promise<{ base64: string; width: number; height: number }>
  key(keySequence: string, repeat?: number): Promise<void>
  holdKey(keyNames: string[], durationMs: number): Promise<void>
  type(text: string, opts: { viaClipboard: boolean }): Promise<void>
  click(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle',
    count: 1 | 2 | 3,
    modifiers?: string[],
  ): Promise<void>
  drag(
    from: { x: number; y: number } | undefined,
    to: { x: number; y: number },
  ): Promise<void>
  moveMouse(x: number, y: number): Promise<void>
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>
  mouseDown(): Promise<void>
  mouseUp(): Promise<void>
  getCursorPosition(): Promise<{ x: number; y: number }>
  getFrontmostApp(): Promise<FrontmostApp | null>
  appUnderPoint(x: number, y: number): Promise<{ bundleId: string; displayName: string } | null>
  listInstalledApps(): Promise<InstalledApp[]>
  getAppIcon?(path: string): Promise<string | undefined>
  listRunningApps(): Promise<RunningApp[]>
  openApp(bundleId: string): Promise<void>
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
}
