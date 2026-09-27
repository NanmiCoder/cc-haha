import { getSideChatParentSessionId } from '@/lib/sideChatSessions'
import { useSideChatStore } from '@/stores/sideChatStore'
import { useUIStore } from '@/stores/uiStore'
import { workspaceOpen } from '@/lib/workspace/openTarget'

/** Shared entry point for selected text, /btw and workspace navigation. */
export async function openSideChat(parentSessionId: string, options?: Parameters<ReturnType<typeof useSideChatStore.getState>['open']>[1]): Promise<string | null> {
  try {
    parentSessionId = getSideChatParentSessionId(parentSessionId) ?? parentSessionId
    const sideChatId = await useSideChatStore.getState().open(parentSessionId, options)
    const tabId = workspaceOpen.sideChat(parentSessionId, sideChatId)
    if (!tabId) await useSideChatStore.getState().close(sideChatId)
    return tabId
  } catch (error) {
    useUIStore.getState().addToast({ message: error instanceof Error ? error.message : String(error), type: 'error' })
    return null
  }
}
