import type { ApiClient } from './client'
import { mergeComposerReferences, type ComposerReference } from './composerReferences'

/** An explicit per-message request, separate from the computer's global grant. */
export const computerUseReference: ComposerReference = {
  kind: 'skill',
  id: 'computer-use',
  name: 'computer-use',
  displayName: '操作电脑',
  description: '这条消息使用操作电脑',
  source: 'bundled',
  modelText: 'Use the Skill tool with skill: "computer-use" for this request.',
}

export function isComputerUseReference(reference: Pick<ComposerReference, 'kind' | 'id'>) {
  return reference.kind === 'skill' && reference.id === computerUseReference.id
}

export function withComputerUseReference(references: ComposerReference[], selected: boolean) {
  return selected
    ? mergeComposerReferences(references, [{ ...computerUseReference }])
    : references.filter((reference) => !isComputerUseReference(reference))
}

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
