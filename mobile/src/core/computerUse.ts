import type { ApiClient } from './client'
export type ComposerComputerUse = {
  supported: boolean
  engine?: string
  permissions?: { accessibility: boolean; screenRecording: boolean }
  enabled: boolean
}
export const computerUseEnableRequest = {
  enabled: true,
  grantFlags: { clipboardRead: true, clipboardWrite: true, systemKeyCombos: true },
}
export async function loadComposerComputerUse(client: ApiClient, signal: AbortSignal): Promise<ComposerComputerUse> {
  const [status, config] = await Promise.all([
    client.get<Omit<ComposerComputerUse, 'enabled'>>('/api/computer-use/status', { signal }),
    client.get<{ enabled: boolean }>('/api/computer-use/authorized-apps', { signal }),
  ])
  return { ...status, enabled: config.enabled }
}
export async function setComposerComputerUse(client: ApiClient, enabled: boolean) {
  await client.request('/api/computer-use/authorized-apps', {
    method: 'PUT', body: enabled ? computerUseEnableRequest : { enabled: false },
  })
}
export function needsComputerPermission(value: ComposerComputerUse) {
  return value.engine === 'macos-native' &&
    (value.permissions?.accessibility === false || value.permissions?.screenRecording === false)
}

/** The native permission card waits for the user on the computer before it returns. */
export async function openComputerPermissionCard(client: ApiClient, signal: AbortSignal) {
  await client.request('/api/computer-use/open-permission-card', { method: 'POST', timeoutMs: 600000, signal })
  return loadComposerComputerUse(client, signal)
}
