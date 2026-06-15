import { useSettingsStore } from '../stores/settingsStore'
import { getDesktopHost } from './desktopHost'

const DEFAULT_COOLDOWN_MS = 750

export type DesktopNotificationOptions = {
  title: string
  body?: string
  dedupeKey?: string
  cooldownScope?: string
  cooldownMs?: number
  requestAttention?: boolean
  target?: DesktopNotificationTarget
}

export type DesktopNotificationTarget =
  | { type: 'session'; sessionId: string; title?: string }
  | { type: 'scheduled' }

type NativeNotificationPayload = {
  title: string
  body?: string
  id?: number
  extra?: Record<string, unknown>
  target?: DesktopNotificationTarget
}

type NativeNotificationSender = (options: NativeNotificationPayload) => Promise<boolean> | boolean
export type DesktopNotificationPermission = NotificationPermission | 'unsupported'
type PluginPermissionState = DesktopNotificationPermission | 'prompt' | 'prompt-with-rationale'

const TARGET_EXTRA_KEY = 'ccHahaTarget'
const notifiedKeys = new Set<string>()
const pendingKeys = new Set<string>()
const lastNotificationAtByScope = new Map<string, number>()
const pendingCooldownScopes = new Set<string>()
const notificationTargetById = new Map<number, DesktopNotificationTarget>()
let overrideNativeNotificationSender: NativeNotificationSender | null = null
let nextNotificationId = 1

function readBrowserNotificationPermission(): DesktopNotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported'
  }
  return window.Notification.permission
}

function detectPlatform(): 'darwin' | 'win32' | 'linux' | 'unknown' {
  const platform = typeof navigator !== 'undefined' ? navigator.platform.toLowerCase() : ''
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : ''
  if (platform.includes('mac')) return 'darwin'
  if (platform.includes('win')) return 'win32'
  if (platform.includes('linux')) return 'linux'
  if (userAgent.includes('mac')) return 'darwin'
  if (userAgent.includes('win')) return 'win32'
  if (userAgent.includes('linux')) return 'linux'
  return 'unknown'
}

export function getDesktopNotificationPlatform(): 'darwin' | 'win32' | 'linux' | 'unknown' {
  return detectPlatform()
}

function getNotificationSettingsUrl(): string | null {
  switch (detectPlatform()) {
    case 'darwin':
      return 'x-apple.systempreferences:com.apple.preference.notifications'
    case 'win32':
      return 'ms-settings:notifications'
    default:
      return null
  }
}

function normalizePermission(value: unknown): DesktopNotificationPermission {
  if (value === true) return 'granted'
  if (value === false) return 'denied'
  if (value === null) return 'default'
  if (value === 'prompt' || value === 'prompt-with-rationale') return 'default'
  return ['default', 'denied', 'granted', 'unsupported'].includes(value as string)
    ? value as DesktopNotificationPermission
    : 'unsupported'
}

async function invokeWindowsNotificationPermissionState(): Promise<DesktopNotificationPermission | null> {
  if (detectPlatform() !== 'win32') return null

  try {
    const granted = await getDesktopHost().commands.invoke<boolean | null>('plugin:notification|is_permission_granted')
    return normalizePermission(granted)
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[desktopNotifications] failed to read Windows notification permission:', err)
    }
    return 'unsupported'
  }
}

async function invokeWindowsNotificationPermissionRequest(): Promise<DesktopNotificationPermission | null> {
  if (detectPlatform() !== 'win32') return null

  try {
    const permission = await getDesktopHost().commands.invoke<PluginPermissionState>('plugin:notification|request_permission')
    return normalizePermission(permission)
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[desktopNotifications] failed to request Windows notification permission:', err)
    }
    return 'unsupported'
  }
}

async function invokeMacNotificationPermissionState(): Promise<DesktopNotificationPermission | null> {
  if (detectPlatform() !== 'darwin') return null

  try {
    const permission = await getDesktopHost().commands.invoke<DesktopNotificationPermission>('macos_notification_permission_state')
    return ['default', 'denied', 'granted', 'unsupported'].includes(permission) ? permission : 'unsupported'
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[desktopNotifications] failed to read macOS notification permission:', err)
    }
    return 'unsupported'
  }
}

