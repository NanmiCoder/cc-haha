export const BROWSER_USE_TARGET_KINDS = ['workspace', 'chrome'] as const

export type BrowserTargetKind = (typeof BROWSER_USE_TARGET_KINDS)[number]

export const BROWSER_USE_PREFERRED_TARGETS = [
  'auto',
  'workspace',
  'chrome',
] as const

export type BrowserPreferredTarget =
  (typeof BROWSER_USE_PREFERRED_TARGETS)[number]

export type BrowserControlState = 'idle' | 'active' | 'takeover'

export const BROWSER_USE_TAKEOVER_REASONS = [
  'captcha',
  'login',
  'two_factor',
  'payment',
  'destructive',
  'permission',
  'user_requested',
  'manual',
  'other',
] as const

export type BrowserTakeoverReason =
  (typeof BROWSER_USE_TAKEOVER_REASONS)[number]

export const BROWSER_USE_ACTION_KINDS = [
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'select',
  'hover',
  'scroll',
  'wait',
  'dialog',
] as const

export type BrowserActionKind = (typeof BROWSER_USE_ACTION_KINDS)[number]

export type BrowserModifierKey = 'Alt' | 'Control' | 'Meta' | 'Shift'

export type BrowserMouseButton = 'left' | 'right' | 'middle'

export type BrowserScrollDirection = 'up' | 'down' | 'left' | 'right'

/**
 * Flat action step structure with optional fields + `action` enum.
 * Intentionally avoids nested `oneOf` / `discriminatedUnion` / recursive `$ref`
 * for multi-provider JSON Schema compatibility (Anthropic, OpenAI, Gemini, etc.).
 */
export interface FlatActionStep {
  action: BrowserActionKind
  ref?: string
  text?: string
  key?: string
  value?: string
  clear?: boolean
  submit?: boolean
  button?: BrowserMouseButton
  modifiers?: BrowserModifierKey[]
  deltaX?: number
  deltaY?: number
  direction?: BrowserScrollDirection
  amount?: number
  ms?: number
  waitForText?: string
  waitForSelector?: string
  accept?: boolean
  promptText?: string
  sensitive?: boolean
  label?: string
}

export type CdpEventListener = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => void

export interface CdpSendOptions {
  sessionId?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CdpTransport {
  readonly kind: BrowserTargetKind
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: CdpSendOptions,
  ): Promise<T>
  onEvent(listener: CdpEventListener): () => void
  onDisconnect?(listener: (reason: string) => void): () => void
  isConnected(): boolean
  close(): Promise<void>
}

export interface BrowserTabInfo {
  tabId: string
  target: BrowserTargetKind
  url: string
  title: string
  active: boolean
  ownerSessionId?: string
  ownerAgentId?: string
  pinned?: boolean
  cdpSessionId?: string
  targetId?: string
  createdAt?: number
}

export interface BrowserRefEntry {
  refId: string
  backendNodeId: number
  frameId: string
  loaderId: string
  role: string
  name: string
  humanLabel: string
  nth: number
  hint?: string
  tagName?: string
  inputType?: string
  isPassword?: boolean
  value?: string
  checked?: boolean
  disabled?: boolean
  expanded?: boolean
  selected?: boolean
  source?: 'ax' | 'dom' | 'label'
}

export interface BrowserBoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserCursorPayload {
  tabId: string
  target: BrowserTargetKind
  moveId?: string
  x: number
  y: number
  targetBox?: BrowserBoundingBox
  durationMs?: number
  style?: 'scoot' | 'bezier' | 'snap'
  label?: string
  action?: BrowserActionKind | 'navigate' | 'snapshot'
  click?: boolean
}

export interface BrowserControlStatePayload {
  tabId: string
  target: BrowserTargetKind
  state: BrowserControlState
  sessionId?: string
  agentId?: string
  label?: string
  takeoverId?: string
  takeoverReason?: BrowserTakeoverReason
  takeoverMessage?: string
}

