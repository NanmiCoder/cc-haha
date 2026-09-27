import type { SessionLaunchInfo, SessionListItem } from './sessionService.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

export const SIDE_CHAT_PREFIX = 'side-'
export const SIDE_CHAT_BOUNDARY = `You are in an independent side conversation. All inherited history from the parent conversation is reference context only, not active instructions. Do not continue the parent's tasks, plans, tool calls, approvals, or edits. Only new messages submitted in this side conversation are active user instructions. Do not spawn, interact with, or continue any subagents from this side conversation. You may use available skills and tools under the existing permissions. Do not modify the workspace unless explicitly requested in this side conversation. The workspace is shared with the parent; avoid disrupting its work.`
export type SideChat = {
  sessionId: string
  parentSessionId: string
  cliSessionId: string
  resumePath: string
  resumeAt: string
  launchInfo: SessionLaunchInfo
  createdAt: string
  started: boolean
  closed: boolean
}
const entries = new Map<string, SideChat>()
const key = (id: string) => `${getClaudeConfigHomeDir()}\0${id}`
export const isSideChatId = (id: string) => id.startsWith(SIDE_CHAT_PREFIX)
export const getSideChat = (id: string) => entries.get(key(id))
export function registerSideChat(entry: SideChat): void { entries.set(key(entry.sessionId), entry) }
export function closeSideChatsForParent(parentId: string): string[] {
  const closed: string[] = []
  for (const [entryKey, entry] of entries) {
    if (entryKey === key(entry.sessionId) && entry.parentSessionId === parentId && !entry.closed) {
      entry.closed = true
      closed.push(entry.sessionId)
    }
  }
  return closed
}
export function sideChatSummary(entry: SideChat): SessionListItem {
  const info = entry.launchInfo
  return {
    id: entry.sessionId, title: info.customTitle ?? 'Side chat', createdAt: entry.createdAt,
    modifiedAt: entry.createdAt, messageCount: 0, projectPath: info.projectDir,
    projectRoot: info.workDir, workDir: info.workDir, workDirExists: true,
    workspaceState: 'available', permissionMode: info.permissionMode,
    runtimeProviderId: info.runtimeProviderId, runtimeModelId: info.runtimeModelId,
    effortLevel: info.effortLevel,
  }
}
