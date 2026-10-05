import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSideChatStore } from '../../stores/sideChatStore'
import { useTabStore } from '../../stores/tabStore'
import type { PermissionMode } from '../../types/settings'

/**
 * The mode a composer is running under: the explicit value when controlled,
 * else the live session's, then the saved session's, the side chat's, and the
 * global default. The selector and the phone's composer sheet both read it
 * here so they cannot disagree.
 */
export function useResolvedPermissionMode(sessionId?: string, value?: PermissionMode): PermissionMode {
  const storeMode = useSettingsStore((s) => s.permissionMode)
  const selectedTabId = useTabStore((s) => s.activeTabId)
  const activeTabId = sessionId ?? selectedTabId
  const livePermissionMode = useChatStore((s) => activeTabId ? s.sessions[activeTabId]?.permissionMode : undefined)
  const sideChatMode = useSideChatStore((s) => activeTabId ? s.entries[activeTabId]?.permissionMode : undefined)
  const savedMode = useSessionStore((s) => (
    activeTabId ? s.sessions.find((session) => session.id === activeTabId)?.permissionMode : undefined
  )) as PermissionMode | undefined
  if (value !== undefined) return value
  return livePermissionMode || savedMode || sideChatMode || storeMode
}

export const PERMISSION_MODE_LABEL_KEYS = {
  default: 'permMode.label.default',
  acceptEdits: 'permMode.label.acceptEdits',
  auto: 'permMode.label.auto',
  plan: 'permMode.label.plan',
  bypassPermissions: 'permMode.label.bypassPermissions',
  dontAsk: 'permMode.label.dontAsk',
} as const satisfies Record<PermissionMode, string>