export interface BrowserUseConfig {
  enabled: boolean
  preferredTarget: BrowserPreferredTarget
  showCursorOverlay: boolean
  autoOpenWorkspacePanel: boolean
  managedChromeHeadless: boolean
  blockedLoopbackPorts?: number[]
  chromeBinaryPath?: string
  chromeUserDataDir?: string
  consentAcceptedAt?: string
  updatedAt?: string
}

export type ChromeConnectionMode =
  | 'disconnected'
  | 'live_attach'
  | 'managed'
  | 'awaiting_approval'
  | 'remote_debugging_not_enabled'
  | 'error'

export type DetectedBrowserId =
  | 'chrome'
  | 'chrome-canary'
  | 'edge'
  | 'brave'
  | 'chromium'

export interface DetectedBrowserInfo {
  id: DetectedBrowserId
  name: string
  executablePath: string
  userDataDir: string
  devToolsActivePortPath: string
  hasDevToolsActivePort: boolean
  platform: NodeJS.Platform
}

export interface ChromeConnectionState {
  mode: ChromeConnectionMode
  browserId?: DetectedBrowserId
  browserName?: string
  browserVersion?: string
  wsEndpoint?: string
  userDataDir?: string
  port?: number
  pid?: number
  pinnedTabIds?: string[]
  detectedBrowsers: DetectedBrowserInfo[]
  error?: string
  guidance?: string
}

export interface BrowserTakeoverState {
  takeoverId: string
  tabId: string
  target: BrowserTargetKind
  sessionId?: string
  agentId?: string
  reason: BrowserTakeoverReason
  message: string
  url?: string
  createdAt: number
  status: 'pending' | 'resumed' | 'aborted'
}

export interface BrowserUseStatus {
  enabled: boolean
  preferredTarget: BrowserPreferredTarget
  activeTarget: BrowserTargetKind | null
  workspaceAvailable: boolean
  chrome: ChromeConnectionState
  controlState: BrowserControlState
  activeTabId?: string
  activeTakeover?: BrowserTakeoverState | null
  tabs: BrowserTabInfo[]
  config: BrowserUseConfig
}

export type BrowserUseActivityKind =
  | 'navigate'
  | 'snapshot'
  | 'act'
  | 'inspect'
  | 'tabs'
  | 'takeover'
  | 'dialog'
  | 'control_state'
  | 'error'

export interface BrowserUseActivityEvent {
  id: string
  timestamp: number
  sessionId?: string
  agentId?: string
  tabId: string
  target: BrowserTargetKind
  kind: BrowserUseActivityKind
  action?: BrowserActionKind | string
  humanLabel: string
  detail?: string
  maskedValue?: string
  url?: string
  title?: string
  status: 'running' | 'completed' | 'paused' | 'failed'
  screenshotDataUrl?: string
  takeover?: BrowserTakeoverState
  error?: string
}

export interface BrowserZoomFactors {
  pageZoomFactor: number
  appZoomFactor: number
}

export interface BrowserUiHooks {
  moveCursor?(
    payload: BrowserCursorPayload,
    signal?: AbortSignal,
  ): Promise<{ arrived: boolean; skipped?: boolean } | void>
  clickRipple?(payload: BrowserCursorPayload): Promise<void> | void
  setControlState?(payload: BrowserControlStatePayload): Promise<void> | void
  onActivity?(event: BrowserUseActivityEvent): void
  getZoomFactors?(tabId: string): Promise<BrowserZoomFactors>
}

export interface ViewportCoordinateMetrics {
  xCss: number
  yCss: number
  offsetX: number
  offsetY: number
  visualViewportScale: number
  zoomFactor: number
  appZoomFactor: number
}

export interface ComputedCoordinates {
  xVv: number
  yVv: number
  xSlot: number
  ySlot: number
  xDispatch: number
  yDispatch: number
}

