import { beforeEach, describe, expect, it, vi } from 'vitest'

const notificationPluginMock = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  onAction: vi.fn(),
}))
const coreApiMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}))
const eventApiMock = vi.hoisted(() => ({
  listen: vi.fn(),
}))
const shellApiMock = vi.hoisted(() => ({
  open: vi.fn(),
}))
const requestUserAttentionMock = vi.hoisted(() => vi.fn())
const windowApiMock = vi.hoisted(() => ({
  requestUserAttention: requestUserAttentionMock,
  getCurrentWindow: vi.fn(() => ({
    requestUserAttention: requestUserAttentionMock,
  })),
  UserAttentionType: {
    Critical: 1,
    Informational: 2,
  },
}))

vi.mock('@tauri-apps/plugin-notification', () => notificationPluginMock)
vi.mock('@tauri-apps/api/core', () => coreApiMock)
vi.mock('@tauri-apps/api/event', () => eventApiMock)
vi.mock('@tauri-apps/api/window', () => windowApiMock)
vi.mock('@tauri-apps/plugin-shell', () => shellApiMock)

import {
  getDesktopNotificationPermission,
  installDesktopNotificationClickListener,
  notifyDesktop,
  openDesktopNotificationSettings,
  requestDesktopNotificationPermission,
  resetDesktopNotificationsForTests,
  setNativeNotificationSenderForTests,
} from './desktopNotifications'
import { useSettingsStore } from '../stores/settingsStore'