async function invokeMacNotificationPermissionRequest(): Promise<DesktopNotificationPermission | null> {
  if (detectPlatform() !== 'darwin') return null

  try {
    const permission = await getDesktopHost().commands.invoke<DesktopNotificationPermission>('macos_request_notification_permission')
    return ['default', 'denied', 'granted', 'unsupported'].includes(permission) ? permission : 'unsupported'
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[desktopNotifications] failed to request macOS notification permission:', err)
    }
    return 'unsupported'
  }
}

function isNotificationTarget(value: unknown): value is DesktopNotificationTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as Partial<DesktopNotificationTarget>
  if (target.type === 'scheduled') return true
  if (target.type === 'session') {
    return typeof target.sessionId === 'string' && target.sessionId.length > 0 &&
      (target.title === undefined || typeof target.title === 'string')
  }
  return false
}

function parseTargetJson(value: unknown): DesktopNotificationTarget | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return isNotificationTarget(parsed) ? parsed : null
  } catch {
    return null
  }
}

function notificationTargetFromPayload(payload: unknown): DesktopNotificationTarget | null {
  if (isNotificationTarget(payload)) return payload
  const jsonTarget = parseTargetJson(payload)
  if (jsonTarget) return jsonTarget

  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>

  const directTarget = notificationTargetFromPayload(record.target)
  if (directTarget) return directTarget

  const eventPayloadTarget = notificationTargetFromPayload(record.payload)
  if (eventPayloadTarget) return eventPayloadTarget

  const extra = record.extra && typeof record.extra === 'object'
    ? record.extra as Record<string, unknown>
    : null
  const extraTarget = extra ? notificationTargetFromPayload(extra[TARGET_EXTRA_KEY]) : null
  if (extraTarget) return extraTarget

  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : null
  const dataTarget = data ? notificationTargetFromPayload(data[TARGET_EXTRA_KEY]) : null
  if (dataTarget) return dataTarget

  const id = typeof record.id === 'number' ? record.id : null
  return id !== null ? notificationTargetById.get(id) ?? null : null
}

function buildNativeNotificationPayload(options: {
  title: string
  body?: string
  target?: DesktopNotificationTarget
}): NativeNotificationPayload {
  const payload: NativeNotificationPayload = {
    title: options.title,
    body: options.body,
  }

  if (options.target) {
    const id = nextNotificationId++
    notificationTargetById.set(id, options.target)
    payload.id = id
    payload.extra = { [TARGET_EXTRA_KEY]: JSON.stringify(options.target) }
    payload.target = options.target
  }

  return payload
}

async function sendMacNotification(options: { title: string; body?: string; target?: DesktopNotificationTarget }): Promise<boolean | null> {
  if (detectPlatform() !== 'darwin') return null

  try {
    const target = options.target ? JSON.stringify(options.target) : undefined
    const sent = await getDesktopHost().commands.invoke<boolean>('macos_send_notification', {
      title: options.title,
      body: options.body,
      ...(target ? { target } : {}),
    })
    return typeof sent === 'boolean' ? sent : false
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[desktopNotifications] failed to send macOS native notification:', err)
    }
    return false
  }
}

export async function getDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  const macPermission = await invokeMacNotificationPermissionState()
  if (macPermission) return macPermission

  const windowsPermission = await invokeWindowsNotificationPermissionState()
  if (windowsPermission) return windowsPermission

  try {
    const permission = await getDesktopHost().notifications.permissionState()
    if (permission === 'granted') return 'granted'
  } catch {
    // Fall back to the Web Notification permission state below.
  }
  return readBrowserNotificationPermission()
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  const macPermission = await invokeMacNotificationPermissionRequest()
  if (macPermission) return macPermission

  const windowsPermission = await invokeWindowsNotificationPermissionRequest()
  if (windowsPermission) return windowsPermission

  try {
    return await getDesktopHost().notifications.requestPermission()
  } catch {
    return readBrowserNotificationPermission()
  }
}

export async function openDesktopNotificationSettings(): Promise<boolean> {
  const url = getNotificationSettingsUrl()
  if (!url) return false

  const platform = detectPlatform()
  if (platform === 'darwin') {
    try {
      const opened = await getDesktopHost().commands.invoke<boolean>('macos_open_notification_settings')
      if (opened) return true
    } catch {
      // Fall back to shell.open/window.open below.
    }
  }

  if (platform === 'win32') {
    try {
      const opened = await getDesktopHost().commands.invoke<boolean>('open_windows_notification_settings')
      if (opened) return true
    } catch {
      // Fall back to shell.open/window.open below.
    }
  }

  try {
    await getDesktopHost().shell.open(url)
    return true
  } catch {
    try {
      window.open(url, '_blank', 'noopener,noreferrer')
      return true
    } catch {
      return false
    }
  }
}