export interface BrowserDialogState {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  defaultPrompt?: string
  url?: string
  hasBrowserHandler?: boolean
  openedAt: number
}

export interface UntrustedContentMeta {
  source: string
  url?: string
  title?: string
  tabId?: string
  kind?: string
  maxChars?: number
}

export interface WrappedUntrustedContent {
  nonce: string
  wrapped: string
  truncated: boolean
  originalLength: number
}

export interface BrowserSnapshotOptions {
  tabId?: string
  sessionId?: string
  agentId?: string
  diff?: boolean
  screenshot?: boolean
  screenshotFormat?: 'jpeg' | 'png'
  screenshotQuality?: number
  maxScreenshotBytes?: number
  maxNodes?: number
  maxChars?: number
  includeNonInteractive?: boolean
  signal?: AbortSignal
}

export interface BrowserSnapshotResult {
  tabId: string
  target: BrowserTargetKind
  url: string
  title: string
  frameId: string
  loaderId: string
  refCount: number
  refs: BrowserRefEntry[]
  treeText: string
  wrappedTree: WrappedUntrustedContent
  diff?: string
  diffChanged?: boolean
  screenshotDataUrl?: string
  screenshotMimeType?: string
  screenshotBytes?: number
  dialog?: BrowserDialogState
}

export interface BrowserNavigateOptions {
  tabId?: string
  url?: string
  action?: 'goto' | 'back' | 'forward' | 'reload'
  waitUntil?: 'load' | 'domcontentloaded' | 'none'
  timeoutMs?: number
  sessionId?: string
  agentId?: string
  signal?: AbortSignal
}

export interface BrowserNavigateResult {
  tabId: string
  target: BrowserTargetKind
  url: string
  title: string
  frameId?: string
  loaderId?: string
  dialog?: BrowserDialogState
}

export interface BrowserActOptions {
  tabId?: string
  steps: FlatActionStep[]
  sessionId?: string
  agentId?: string
  signal?: AbortSignal
  stopOnNavigation?: boolean
  autoTakeoverOnSensitive?: boolean
}

export interface BrowserActStepResult {
  index: number
  action: BrowserActionKind
  ref?: string
  humanLabel: string
  status: 'ok' | 'stopped' | 'failed'
  error?: string
  navigationChanged?: boolean
  dialog?: BrowserDialogState
  takeover?: BrowserTakeoverState
}

export interface BrowserActResult {
  tabId: string
  target: BrowserTargetKind
  completedSteps: number
  totalSteps: number
  stoppedReason?:
    | 'error'
    | 'navigation'
    | 'dialog'
    | 'takeover'
    | 'sensitive_gate'
    | 'aborted'
  results: BrowserActStepResult[]
  url: string
  title: string
  dialog?: BrowserDialogState
  wrappedDialog?: WrappedUntrustedContent
  takeover?: BrowserTakeoverState
}

export type BrowserInspectKind = 'console' | 'network' | 'text' | 'html' | 'eval'

export interface BrowserConsoleEntry {
  timestamp: number
  level: string
  text: string
  url?: string
  lineNumber?: number
}

export interface BrowserNetworkEntry {
  timestamp: number
  requestId: string
  url: string
  method: string
  status?: number
  statusText?: string
  resourceType?: string
  failed?: boolean
  errorText?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
}

export interface BrowserInspectOptions {
  tabId?: string
  kind: BrowserInspectKind
  expression?: string
  selector?: string
  limit?: number
  maxChars?: number
  sessionId?: string
  agentId?: string
  signal?: AbortSignal
}

export interface BrowserInspectResult {
  tabId: string
  target: BrowserTargetKind
  kind: BrowserInspectKind
  url: string
  wrappedContent: WrappedUntrustedContent
  itemCount?: number
}

export interface BrowserTakeoverRequestOptions {
  tabId?: string
  reason: BrowserTakeoverReason
  message: string
  sessionId?: string
  agentId?: string
}