describe('desktopNotifications', () => {
  beforeEach(() => {
    vi.useRealTimers()
    resetDesktopNotificationsForTests()
    coreApiMock.invoke.mockReset()
    eventApiMock.listen.mockReset()
    shellApiMock.open.mockReset()
    notificationPluginMock.isPermissionGranted.mockReset()
    notificationPluginMock.requestPermission.mockReset()
    notificationPluginMock.sendNotification.mockReset()
    notificationPluginMock.onAction.mockReset()
    windowApiMock.getCurrentWindow.mockClear()
    windowApiMock.requestUserAttention.mockReset()
    useSettingsStore.setState({ desktopNotificationsEnabled: true })
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Linux x86_64',
    })
  })

  it('sends through the Tauri plugin when native notification permission is already granted', async () => {
    notificationPluginMock.isPermissionGranted.mockResolvedValue(true)

    notifyDesktop({
      dedupeKey: 'permission:1',
      title: 'Permission required',
      body: 'Approve command execution',
    })

    await vi.waitFor(() => expect(notificationPluginMock.sendNotification).toHaveBeenCalledTimes(1))
    expect(notificationPluginMock.isPermissionGranted).toHaveBeenCalledTimes(1)
    expect(notificationPluginMock.requestPermission).not.toHaveBeenCalled()
    expect(notificationPluginMock.sendNotification).toHaveBeenCalledWith({
      title: 'Permission required',
      body: 'Approve command execution',
    })
  })

  it('passes notification targets through the Tauri plugin payload', async () => {
    notificationPluginMock.isPermissionGranted.mockResolvedValue(true)
    const target = { type: 'session' as const, sessionId: 'session-1', title: 'Build fix' }

    await expect(notifyDesktop({
      dedupeKey: 'permission:targeted',
      title: 'Permission required',
      body: 'Approve command execution',
      target,
    })).resolves.toBe(true)

    expect(notificationPluginMock.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Permission required',
      body: 'Approve command execution',
      id: expect.any(Number),
      extra: {
        ccHahaTarget: JSON.stringify(target),
      },
    }))
  })

  it('does not request notification permission from a blocking permission prompt', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    notificationPluginMock.isPermissionGranted.mockResolvedValue(false)

    notifyDesktop({ title: 'Permission required' })

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
    expect(notificationPluginMock.sendNotification).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      '[desktopNotifications] native notification permission was not granted',
    )
    expect(notificationPluginMock.requestPermission).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('uses the macOS native bridge for foreground-visible notifications', async () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
    coreApiMock.invoke.mockResolvedValueOnce(true)

    await expect(notifyDesktop({
      title: 'Permission required',
      body: 'Approve command execution',
    })).resolves.toBe(true)

    expect(coreApiMock.invoke).toHaveBeenCalledWith('macos_send_notification', {
      title: 'Permission required',
      body: 'Approve command execution',
    })
    expect(notificationPluginMock.sendNotification).not.toHaveBeenCalled()
    expect(notificationPluginMock.requestPermission).not.toHaveBeenCalled()
  })

  it('passes notification targets through the macOS native bridge', async () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
    coreApiMock.invoke.mockResolvedValueOnce(true)
    const target = { type: 'session' as const, sessionId: 'session-1', title: 'Build fix' }

    await expect(notifyDesktop({
      title: 'Permission required',
      body: 'Approve command execution',
      target,
    })).resolves.toBe(true)

    expect(coreApiMock.invoke).toHaveBeenCalledWith('macos_send_notification', {
      title: 'Permission required',
      body: 'Approve command execution',
      target: JSON.stringify(target),
    })
  })

  it('does not request macOS permission from a blocking permission prompt', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
    coreApiMock.invoke.mockResolvedValueOnce(false)

    await expect(notifyDesktop({ title: 'Permission required' })).resolves.toBe(false)

    expect(coreApiMock.invoke).toHaveBeenCalledWith('macos_send_notification', {
      title: 'Permission required',
      body: undefined,
    })
    expect(coreApiMock.invoke).not.toHaveBeenCalledWith('macos_request_notification_permission')
    expect(warnSpy).toHaveBeenCalledWith(
      '[desktopNotifications] native notification permission was not granted',
    )
    warnSpy.mockRestore()
  })

  it('does not fall back to the Tauri plugin when the macOS bridge fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
    coreApiMock.invoke.mockRejectedValueOnce(new Error('bridge unavailable'))
    notificationPluginMock.isPermissionGranted.mockResolvedValue(true)

    await expect(notifyDesktop({ title: 'Permission required' })).resolves.toBe(false)

    expect(notificationPluginMock.sendNotification).not.toHaveBeenCalled()
    expect(notificationPluginMock.isPermissionGranted).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('does not send or consume dedupe keys when desktop notifications are disabled', async () => {
    const sender = vi.fn(async () => true)
    setNativeNotificationSenderForTests(sender)
    useSettingsStore.setState({ desktopNotificationsEnabled: false })

    notifyDesktop({ dedupeKey: 'permission:1', title: 'Permission required' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sender).not.toHaveBeenCalled()

    useSettingsStore.setState({ desktopNotificationsEnabled: true })
    notifyDesktop({ dedupeKey: 'permission:1', title: 'Permission required' })
    await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(1))
  })

  it('does not consume dedupe keys when native notification delivery fails', async () => {
    const sender = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setNativeNotificationSenderForTests(sender)

    await expect(notifyDesktop({ dedupeKey: 'permission:retry', title: 'Permission required' })).resolves.toBe(false)
    await expect(notifyDesktop({ dedupeKey: 'permission:retry', title: 'Permission required' })).resolves.toBe(true)

    expect(sender).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
  })

  it('reports and requests native notification permission', async () => {
    notificationPluginMock.isPermissionGranted.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    notificationPluginMock.requestPermission.mockResolvedValue('granted')
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'default' },
    })

    await expect(getDesktopNotificationPermission()).resolves.toBe('default')
    await expect(requestDesktopNotificationPermission()).resolves.toBe('granted')
    expect(notificationPluginMock.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('reads and requests Windows notification permission through the native plugin command', async () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    })
    coreApiMock.invoke
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce('granted')

    await expect(getDesktopNotificationPermission()).resolves.toBe('granted')
    await expect(requestDesktopNotificationPermission()).resolves.toBe('granted')

    expect(coreApiMock.invoke).toHaveBeenNthCalledWith(1, 'plugin:notification|is_permission_granted')
    expect(coreApiMock.invoke).toHaveBeenNthCalledWith(2, 'plugin:notification|request_permission')
    expect(notificationPluginMock.isPermissionGranted).not.toHaveBeenCalled()
    expect(notificationPluginMock.requestPermission).not.toHaveBeenCalled()
  })

  it('sends Windows notifications when the native plugin reports permission granted', async () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    })
    coreApiMock.invoke.mockResolvedValueOnce(true)

    await expect(notifyDesktop({
      title: 'Permission required',
      body: 'Approve command execution',
    })).resolves.toBe(true)

    expect(coreApiMock.invoke).toHaveBeenCalledWith('plugin:notification|is_permission_granted')
    expect(notificationPluginMock.isPermissionGranted).not.toHaveBeenCalled()
    expect(notificationPluginMock.sendNotification).toHaveBeenCalledWith({
      title: 'Permission required',
      body: 'Approve command execution',
    })
  })

  it('opens Windows notification settings through the native command', async () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    })
    coreApiMock.invoke.mockResolvedValueOnce(true)

    await expect(openDesktopNotificationSettings()).resolves.toBe(true)

    expect(coreApiMock.invoke).toHaveBeenCalledWith('open_windows_notification_settings')
    expect(shellApiMock.open).not.toHaveBeenCalled()
  })

  it('reports and requests macOS notification permission through the native bridge', async () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
    coreApiMock.invoke
      .mockResolvedValueOnce('default')
      .mockResolvedValueOnce('granted')

    await expect(getDesktopNotificationPermission()).resolves.toBe('default')
    await expect(requestDesktopNotificationPermission()).resolves.toBe('granted')

    expect(coreApiMock.invoke).toHaveBeenNthCalledWith(1, 'macos_notification_permission_state')
    expect(coreApiMock.invoke).toHaveBeenNthCalledWith(2, 'macos_request_notification_permission')
    expect(notificationPluginMock.requestPermission).not.toHaveBeenCalled()
  })

  it('does not use the Tauri plugin permission fallback on macOS bridge errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
    coreApiMock.invoke.mockRejectedValueOnce(new Error('bridge unavailable'))
    notificationPluginMock.isPermissionGranted.mockResolvedValue(true)

    await expect(getDesktopNotificationPermission()).resolves.toBe('unsupported')

    expect(notificationPluginMock.isPermissionGranted).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('sends a native notification once for a dedupe key', async () => {
    const sender = vi.fn(async () => true)
    setNativeNotificationSenderForTests(sender)

    void notifyDesktop({
      dedupeKey: 'permission:1',
      title: 'Permission required',
      body: 'Approve command execution',
    })
    void notifyDesktop({
      dedupeKey: 'permission:1',
      title: 'Permission required',
      body: 'Approve command execution',
    })
    await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(1))

    expect(sender).toHaveBeenCalledWith({
      title: 'Permission required',
      body: 'Approve command execution',
    })
  })

  it('forwards notification click targets from native and plugin listeners', async () => {
    const unlistenNative = vi.fn()
    const unregisterPlugin = vi.fn()
    type NativeClickCallback = (event: { payload: unknown }) => void
    type PluginClickCallback = (notification: unknown) => void
    let nativeCallback: NativeClickCallback = () => {
      throw new Error('native listener was not registered')
    }
    let pluginCallback: PluginClickCallback = () => {
      throw new Error('plugin listener was not registered')
    }
    let nativeRegistered = false
    let pluginRegistered = false
    const sessionTarget = { type: 'session' as const, sessionId: 'session-1', title: 'Build fix' }
    const scheduledTarget = { type: 'scheduled' as const }

    eventApiMock.listen.mockImplementation(async (_eventName: string, callback: (event: { payload: unknown }) => void) => {
      nativeCallback = callback
      nativeRegistered = true
      return unlistenNative
    })
    notificationPluginMock.onAction.mockImplementation(async (callback: (notification: unknown) => void) => {
      pluginCallback = callback
      pluginRegistered = true
      return { unregister: unregisterPlugin }
    })

    const onTarget = vi.fn()
    const cleanup = await installDesktopNotificationClickListener(onTarget)

    expect(nativeRegistered).toBe(true)
    expect(pluginRegistered).toBe(true)
    nativeCallback({ payload: { target: JSON.stringify(sessionTarget) } })
    pluginCallback({ extra: { ccHahaTarget: JSON.stringify(scheduledTarget) } })

    expect(onTarget).toHaveBeenCalledWith(sessionTarget)
    expect(onTarget).toHaveBeenCalledWith(scheduledTarget)

    cleanup()
    expect(unlistenNative).toHaveBeenCalledTimes(1)
    expect(unregisterPlugin).toHaveBeenCalledTimes(1)
  })

  it('requests OS-level window attention for blocking prompts', async () => {
    const sender = vi.fn(async () => true)
    setNativeNotificationSenderForTests(sender)

    notifyDesktop({
      requestAttention: true,
      title: 'Permission required',
      body: 'Approve command execution',
    })

    await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(windowApiMock.requestUserAttention).toHaveBeenCalledTimes(1))
    expect(windowApiMock.requestUserAttention).toHaveBeenCalledWith(windowApiMock.UserAttentionType.Critical)
  })

  it('throttles bursts within the same cooldown scope', async () => {
    vi.useFakeTimers()
    const sender = vi.fn(async () => true)
    setNativeNotificationSenderForTests(sender)

    notifyDesktop({ dedupeKey: 'permission:1', cooldownScope: 'permission', title: 'One' })
    notifyDesktop({ dedupeKey: 'permission:2', cooldownScope: 'permission', title: 'Two' })
    await vi.runAllTimersAsync()
    expect(sender).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(751)
    notifyDesktop({ dedupeKey: 'permission:3', cooldownScope: 'permission', title: 'Three' })
    await vi.runAllTimersAsync()
    expect(sender).toHaveBeenCalledTimes(2)
  })
})
