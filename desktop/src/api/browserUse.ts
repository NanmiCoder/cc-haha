import { api } from './client'

export type BrowserTargetKind = 'workspace' | 'chrome'

export type BrowserPreferredTarget = 'auto' | BrowserTargetKind

export type BrowserControlState = 'idle' | 'active' | 'takeover'

export type BrowserTakeoverReason =
  | 'captcha'
  | 'login'
  | 'two_factor'
  | 'payment'
  | 'destructive'
  | 'permission'
  | 'user_requested'
  | 'manual'
  | 'other'

export type BrowserActionKind =
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'type'
  | 'press'
  | 'select'
  | 'hover'
  | 'scroll'
  | 'wait'
  | 'dialog'

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

export type DetectedBrowserInfo = {
  id: DetectedBrowserId
  name: string
  executablePath: string
  userDataDir: string
  devToolsActivePortPath: string
  hasDevToolsActivePort: boolean
  platform: string
}

export type ChromeConnectionState = {
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

export type BrowserTabInfo = {
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

export type BrowserTakeoverState = {
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

export type BrowserUseConfig = {
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

export type BrowserUseStatus = {
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

export type BrowserUseActivityEvent = {
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

export type ChromeConnectResult = {
  ok: boolean
  chrome: ChromeConnectionState
  status: BrowserUseStatus
  error?: string
}

export type ChromeDisconnectResult = {
  ok: true
  status: BrowserUseStatus
}

export type TakeoverResumeResult = {
  ok: true
  resumed: boolean
  takeover?: BrowserTakeoverState
}

export type TakeoverAbortResult = {
  ok: true
  takeover?: BrowserTakeoverState
}

export const CHROME_CONNECT_TIMEOUT_MS = 45_000

export const browserUseApi = {
  getStatus() {
    return api.get<BrowserUseStatus>('/api/browser-use/status')
  },
  getConfig() {
    return api.get<BrowserUseConfig>('/api/browser-use/config')
  },
  updateConfig(patch: Partial<BrowserUseConfig>) {
    return api.put<BrowserUseConfig>('/api/browser-use/config', patch)
  },
  connectChrome(options?: { browserId?: DetectedBrowserId; timeoutMs?: number }) {
    return api.post<ChromeConnectResult>(
      '/api/browser-use/chrome/connect',
      options ?? {},
      { timeout: CHROME_CONNECT_TIMEOUT_MS },
    )
  },
  launchManagedChrome(options?: { browserId?: DetectedBrowserId; headless?: boolean }) {
    return api.post<ChromeConnectResult>(
      '/api/browser-use/chrome/launch-managed',
      options ?? {},
      { timeout: CHROME_CONNECT_TIMEOUT_MS },
    )
  },
  disconnectChrome() {
    return api.post<ChromeDisconnectResult>('/api/browser-use/chrome/disconnect', {})
  },
  resumeTakeover(payload: { sessionId: string; takeoverId?: string; note?: string }) {
    return api.post<TakeoverResumeResult>('/api/browser-use/takeover/resume', payload)
  },
  abortTakeover(payload: { sessionId: string; takeoverId?: string; reason?: string }) {
    return api.post<TakeoverAbortResult>('/api/browser-use/takeover/abort', payload)
  },
}