async function sendNativeNotification(options: { title: string; body?: string; target?: DesktopNotificationTarget }): Promise<boolean> {
  const macSent = await sendMacNotification(options)
  if (macSent !== null) return macSent

  const windowsPermission = await invokeWindowsNotificationPermissionState()
  const permissionGranted = windowsPermission
    ? windowsPermission === 'granted'
    : await getDesktopHost().notifications.permissionState() === 'granted'
  if (!permissionGranted) {
    return false
  }

  const payload = buildNativeNotificationPayload(options)
  await getDesktopHost().notifications.send(payload)
  return true
}

async function requestWindowAttention(): Promise<boolean> {
  try {
    await getDesktopHost().window.requestAttention()
    return true
  } catch {
    return false
  }
}

async function focusCurrentWindow(): Promise<void> {
  try {
    await getDesktopHost().window.focus()
  } catch {
    // Best effort only: the notification target can still be opened in the UI.
  }
}

export async function installDesktopNotificationClickListener(
  onTarget: (target: DesktopNotificationTarget) => void,
): Promise<() => void> {
  const cleanups: Array<() => void> = []
  const handlePayload = (payload: unknown) => {
    const target = notificationTargetFromPayload(payload)
    if (!target) return
    void focusCurrentWindow()
    onTarget(target)
    void getDesktopHost().notifications.ackAction({ target, payload }).catch(() => {})
  }

  try {
    const unlisten = await getDesktopHost().events.listen<unknown>('desktop-notification-clicked', handlePayload)
    cleanups.push(unlisten)
  } catch {
    // Non-Tauri browser tests and unsupported runtimes do not expose native events.
  }

  try {
    const unlisten = await getDesktopHost().notifications.onAction(handlePayload)
    cleanups.push(unlisten)
  } catch {
    // The desktop plugin does not expose click actions on every platform.
  }

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  }
}

export async function notifyDesktop(options: DesktopNotificationOptions): Promise<boolean> {
  if (!useSettingsStore.getState().desktopNotificationsEnabled) {
    return false
  }

  if (options.dedupeKey && (notifiedKeys.has(options.dedupeKey) || pendingKeys.has(options.dedupeKey))) {
    return false
  }

  const cooldownScope = options.cooldownScope
  if (cooldownScope) {
    const now = Date.now()
    const lastNotificationAt = lastNotificationAtByScope.get(cooldownScope) ?? 0
    if (pendingCooldownScopes.has(cooldownScope) || now - lastNotificationAt < (options.cooldownMs ?? DEFAULT_COOLDOWN_MS)) {
      return false
    }
    pendingCooldownScopes.add(cooldownScope)
  }

  if (options.dedupeKey) {
    pendingKeys.add(options.dedupeKey)
  }

  if (options.requestAttention) {
    void requestWindowAttention()
  }

  const sender = overrideNativeNotificationSender ?? sendNativeNotification
  try {
    const sent = await Promise.resolve(sender({
      title: options.title,
      body: options.body,
      ...(options.target ? { target: options.target } : {}),
    }))
    if (options.dedupeKey) {
      pendingKeys.delete(options.dedupeKey)
      if (sent) notifiedKeys.add(options.dedupeKey)
    }
    if (sent && cooldownScope) {
      lastNotificationAtByScope.set(cooldownScope, Date.now())
    }
    if (cooldownScope) pendingCooldownScopes.delete(cooldownScope)
    if (!sent && typeof console !== 'undefined') {
      console.warn('[desktopNotifications] native notification permission was not granted')
    }
    return sent
  } catch (err) {
    if (options.dedupeKey) pendingKeys.delete(options.dedupeKey)
    if (cooldownScope) pendingCooldownScopes.delete(cooldownScope)
    if (typeof console !== 'undefined') {
      console.warn('[desktopNotifications] failed to send native notification:', err)
    }
    return false
  }
}

export function resetDesktopNotificationsForTests(): void {
  notifiedKeys.clear()
  pendingKeys.clear()
  lastNotificationAtByScope.clear()
  pendingCooldownScopes.clear()
  notificationTargetById.clear()
  overrideNativeNotificationSender = null
  nextNotificationId = 1
}

export function setNativeNotificationSenderForTests(sender: NativeNotificationSender | null): void {
  overrideNativeNotificationSender = sender
}
